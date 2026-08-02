import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { PasswordService } from '../../shared/crypto/password.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { ShareLink, ShareLinkType } from '../enrollment/entities/share-link.entity';
import { ShareLinksService } from '../enrollment/share-links.service';
import { MailService } from '../mail/mail.service';
import { TrainersService } from '../trainers/trainers.service';
import { User } from '../users/entities/user.entity';
import { Role } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import {
  AUDIT_COACH_INVITE_RESENT,
  AUDIT_COACH_INVITE_REVOKED,
  AUDIT_COACH_INVITED,
} from './coach-audit-actions';
import { CoachProfileService } from './coach-profile.service';
import {
  AcceptCoachInviteDto,
  CoachInvitationStatus,
  CoachInvitationView,
  InviteCoachDto,
  ResolvedCoachInviteView,
} from './dto/coach.dto';

/** Unique coach invites expire after 7 days and are single-use. */
const COACH_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The coach invitation lifecycle: mint, list, resend, revoke, preview, accept.
 * Owns the ShareLink side and the account provisioning on accept; the
 * `coach_profiles` writes belong to CoachProfileService.
 */
@Injectable()
export class CoachInvitationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly trainersService: TrainersService,
    private readonly coachProfiles: CoachProfileService,
    private readonly shareLinks: ShareLinksService,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly clock: ClockService,
    private readonly passwords: PasswordService,
  ) {}

  async invite(principal: Principal, dto: InviteCoachDto): Promise<CoachInvitationView> {
    const trainer = await this.trainersService.requireOwnProfile(principal.userId);

    const link = await this.shareLinks.create({
      trainerProfileId: trainer.id,
      type: ShareLinkType.CoachUnique,
      createdByUserId: principal.userId,
      targetEmail: dto.email,
      targetName: dto.name ?? null,
      expiresAt: new Date(this.clock.now().getTime() + COACH_INVITE_TTL_MS),
      maxUses: 1,
    });

    await this.mail.sendCoachInviteEmail(dto.email, trainer.businessName, link.code, dto.message);
    await this.audit.record({
      action: AUDIT_COACH_INVITED,
      actor: principal,
      target: { type: 'ShareLink', id: link.id },
      metadata: { email: dto.email },
    });
    return this.toInvitationView(link);
  }

  async listInvitations(principal: Principal): Promise<CoachInvitationView[]> {
    const trainer = await this.trainersService.requireOwnProfile(principal.userId);
    const links = (await this.shareLinks.findByTrainer(trainer.id)).filter(
      (l) => l.type === ShareLinkType.CoachUnique,
    );
    return links.map((l) => this.toInvitationView(l));
  }

  /**
   * Re-send a pending invitation. Mints a new code rather than extending the
   * expiry: the original may have reached the wrong mailbox, and a code that
   * keeps coming back to life can never be taken away.
   */
  async resendInvitation(principal: Principal, invitationId: string): Promise<CoachInvitationView> {
    const trainer = await this.trainersService.requireOwnProfile(principal.userId);
    const existing = await this.requireOwnInvitation(trainer.id, invitationId);

    if (existing.useCount >= 1) {
      throw new ConflictException({
        errorCode: ErrorCode.INVITATION_ALREADY_ACCEPTED,
        message: 'This invitation has already been accepted.',
      });
    }
    if (!existing.targetEmail) {
      throw new ConflictException({
        errorCode: ErrorCode.SHARE_LINK_INVALID,
        message: 'This invitation has no recipient to resend to.',
      });
    }

    const email = existing.targetEmail;
    const replacement = await this.dataSource.transaction(async (manager: EntityManager) => {
      await this.shareLinks.deactivate(existing.id, manager);
      return this.shareLinks.create(
        {
          trainerProfileId: trainer.id,
          type: ShareLinkType.CoachUnique,
          createdByUserId: principal.userId,
          targetEmail: email,
          // Carried over so a resend does not lose the name the trainer typed.
          targetName: existing.targetName,
          expiresAt: new Date(this.clock.now().getTime() + COACH_INVITE_TTL_MS),
          maxUses: 1,
        },
        manager,
      );
    });

    await this.mail.sendCoachInviteEmail(email, trainer.businessName, replacement.code);
    await this.audit.record({
      action: AUDIT_COACH_INVITE_RESENT,
      actor: principal,
      target: { type: 'ShareLink', id: replacement.id },
      metadata: { email, replaced: existing.id },
    });
    return this.toInvitationView(replacement);
  }

  /**
   * Cancel a pending invitation. The link is live for seven days and grants a
   * Coach account inside the org, so it has to be revocable.
   */
  async revokeInvitation(principal: Principal, invitationId: string): Promise<CoachInvitationView> {
    const trainer = await this.trainersService.requireOwnProfile(principal.userId);
    const existing = await this.requireOwnInvitation(trainer.id, invitationId);

    if (existing.useCount >= 1) {
      throw new ConflictException({
        errorCode: ErrorCode.INVITATION_ALREADY_ACCEPTED,
        message: 'This invitation has already been accepted and cannot be revoked.',
      });
    }

    await this.shareLinks.deactivate(existing.id);
    await this.audit.record({
      action: AUDIT_COACH_INVITE_REVOKED,
      actor: principal,
      target: { type: 'ShareLink', id: existing.id },
      metadata: { email: existing.targetEmail },
    });
    return this.toInvitationView(await this.requireOwnInvitation(trainer.id, invitationId));
  }

  async resolve(code: string): Promise<ResolvedCoachInviteView> {
    const link = await this.shareLinks.findByCode(code);
    if (!link) {
      return { valid: false, email: null, trainerName: null };
    }

    const evaluation = this.shareLinks.evaluate(link, ShareLinkType.CoachUnique);
    // A code of the wrong kind or one that was revoked gives nothing back; a
    // merely expired or used-up invite still names its sender for the accept page.
    if (!evaluation.ok && evaluation.reason !== 'expired' && evaluation.reason !== 'exhausted') {
      return { valid: false, email: null, trainerName: null };
    }

    const trainer = await this.trainersService.findById(link.trainerProfileId);
    return {
      valid: evaluation.ok,
      email: link.targetEmail,
      trainerName: trainer?.businessName ?? null,
    };
  }

  /** New coach accepts an invite: creates the Coach account + profile. */
  async accept(code: string, dto: AcceptCoachInviteDto): Promise<{ message: string }> {
    // Before the transaction, which row-locks the invite: argon2id's ~40ms must
    // not run under it. Discarded when an existing account is re-homed instead.
    const passwordHash = await this.passwords.hash(dto.password);

    let verificationToken = '';
    const user = await this.dataSource.transaction(async (manager: EntityManager) => {
      // Locked inside the transaction so two people cannot accept the same
      // single-use invite concurrently.
      const link = await this.shareLinks.lockForRedemption(
        code,
        ShareLinkType.CoachUnique,
        manager,
      );
      if (!link.targetEmail) {
        throw new NotFoundException({
          errorCode: ErrorCode.SHARE_LINK_INVALID,
          message: 'This coaching invite is invalid.',
        });
      }

      const email = link.targetEmail;
      const existing = await this.usersService.findByEmail(email);
      if (existing) {
        return this.attachExistingCoach(existing, link.trainerProfileId, link.id, manager);
      }

      const created = await this.authService.createUnverifiedAccount(
        {
          email,
          passwordHash,
          role: Role.Coach,
          firstName: dto.firstName,
          lastName: dto.lastName,
        },
        manager,
      );
      verificationToken = created.verificationToken;

      await this.coachProfiles.startEngagement(created.user.id, link.trainerProfileId, manager);
      await this.shareLinks.incrementUse(link.id, manager);
      return created.user;
    });

    if (verificationToken === '') {
      // An existing account was re-homed; there is nothing new to verify.
      return { message: 'You have joined this trainer. Sign in as usual.' };
    }
    await this.mail.sendVerificationEmail(user.email, verificationToken);
    return { message: 'Coach account created. Verify your email to finish joining.' };
  }

  /**
   * Attach an existing account to this trainer. A coach may only be active under
   * one trainer at a time, but an ended engagement must not block re-hiring.
   */
  private async attachExistingCoach(
    existing: User,
    trainerProfileId: string,
    linkId: string,
    manager: EntityManager,
  ): Promise<User> {
    if (existing.role !== Role.Coach) {
      // A parent or trainer account cannot quietly become a coach: their
      // existing data and permissions are shaped by the role they have.
      throw new ConflictException({
        errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
        message: 'An account with this email already exists and is not a coach account.',
      });
    }

    await this.coachProfiles.assertNotActiveElsewhere(existing.id, trainerProfileId, manager);
    await this.coachProfiles.startEngagement(existing.id, trainerProfileId, manager);
    await this.shareLinks.incrementUse(linkId, manager);
    return existing;
  }

  private async requireOwnInvitation(
    trainerProfileId: string,
    invitationId: string,
  ): Promise<ShareLink> {
    const link = await this.shareLinks.findById(invitationId);
    // Type and owner are both part of the lookup: a trainer must not be able
    // to reach a player link, or another org's invite, through this route.
    if (
      !link ||
      link.trainerProfileId !== trainerProfileId ||
      link.type !== ShareLinkType.CoachUnique
    ) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'Invitation not found.',
      });
    }
    return link;
  }

  private toInvitationView(link: ShareLink): CoachInvitationView {
    return {
      id: link.id,
      code: link.code,
      email: link.targetEmail ?? '',
      name: link.targetName,
      status: this.statusOf(link),
      expiresAt: link.expiresAt,
      createdAt: link.createdAt,
    };
  }

  private statusOf(link: ShareLink): CoachInvitationStatus {
    // Ahead of evaluate(): accepting an invite both burns the use and
    // deactivates the link, which evaluate() reports as revoked.
    if (link.useCount >= 1) {
      return 'accepted';
    }
    return this.shareLinks.evaluate(link, ShareLinkType.CoachUnique).ok ? 'pending' : 'expired';
  }
}
