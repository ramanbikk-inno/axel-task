import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { PasswordService } from '../../shared/crypto/password.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { changedFields } from '../audit/changed-fields';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { AssociationsService } from '../enrollment/associations.service';
import { ShareLink, ShareLinkType } from '../enrollment/entities/share-link.entity';
import { AssociationStatus } from '../enrollment/entities/trainer-player-association.entity';
import { ShareLinksService } from '../enrollment/share-links.service';
import { MailService } from '../mail/mail.service';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import { User } from '../users/entities/user.entity';
import { Role } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import {
  AcceptCoachInviteDto,
  CoachInvitationStatus,
  CoachInvitationView,
  CoachView,
  InviteCoachDto,
  PublicCoachView,
  ResolvedCoachInviteView,
  UpdateCoachProfileDto,
} from './dto/coach.dto';
import { CoachProfile, CoachStatus } from './entities/coach-profile.entity';

/** Unique coach invites expire after 7 days and are single-use. */
const COACH_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const AUDIT_COACH_INVITED = 'coach.invited';
export const AUDIT_COACH_INVITE_RESENT = 'coach.invite-resent';
export const AUDIT_COACH_INVITE_REVOKED = 'coach.invite-revoked';
export const AUDIT_COACH_OFFBOARDED = 'coach.offboarded';
export const AUDIT_COACH_JOINED = 'coach.joined';
export const AUDIT_COACH_PROFILE_UPDATED = 'coach.profile-updated';

@Injectable()
export class CoachesService {
  constructor(
    @InjectRepository(CoachProfile) private readonly coaches: Repository<CoachProfile>,
    private readonly dataSource: DataSource,
    private readonly trainersService: TrainersService,
    private readonly shareLinks: ShareLinksService,
    private readonly associations: AssociationsService,
    private readonly playersService: PlayersService,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly clock: ClockService,
    private readonly passwords: PasswordService,
  ) {}

  async invite(principal: Principal, dto: InviteCoachDto): Promise<CoachInvitationView> {
    const trainer = await this.requireTrainer(principal.userId);

    const link = await this.shareLinks.create({
      trainerProfileId: trainer.id,
      type: ShareLinkType.CoachUnique,
      createdByUserId: principal.userId,
      targetEmail: dto.email,
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
    const trainer = await this.requireTrainer(principal.userId);
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
    const trainer = await this.requireTrainer(principal.userId);
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
    const trainer = await this.requireTrainer(principal.userId);
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

  /**
   * End a coach's engagement. The row is kept and marked Inactive so the history
   * survives and the partial unique index frees them to be hired elsewhere.
   * Sessions are revoked at once — their tenancy comes from this row.
   */
  async offboardCoach(principal: Principal, coachProfileId: string): Promise<CoachView> {
    const trainer = await this.requireTrainer(principal.userId);
    const profile = await this.coaches.findOne({
      // Tenancy boundary: without it a trainer could off-board another org's coach.
      where: { id: coachProfileId, trainerProfileId: trainer.id },
    });
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
        message: 'Coach not found in your organization.',
      });
    }
    if (profile.status !== CoachStatus.Active) {
      throw new ConflictException({
        errorCode: ErrorCode.COACH_ALREADY_INACTIVE,
        message: 'This coach has already been off-boarded.',
      });
    }

    const now = this.clock.now();
    await this.coaches.update({ id: profile.id }, { status: CoachStatus.Inactive, endedAt: now });
    await this.authService.revokeAllUserSessions(profile.userId, 'coach-offboarded');
    await this.audit.record({
      action: AUDIT_COACH_OFFBOARDED,
      actor: principal,
      targetUserId: profile.userId,
      target: { type: 'CoachProfile', id: profile.id },
    });

    const [view] = await this.buildCoachViews([
      { ...profile, status: CoachStatus.Inactive, endedAt: now },
    ]);
    return view;
  }

  /**
   * Resolved from `principal.coachProfileId`, derived per request from the active
   * engagement, so an off-boarded coach has none. Never from a caller-supplied
   * id — that is the whole boundary.
   */
  async updateOwnProfile(principal: Principal, dto: UpdateCoachProfileDto): Promise<CoachView> {
    if (principal.coachProfileId === null) {
      throw new ForbiddenException({
        errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
        message: 'No active coach profile for this account.',
      });
    }

    const profile = await this.coaches.findOne({ where: { id: principal.coachProfileId } });
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
        message: 'Coach profile not found.',
      });
    }

    return this.applyProfileUpdate(profile, dto, principal);
  }

  /** Super Admin override, targeted by user id rather than the caller's own session. */
  async adminUpdateProfile(
    targetUserId: string,
    actor: Principal,
    dto: UpdateCoachProfileDto,
  ): Promise<CoachView> {
    const profile = await this.coaches.findOne({
      where: { userId: targetUserId, status: CoachStatus.Active },
    });
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
        message: 'No active coach profile for this user.',
      });
    }

    return this.applyProfileUpdate(profile, dto, actor);
  }

  private async applyProfileUpdate(
    profile: CoachProfile,
    dto: UpdateCoachProfileDto,
    actor: Principal,
  ): Promise<CoachView> {
    if (dto.bio !== undefined) {
      profile.bio = dto.bio;
    }
    if (dto.credentials !== undefined) {
      profile.credentials = dto.credentials;
    }
    if (dto.certifications !== undefined) {
      profile.certifications = dto.certifications;
    }
    if (dto.publicVisible !== undefined) {
      profile.publicVisible = dto.publicVisible;
    }

    const saved = await this.coaches.save(profile);
    await this.audit.record({
      action: AUDIT_COACH_PROFILE_UPDATED,
      actor,
      targetUserId: profile.userId,
      target: { type: 'CoachProfile', id: profile.id },
      metadata: { fields: changedFields(dto) },
    });

    const [view] = await this.buildCoachViews([saved]);
    return view;
  }

  /** A coach's own profile as they see it. */
  async getOwnProfile(principal: Principal): Promise<CoachView> {
    if (principal.coachProfileId === null) {
      throw new ForbiddenException({
        errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
        message: 'No active coach profile for this account.',
      });
    }
    const profile = await this.coaches.findOne({ where: { id: principal.coachProfileId } });
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
        message: 'Coach profile not found.',
      });
    }
    const [view] = await this.buildCoachViews([profile]);
    return view;
  }

  async listCoaches(principal: Principal, includeInactive = false): Promise<CoachView[]> {
    const trainer = await this.requireTrainer(principal.userId);
    const profiles = await this.coaches.find({
      where: includeInactive
        ? { trainerProfileId: trainer.id }
        : { trainerProfileId: trainer.id, status: CoachStatus.Active },
      order: { joinedAt: 'DESC' },
    });
    return this.buildCoachViews(profiles);
  }

  /**
   * Is this principal inside the named organisation? `trainerOrgId` is already
   * resolved per request — own org for a Trainer, employer's for a Coach, null
   * once an engagement ends — so compare against it rather than re-deriving it.
   */
  private async isOrgMember(principal: Principal, trainerProfileId: string): Promise<boolean> {
    if (principal.role === Role.SuperAdmin) {
      return true;
    }
    if (principal.role === Role.Trainer || principal.role === Role.Coach) {
      return principal.trainerOrgId === trainerProfileId;
    }

    // A child login sees only the one profile it is, never a sibling's.
    const profileIds = principal.isChild
      ? principal.childPlayerProfileId === null
        ? []
        : [principal.childPlayerProfileId]
      : (await this.playersService.findByOwner(principal.userId)).map((p) => p.id);
    if (profileIds.length === 0) {
      return false;
    }

    const links = await this.associations.findByPlayerProfiles(profileIds);
    return links.some(
      (l) => l.trainerProfileId === trainerProfileId && l.status === AssociationStatus.Active,
    );
  }

  /**
   * The coaches an organisation shows its own members — the read `publicVisible`
   * gates. Members only: authentication alone would let a competing trainer read
   * any org's staff list from its id. 404, not 403, so the reply gives nothing away.
   */
  async listPublicCoaches(
    principal: Principal,
    trainerProfileId: string,
  ): Promise<PublicCoachView[]> {
    if (!(await this.isOrgMember(principal, trainerProfileId))) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'Trainer not found.',
      });
    }

    const profiles = await this.coaches.find({
      where: {
        trainerProfileId,
        status: CoachStatus.Active,
        publicVisible: true,
      },
      order: { joinedAt: 'ASC' },
    });
    if (profiles.length === 0) {
      return [];
    }

    const users = await this.usersService.findByIds(profiles.map((p) => p.userId));
    const userById = new Map(users.map((u) => [u.id, u]));
    return profiles.map((p) => {
      const u = userById.get(p.userId);
      return {
        id: p.id,
        firstName: u?.firstName ?? null,
        lastName: u?.lastName ?? null,
        bio: p.bio,
        credentials: p.credentials,
        certifications: p.certifications,
      };
    });
  }

  private async buildCoachViews(profiles: CoachProfile[]): Promise<CoachView[]> {
    const users = await this.usersService.findByIds(profiles.map((p) => p.userId));
    const userById = new Map(users.map((u) => [u.id, u]));
    return profiles.map((p) => {
      const u = userById.get(p.userId);
      return {
        id: p.id,
        userId: p.userId,
        email: u?.email ?? 'unknown',
        firstName: u?.firstName ?? null,
        lastName: u?.lastName ?? null,
        bio: p.bio,
        credentials: p.credentials,
        certifications: p.certifications,
        publicVisible: p.publicVisible,
        status: p.status,
        joinedAt: p.joinedAt,
        endedAt: p.endedAt,
      };
    });
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

  async resolve(code: string): Promise<ResolvedCoachInviteView> {
    const link = await this.shareLinks.findByCode(code);
    if (!link || !link.active || link.type !== ShareLinkType.CoachUnique) {
      return { valid: false, email: null, trainerName: null };
    }
    const usable =
      (link.expiresAt === null || link.expiresAt.getTime() > this.clock.now().getTime()) &&
      (link.maxUses === null || link.useCount < link.maxUses);
    const trainer = await this.trainersService.findById(link.trainerProfileId);
    return {
      valid: usable,
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

      const coachRepo = manager.getRepository(CoachProfile);
      await coachRepo.save(
        coachRepo.create({
          userId: created.user.id,
          trainerProfileId: link.trainerProfileId,
          publicVisible: false,
          joinedAt: this.clock.now(),
        }),
      );

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
   * The partial unique index enforces the same rule in the database.
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

    const coachRepo = manager.getRepository(CoachProfile);
    const active = await coachRepo.findOne({
      where: { userId: existing.id, status: CoachStatus.Active },
    });
    if (active) {
      throw new ConflictException({
        errorCode:
          active.trainerProfileId === trainerProfileId
            ? ErrorCode.EMAIL_ALREADY_EXISTS
            : ErrorCode.COACH_ACTIVE_ELSEWHERE,
        message:
          active.trainerProfileId === trainerProfileId
            ? 'This coach is already active in your organization.'
            : 'This coach is currently active with another trainer and must be off-boarded first.',
      });
    }

    await coachRepo.save(
      coachRepo.create({
        userId: existing.id,
        trainerProfileId,
        publicVisible: false,
        status: CoachStatus.Active,
        joinedAt: this.clock.now(),
        endedAt: null,
      }),
    );
    await this.shareLinks.incrementUse(linkId, manager);
    return existing;
  }

  private toInvitationView(link: ShareLink): CoachInvitationView {
    return {
      id: link.id,
      code: link.code,
      email: link.targetEmail ?? '',
      status: this.statusOf(link),
      expiresAt: link.expiresAt,
      createdAt: link.createdAt,
    };
  }

  private statusOf(link: ShareLink): CoachInvitationStatus {
    if (link.useCount >= 1) {
      return 'accepted';
    }
    const expired =
      !link.active ||
      (link.expiresAt !== null && link.expiresAt.getTime() <= this.clock.now().getTime());
    return expired ? 'expired' : 'pending';
  }

  private async requireTrainer(userId: string): Promise<{ id: string; businessName: string }> {
    const trainer = await this.trainersService.findByUserId(userId);
    if (!trainer) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      });
    }
    return { id: trainer.id, businessName: trainer.businessName };
  }
}
