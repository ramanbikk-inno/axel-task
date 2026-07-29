import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { repoFor } from '../../shared/database/repo-for';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { changedFields } from '../audit/changed-fields';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { OrgMembershipService } from '../org-membership/org-membership.service';
import { TrainersService } from '../trainers/trainers.service';
import { UsersService } from '../users/users.service';
import { AUDIT_COACH_OFFBOARDED, AUDIT_COACH_PROFILE_UPDATED } from './coach-audit-actions';
import { CoachView, PublicCoachView, UpdateCoachProfileDto } from './dto/coach.dto';
import { CoachProfile, CoachStatus } from './entities/coach-profile.entity';

/**
 * Everything that owns a `coach_profiles` row: engagement state, profile CRUD,
 * the org and public rosters, and GDPR erasure. Invitations live in
 * CoachInvitationService, which calls in here for the engagement writes so all
 * reads and writes of the table stay in one place.
 */
@Injectable()
export class CoachProfileService {
  constructor(
    @InjectRepository(CoachProfile) private readonly coaches: Repository<CoachProfile>,
    private readonly trainersService: TrainersService,
    private readonly orgMembership: OrgMembershipService,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
    private readonly clock: ClockService,
  ) {}

  /**
   * End a coach's engagement. The row is kept and marked Inactive so the history
   * survives and the partial unique index frees them to be hired elsewhere.
   * Sessions are revoked at once — their tenancy comes from this row.
   */
  async offboardCoach(principal: Principal, coachProfileId: string): Promise<CoachView> {
    const trainer = await this.trainersService.requireOwnProfile(principal.userId);
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

  /** A coach's own profile as they see it. */
  async getOwnProfile(principal: Principal): Promise<CoachView> {
    const profile = await this.requireOwnCoachProfile(principal);
    const [view] = await this.buildCoachViews([profile]);
    return view;
  }

  async updateOwnProfile(principal: Principal, dto: UpdateCoachProfileDto): Promise<CoachView> {
    const profile = await this.requireOwnCoachProfile(principal);
    return this.applyProfileUpdate(profile, dto, principal);
  }

  /** Null when the coach has no active engagement — e.g. off-boarded. */
  async findActiveByUserId(userId: string): Promise<CoachView | null> {
    const profile = await this.coaches.findOne({
      where: { userId, status: CoachStatus.Active },
    });
    if (!profile) {
      return null;
    }
    const [view] = await this.buildCoachViews([profile]);
    return view;
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

  async listCoaches(principal: Principal, includeInactive = false): Promise<CoachView[]> {
    const trainer = await this.trainersService.requireOwnProfile(principal.userId);
    const profiles = await this.coaches.find({
      where: includeInactive
        ? { trainerProfileId: trainer.id }
        : { trainerProfileId: trainer.id, status: CoachStatus.Active },
      order: { joinedAt: 'DESC' },
    });
    return this.buildCoachViews(profiles);
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
    if (!(await this.orgMembership.isOrgMember(principal, trainerProfileId))) {
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

    // Narrowed field by field, never spread: PublicCoachView deliberately omits
    // email and the employment dates CoachView carries.
    const views = await this.buildCoachViews(profiles);
    return views.map((v) => ({
      id: v.id,
      firstName: v.firstName,
      lastName: v.lastName,
      bio: v.bio,
      credentials: v.credentials,
      certifications: v.certifications,
    }));
  }

  /**
   * GDPR erasure of every coach_profiles row a user has ever held. Clears the
   * free-text PII on every engagement (not only the active one — an ended
   * engagement's bio survives otherwise) and off-boards any still-Active row
   * so an erased coach stops appearing in org rosters and public listings.
   */
  async anonymizeByUserId(userId: string, manager?: EntityManager): Promise<void> {
    const repo = repoFor(this.coaches, CoachProfile, manager);
    await repo.update(
      { userId },
      { bio: null, credentials: null, certifications: null, publicVisible: false },
    );
    await repo.update(
      { userId, status: CoachStatus.Active },
      { status: CoachStatus.Inactive, endedAt: this.clock.now() },
    );
  }

  /**
   * Guard the "one active trainer per coach" rule before a hire. Only Active
   * rows count: an ended engagement must not block re-hiring. The partial unique
   * index enforces the same rule in the database.
   */
  async assertNotActiveElsewhere(
    userId: string,
    trainerProfileId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const active = await repoFor(this.coaches, CoachProfile, manager).findOne({
      where: { userId, status: CoachStatus.Active },
    });
    if (!active) {
      return;
    }
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

  /** Record a new active engagement. Callers guard exclusivity first. */
  async startEngagement(
    userId: string,
    trainerProfileId: string,
    manager?: EntityManager,
  ): Promise<CoachProfile> {
    const repo = repoFor(this.coaches, CoachProfile, manager);
    return repo.save(
      repo.create({
        userId,
        trainerProfileId,
        publicVisible: false,
        status: CoachStatus.Active,
        joinedAt: this.clock.now(),
        endedAt: null,
      }),
    );
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

  /**
   * Resolved from `principal.coachProfileId`, derived per request from the active
   * engagement, so an off-boarded coach has none. Never from a caller-supplied
   * id — that is the whole boundary.
   */
  private async requireOwnCoachProfile(principal: Principal): Promise<CoachProfile> {
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
    return profile;
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
}
