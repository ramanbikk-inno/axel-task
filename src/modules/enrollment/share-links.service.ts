import { randomBytes } from 'node:crypto';

import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { repoFor } from '../../shared/database/repo-for';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { Principal } from '../auth/principal';
import { TrainersService } from '../trainers/trainers.service';
import { ShareLink, ShareLinkType } from './entities/share-link.entity';

export interface CreateShareLinkInput {
  trainerProfileId: string;
  type: ShareLinkType;
  createdByUserId: string;
  targetEmail?: string | null;
  expiresAt?: Date | null;
  maxUses?: number | null;
}

export interface ResolvedShareLink {
  code: string;
  valid: boolean;
  trainer: { profileId: string; businessName: string } | null;
}

/** Why a ShareLink is not usable. See ShareLinksService.evaluate. */
export type ShareLinkRejection = 'not-found' | 'wrong-type' | 'revoked' | 'expired' | 'exhausted';

export type ShareLinkEvaluation =
  | { ok: true; link: ShareLink }
  | { ok: false; reason: ShareLinkRejection };

export const AUDIT_SHARE_LINK_CREATED = 'sharelink.created';

@Injectable()
export class ShareLinksService {
  constructor(
    @InjectRepository(ShareLink)
    private readonly links: Repository<ShareLink>,
    private readonly clock: ClockService,
    private readonly trainersService: TrainersService,
    private readonly audit: AuditService,
  ) {}

  private generateCode(): string {
    // URL-safe, ~13 chars; collisions are caught by the unique index.
    return randomBytes(9).toString('base64url');
  }

  async create(input: CreateShareLinkInput, manager?: EntityManager): Promise<ShareLink> {
    const repository = repoFor(this.links, ShareLink, manager);
    const link = repository.create({
      trainerProfileId: input.trainerProfileId,
      code: this.generateCode(),
      type: input.type,
      targetEmail: input.targetEmail ?? null,
      expiresAt: input.expiresAt ?? null,
      maxUses: input.maxUses ?? null,
      useCount: 0,
      active: true,
      createdByUserId: input.createdByUserId,
    });
    return repository.save(link);
  }

  async findById(id: string, manager?: EntityManager): Promise<ShareLink | null> {
    return repoFor(this.links, ShareLink, manager).findOne({ where: { id } });
  }

  /**
   * Retire a link without deleting it, so an accepted or revoked invitation
   * keeps showing up in the trainer's invitation list with the right status.
   */
  async deactivate(id: string, manager?: EntityManager): Promise<void> {
    await repoFor(this.links, ShareLink, manager).update({ id }, { active: false });
  }

  async findByTrainer(trainerProfileId: string): Promise<ShareLink[]> {
    return this.links.find({
      where: { trainerProfileId },
      order: { createdAt: 'DESC' },
    });
  }

  async findByCode(code: string, manager?: EntityManager): Promise<ShareLink | null> {
    return repoFor(this.links, ShareLink, manager).findOne({ where: { code } });
  }

  /**
   * Generate a static player ShareLink for the calling trainer.
   *
   * Player links only. Coach invites are single-use, 7-day and bound to a
   * target email, all of which this endpoint would leave unset — minting one
   * here produced a "coach invite" that never expires and never runs out.
   * They belong to POST /coaches/invitations.
   */
  async createForTrainer(principal: Principal): Promise<ShareLink> {
    const trainerProfile = await this.trainersService.requireOwnProfile(principal.userId);
    const link = await this.create({
      trainerProfileId: trainerProfile.id,
      type: ShareLinkType.PlayerStatic,
      createdByUserId: principal.userId,
    });
    await this.audit.record({
      action: AUDIT_SHARE_LINK_CREATED,
      actor: principal,
      target: { type: 'ShareLink', id: link.id },
      metadata: { linkType: ShareLinkType.PlayerStatic },
    });
    return link;
  }

  async listForTrainer(principal: Principal): Promise<ShareLink[]> {
    const trainerProfile = await this.trainersService.requireOwnProfile(principal.userId);
    return this.findByTrainer(trainerProfile.id);
  }

  /**
   * Public: resolve a ShareLink for the join page (trainer name + validity).
   *
   * An unknown code, a coach invite and a revoked link all resolve to nothing:
   * the join page must not preview one, let alone name the trainer behind it.
   * An expired or spent player link still names its trainer, so the page can
   * say who to ask for a fresh one.
   */
  async resolve(code: string): Promise<ResolvedShareLink> {
    const link = await this.findByCode(code);
    if (link === null) {
      return { code, valid: false, trainer: null };
    }
    const evaluation = this.evaluate(link, ShareLinkType.PlayerStatic);
    if (!evaluation.ok && evaluation.reason !== 'expired' && evaluation.reason !== 'exhausted') {
      return { code, valid: false, trainer: null };
    }
    const profile = await this.trainersService.findById(link.trainerProfileId);
    return {
      code,
      valid: evaluation.ok,
      trainer: profile ? { profileId: profile.id, businessName: profile.businessName } : null,
    };
  }

  /**
   * Resolve, validate and lock a share link for redemption inside the caller's
   * transaction.
   *
   * `expectedType` is required, not optional: player joins and coach invites
   * redeem from the same table, and skipping the check let a stranger burn a
   * coach invite by registering as a player. The write lock is what makes
   * single-use single use — validate-then-increment is a check-then-act race.
   */
  async lockForRedemption(
    code: string,
    expectedType: ShareLinkType,
    manager: EntityManager,
  ): Promise<ShareLink> {
    const link = await manager.getRepository(ShareLink).findOne({
      where: { code },
      lock: { mode: 'pessimistic_write' },
    });
    return this.assertUsable(link, expectedType);
  }

  /**
   * Non-locking validity check, for read-only preview endpoints. Never use this
   * to gate a redemption — see lockForRedemption.
   */
  async requireUsable(
    code: string,
    expectedType: ShareLinkType,
    manager?: EntityManager,
  ): Promise<ShareLink> {
    return this.assertUsable(await this.findByCode(code, manager), expectedType);
  }

  /**
   * Single source of truth for ShareLink usability. Do not reimplement the
   * active / expiry / use-limit / type conditions anywhere else — they drifted
   * apart across five copies once already.
   *
   * Non-throwing so status-reporting paths can read the reason; assertUsable
   * wraps it for the redemption paths. Reasons are checked in this precedence:
   * not-found, wrong-type, revoked, expired, exhausted.
   *
   * Boundaries are the strictest of the former copies: a link whose `expiresAt`
   * equals `now` is expired, and `useCount === maxUses` is exhausted.
   */
  evaluate(
    link: ShareLink | null,
    expectedType: ShareLinkType,
    now: Date = this.clock.now(),
  ): ShareLinkEvaluation {
    if (!link) {
      return { ok: false, reason: 'not-found' };
    }
    if (link.type !== expectedType) {
      return { ok: false, reason: 'wrong-type' };
    }
    if (!link.active) {
      return { ok: false, reason: 'revoked' };
    }
    if (link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: 'expired' };
    }
    if (link.maxUses !== null && link.useCount >= link.maxUses) {
      return { ok: false, reason: 'exhausted' };
    }
    return { ok: true, link };
  }

  private assertUsable(link: ShareLink | null, expectedType: ShareLinkType): ShareLink {
    const result = this.evaluate(link, expectedType);
    if (result.ok) {
      return result.link;
    }
    switch (result.reason) {
      case 'expired':
        throw new GoneException({
          errorCode: ErrorCode.SHARE_LINK_EXPIRED,
          message: 'This invite link has expired.',
        });
      case 'exhausted':
        throw new GoneException({
          errorCode: ErrorCode.SHARE_LINK_EXPIRED,
          message: 'This invite link has already been used.',
        });
      default:
        // A code of the wrong kind is reported as simply invalid, so this does
        // not become an oracle for probing which codes are coach invites.
        throw new NotFoundException({
          errorCode: ErrorCode.SHARE_LINK_INVALID,
          message: 'This invite link is invalid.',
        });
    }
  }

  async incrementUse(id: string, manager?: EntityManager): Promise<void> {
    await repoFor(this.links, ShareLink, manager)
      .createQueryBuilder()
      .update(ShareLink)
      .set({ useCount: () => '"use_count" + 1' })
      .where('id = :id', { id })
      .execute();
  }

  /**
   * Erase an address from any coach invitation holding it, and retire the link.
   * Deactivating as well as nulling matters: a pending invite whose recipient no
   * longer exists must not stay redeemable. Matched case-insensitively because
   * `users.email` is citext while this column is plain text.
   */
  async scrubTargetEmail(email: string, manager?: EntityManager): Promise<void> {
    await repoFor(this.links, ShareLink, manager)
      .createQueryBuilder()
      .update(ShareLink)
      .set({ targetEmail: null, active: false })
      .where('LOWER("target_email") = LOWER(:email)', { email })
      .execute();
  }
}
