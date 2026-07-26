import { randomBytes } from 'node:crypto';

import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { ShareLink, ShareLinkType } from './entities/share-link.entity';

export interface CreateShareLinkInput {
  trainerProfileId: string;
  type: ShareLinkType;
  createdByUserId: string;
  targetEmail?: string | null;
  expiresAt?: Date | null;
  maxUses?: number | null;
}

@Injectable()
export class ShareLinksService {
  constructor(
    @InjectRepository(ShareLink)
    private readonly links: Repository<ShareLink>,
    private readonly clock: ClockService,
  ) {}

  private repo(manager?: EntityManager): Repository<ShareLink> {
    return manager !== undefined ? manager.getRepository(ShareLink) : this.links;
  }

  private generateCode(): string {
    // URL-safe, ~13 chars; collisions are caught by the unique index.
    return randomBytes(9).toString('base64url');
  }

  async create(input: CreateShareLinkInput, manager?: EntityManager): Promise<ShareLink> {
    const repository = this.repo(manager);
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
    return this.repo(manager).findOne({ where: { id } });
  }

  /**
   * Retire a link without deleting it, so an accepted or revoked invitation
   * keeps showing up in the trainer's invitation list with the right status.
   */
  async deactivate(id: string, manager?: EntityManager): Promise<void> {
    await this.repo(manager).update({ id }, { active: false });
  }

  async findByTrainer(trainerProfileId: string): Promise<ShareLink[]> {
    return this.links.find({
      where: { trainerProfileId },
      order: { createdAt: 'DESC' },
    });
  }

  async findByCode(code: string, manager?: EntityManager): Promise<ShareLink | null> {
    return this.repo(manager).findOne({ where: { code } });
  }

  /**
   * Resolve, validate and lock a share link for redemption, inside the caller's
   * transaction.
   *
   * `expectedType` is required rather than optional: player joins and coach
   * invite acceptance redeem out of the same table, and the player-side paths
   * used to skip the type check entirely — so a stranger could spend a
   * trainer's single-use, 7-day coach invite by registering as a player,
   * burning the invite and joining the org.
   *
   * The pessimistic write lock is what makes single-use actually single use.
   * Validating and then incrementing in two statements is a check-then-act
   * race: two concurrent redemptions of a maxUses=1 link both read
   * useCount = 0 and both succeed. Holding the row until the transaction
   * commits serialises them, so the second sees the incremented count.
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

  private assertUsable(link: ShareLink | null, expectedType: ShareLinkType): ShareLink {
    // A code of the wrong kind is reported as simply invalid, so this does not
    // become an oracle for probing which codes are coach invites.
    if (!link || !link.active || link.type !== expectedType) {
      throw new NotFoundException({
        errorCode: ErrorCode.SHARE_LINK_INVALID,
        message: 'This invite link is invalid.',
      });
    }
    if (link.expiresAt !== null && link.expiresAt.getTime() < this.clock.now().getTime()) {
      throw new GoneException({
        errorCode: ErrorCode.SHARE_LINK_EXPIRED,
        message: 'This invite link has expired.',
      });
    }
    if (link.maxUses !== null && link.useCount >= link.maxUses) {
      throw new GoneException({
        errorCode: ErrorCode.SHARE_LINK_EXPIRED,
        message: 'This invite link has already been used.',
      });
    }
    return link;
  }

  async incrementUse(id: string, manager?: EntityManager): Promise<void> {
    await this.repo(manager)
      .createQueryBuilder()
      .update(ShareLink)
      .set({ useCount: () => '"use_count" + 1' })
      .where('id = :id', { id })
      .execute();
  }

  /**
   * Erase a person's address from any coach invitation still holding it, and
   * retire the link (US-01.13).
   *
   * `target_email` is the one place a coach's email is copied out of `users`,
   * so an erasure that only anonymised the account left the address sitting in
   * this table — reachable by the trainer's invitation list. Deactivating as
   * well as nulling matters: a pending invite whose recipient no longer exists
   * must not stay redeemable, and an invite with no address cannot be resent.
   *
   * Matched case-insensitively because `users.email` is citext while this
   * column is plain text, so the stored copy need not match byte-for-byte.
   */
  async scrubTargetEmail(email: string, manager?: EntityManager): Promise<void> {
    await this.repo(manager)
      .createQueryBuilder()
      .update(ShareLink)
      .set({ targetEmail: null, active: false })
      .where('LOWER("target_email") = LOWER(:email)', { email })
      .execute();
  }
}
