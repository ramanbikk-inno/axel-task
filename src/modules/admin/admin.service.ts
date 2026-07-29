import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AgeGateService } from '../../shared/registration/age-gate.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { changedFields } from '../audit/changed-fields';
import { Principal } from '../auth/principal';
import { AuthService } from '../auth/auth.service';
import { CoachesService } from '../coaches/coaches.service';
import { CoachView, UpdateCoachProfileDto } from '../coaches/dto/coach.dto';
import { MailService } from '../mail/mail.service';
import { UpdatePlayerProfileDto, UpdateTrainerProfileDto } from '../profile/dto/profile.dto';
import { Role, UserStatus } from '../users/entities/user.enums';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import {
  AdminPlayerProfileView,
  AdminTrainerProfileView,
  AdminUserDetailView,
} from './dto/admin-profile.view';
import { CreateTrainerDto } from './dto/create-trainer.dto';
import { ListUsersQueryDto } from './dto/list-users.query.dto';
import { PaginatedUsersDto, UserSummaryDto } from './dto/user-summary.dto';
import { requireUser } from './require-user';
import { UserErasureService } from './user-erasure.service';

export const AUDIT_TRAINER_CREATED = 'trainer.created';
export const AUDIT_USER_DEACTIVATED = 'user.deactivated';
export const AUDIT_USER_REACTIVATED = 'user.reactivated';
export const AUDIT_USER_UPDATED = 'user.updated';
export { AUDIT_USER_DELETED } from './user-erasure.service';

/** One Active/Inactive transition, minus what differs between the two routes. */
interface StatusTransition {
  to: UserStatus;
  action: string;
  reason?: string;
  /** Erasure is permanent, so both routes refuse a Deleted target — differently worded. */
  deletedMessage: string;
  /** Runs before the Deleted check; only deactivation has one. */
  extraGuard?: (target: User) => void;
  /** Runs after the status is written, before the audit row. Deactivation only. */
  onApplied?: (target: User) => Promise<void>;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly trainersService: TrainersService,
    private readonly authService: AuthService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly playersService: PlayersService,
    private readonly ageGate: AgeGateService,
    private readonly coachesService: CoachesService,
    private readonly userErasure: UserErasureService,
  ) {}

  async createTrainer(
    input: CreateTrainerDto,
    actor: Principal,
  ): Promise<{ id: string; email: string; role: Role }> {
    if (input.role === Role.SuperAdmin) {
      throw new ForbiddenException({
        errorCode: ErrorCode.CANNOT_CREATE_SUPER_ADMIN,
        message: 'A Super Admin cannot be created through this endpoint.',
      });
    }
    // Coaches are invited by their trainer, not minted here. Anything other
    // than Trainer used to be accepted and silently rewritten.
    if (input.role !== undefined && input.role !== Role.Trainer) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'This endpoint creates Trainer accounts only.',
      });
    }

    const existing = await this.usersService.findByEmail(input.email);
    if (existing !== null) {
      throw new ConflictException({
        errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
        message: 'An account with this email already exists.',
      });
    }

    let setupToken = '';
    const user = await this.dataSource.transaction(async (manager: EntityManager) => {
      const created = await this.usersService.create(
        {
          email: input.email,
          role: Role.Trainer,
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          emailVerified: false,
          mustSetPassword: true,
          status: UserStatus.Active,
        },
        manager,
      );

      await this.trainersService.create(
        { userId: created.id, businessName: input.businessName },
        manager,
      );

      setupToken = await this.authService.createSetupToken(created.id, manager);

      await this.audit.record(
        {
          action: AUDIT_TRAINER_CREATED,
          actor,
          targetUserId: created.id,
          metadata: {
            email: input.email,
            businessName: input.businessName,
            role: Role.Trainer,
          },
        },
        manager,
      );

      return created;
    });

    await this.mail.sendTrainerInviteEmail(user.email, input.firstName ?? '', setupToken);

    return { id: user.id, email: user.email, role: Role.Trainer };
  }

  /**
   * Flip to Inactive and log the user out. Historical data is kept. Super Admins
   * are excluded so the platform cannot be locked out.
   */
  async deactivateUser(
    targetUserId: string,
    actor: Principal,
    reason?: string,
  ): Promise<UserSummaryDto> {
    return this.changeUserStatus(targetUserId, actor, {
      to: UserStatus.Inactive,
      action: AUDIT_USER_DEACTIVATED,
      reason,
      // Otherwise Deleted -> deactivate -> reactivate walks an erased account back
      // to life, past the guard on reactivate.
      deletedMessage: 'Deleted users cannot be deactivated.',
      extraGuard: (target) => {
        if (target.role === Role.SuperAdmin) {
          throw new ForbiddenException({
            errorCode: ErrorCode.CANNOT_DEACTIVATE_SUPER_ADMIN,
            message: 'Super Admin accounts cannot be deactivated.',
          });
        }
      },
      onApplied: (target) => this.authService.revokeAllUserSessions(target.id, 'deactivated'),
    });
  }

  /** Reactivate a deactivated user. Erasure is permanent, so Deleted is refused. */
  async reactivateUser(
    targetUserId: string,
    actor: Principal,
    reason?: string,
  ): Promise<UserSummaryDto> {
    return this.changeUserStatus(targetUserId, actor, {
      to: UserStatus.Active,
      action: AUDIT_USER_REACTIVATED,
      reason,
      deletedMessage: 'Deleted users cannot be reactivated.',
    });
  }

  /**
   * Shared body of the two status routes. Reactivation revokes nothing, so the
   * session sweep is an opt-in hook rather than part of the transition.
   */
  private async changeUserStatus(
    targetUserId: string,
    actor: Principal,
    transition: StatusTransition,
  ): Promise<UserSummaryDto> {
    const target = await this.requireUser(targetUserId);

    transition.extraGuard?.(target);

    if (target.status === UserStatus.Deleted) {
      throw new ConflictException({
        errorCode: ErrorCode.ACCOUNT_DELETED,
        message: transition.deletedMessage,
      });
    }

    if (target.status !== transition.to) {
      await this.usersService.setStatus(target.id, transition.to);
      await transition.onApplied?.(target);
      await this.audit.record({
        action: transition.action,
        actor,
        targetUserId: target.id,
        metadata: { reason: transition.reason ?? null },
      });
    }

    const updated = await this.requireUser(target.id);
    return UserSummaryDto.fromEntity(updated);
  }

  /** Super Admin edits any user's common profile fields. */
  async updateUser(
    targetUserId: string,
    actor: Principal,
    input: { firstName?: string; lastName?: string; phone?: string },
  ): Promise<UserSummaryDto> {
    await this.requireUser(targetUserId);
    const updated = await this.usersService.updateProfile(targetUserId, {
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
    });
    await this.audit.record({
      action: AUDIT_USER_UPDATED,
      actor,
      targetUserId,
      metadata: { fields: changedFields(input) },
    });
    return UserSummaryDto.fromEntity(updated);
  }

  /** Super Admin edits a trainer's organisation fields, same shape as self-service. */
  async updateTrainerProfile(
    targetUserId: string,
    actor: Principal,
    input: UpdateTrainerProfileDto,
  ): Promise<AdminTrainerProfileView> {
    const target = await this.requireUser(targetUserId);
    AdminService.requireRole(target, Role.Trainer, 'trainer');

    const profile = await this.trainersService.findByUserId(targetUserId);
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'Trainer profile not found.',
      });
    }

    const updated = await this.trainersService.applyProfileUpdate(profile, input, actor);
    return AdminTrainerProfileView.from(updated);
  }

  /** Super Admin edits a coach's public profile fields on their active engagement. */
  async updateCoachProfile(
    targetUserId: string,
    actor: Principal,
    input: UpdateCoachProfileDto,
  ): Promise<CoachView> {
    const target = await this.requireUser(targetUserId);
    AdminService.requireRole(target, Role.Coach, 'coach');
    return this.coachesService.adminUpdateProfile(targetUserId, actor, input);
  }

  /** Super Admin edits a player's own (non-child) trainee profile fields. */
  async updatePlayerProfile(
    targetUserId: string,
    actor: Principal,
    input: UpdatePlayerProfileDto,
  ): Promise<AdminPlayerProfileView> {
    const target = await this.requireUser(targetUserId);
    AdminService.requireRole(target, Role.PlayerParent, 'player');
    if (input.birthDate !== undefined) {
      // Same floor as the self-service route: the age rule belongs to the
      // account, not to whoever is editing it.
      this.ageGate.assertOldEnoughForOwnAccount(input.birthDate);
    }

    const profile = await this.playersService.findSelfProfile(targetUserId);
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.PLAYER_PROFILE_NOT_FOUND,
        message: 'This account has no self player profile — it may be a child login.',
      });
    }

    const updated = await this.playersService.applyProfileUpdate(profile, input, actor);
    return AdminPlayerProfileView.from(updated);
  }

  /** GDPR erasure. Owned by UserErasureService; kept here for existing callers. */
  async deleteUser(
    targetUserId: string,
    actor: Principal,
    reason: string,
  ): Promise<UserSummaryDto> {
    return this.userErasure.deleteUser(targetUserId, actor, reason);
  }

  async getUser(targetUserId: string): Promise<AdminUserDetailView> {
    const user = await this.requireUser(targetUserId);

    return {
      user: UserSummaryDto.fromEntity(user),
      trainer: user.role === Role.Trainer ? await this.trainerViewFor(targetUserId) : null,
      coach:
        user.role === Role.Coach
          ? await this.coachesService.findActiveByUserId(targetUserId)
          : null,
      player: user.role === Role.PlayerParent ? await this.playerViewFor(targetUserId) : null,
    };
  }

  private async trainerViewFor(userId: string): Promise<AdminTrainerProfileView | null> {
    const profile = await this.trainersService.findByUserId(userId);
    return profile === null ? null : AdminTrainerProfileView.from(profile);
  }

  private async playerViewFor(userId: string): Promise<AdminPlayerProfileView | null> {
    const profile =
      (await this.playersService.findSelfProfile(userId)) ??
      (await this.playersService.findByChildUserId(userId));
    return profile === null ? null : AdminPlayerProfileView.from(profile);
  }

  private async requireUser(id: string): Promise<User> {
    return requireUser(this.usersService, id);
  }

  /** The target must hold the role whose profile is being edited. */
  private static requireRole(target: User, role: Role, profileLabel: string): void {
    if (target.role !== role) {
      throw new ConflictException({
        errorCode: ErrorCode.ROLE_MISMATCH,
        message: `This user does not have a ${profileLabel} profile.`,
      });
    }
  }

  async listUsers(query: ListUsersQueryDto): Promise<PaginatedUsersDto> {
    const { items, total } = await this.usersService.search({
      search: query.search,
      role: query.role,
      status: query.status,
      page: query.page,
      limit: query.limit,
    });

    return {
      items: items.map((user) => UserSummaryDto.fromEntity(user)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }
}
