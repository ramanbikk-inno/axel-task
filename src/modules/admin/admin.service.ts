import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { changedFields } from '../audit/changed-fields';
import { Principal } from '../auth/principal';
import { AuthService } from '../auth/auth.service';
import { CoachesService } from '../coaches/coaches.service';
import { CoachView, UpdateCoachProfileDto } from '../coaches/dto/coach.dto';
import { ShareLinksService } from '../enrollment/share-links.service';
import { MailService } from '../mail/mail.service';
import {
  AUDIT_PLAYER_PROFILE_UPDATED,
  AUDIT_TRAINER_PROFILE_UPDATED,
} from '../profile/profile.service';
import { UpdatePlayerProfileDto, UpdateTrainerProfileDto } from '../profile/dto/profile.dto';
import { Role, UserStatus } from '../users/entities/user.enums';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { PlayersService } from '../players/players.service';
import { discardAsset } from '../storage/discard-asset';
import { STORAGE, StorageService } from '../storage/storage.service';
import { TrainersService } from '../trainers/trainers.service';
import {
  AdminPlayerProfileView,
  AdminTrainerProfileView,
  AdminUserDetailView,
} from './dto/admin-profile.view';
import { CreateTrainerDto } from './dto/create-trainer.dto';
import { ListUsersQueryDto } from './dto/list-users.query.dto';
import { PaginatedUsersDto, UserSummaryDto } from './dto/user-summary.dto';
import { UserDeletionLog } from './entities/user-deletion-log.entity';

export const AUDIT_TRAINER_CREATED = 'trainer.created';
export const AUDIT_USER_DEACTIVATED = 'user.deactivated';
export const AUDIT_USER_REACTIVATED = 'user.reactivated';
export const AUDIT_USER_UPDATED = 'user.updated';
export const AUDIT_USER_DELETED = 'user.deleted';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly trainersService: TrainersService,
    private readonly authService: AuthService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly playersService: PlayersService,
    private readonly shareLinks: ShareLinksService,
    @Inject(STORAGE) private readonly storage: StorageService,
    private readonly clock: ClockService,
    private readonly coachesService: CoachesService,
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
    const target = await this.requireUser(targetUserId);

    if (target.role === Role.SuperAdmin) {
      throw new ForbiddenException({
        errorCode: ErrorCode.CANNOT_DEACTIVATE_SUPER_ADMIN,
        message: 'Super Admin accounts cannot be deactivated.',
      });
    }

    // Otherwise Deleted -> deactivate -> reactivate walks an erased account back
    // to life, past the guard on reactivate.
    if (target.status === UserStatus.Deleted) {
      throw new ConflictException({
        errorCode: ErrorCode.ACCOUNT_DELETED,
        message: 'Deleted users cannot be deactivated.',
      });
    }

    if (target.status !== UserStatus.Inactive) {
      await this.usersService.setStatus(target.id, UserStatus.Inactive);
      await this.authService.revokeAllUserSessions(target.id, 'deactivated');
      await this.audit.record({
        action: AUDIT_USER_DEACTIVATED,
        actor,
        targetUserId: target.id,
        metadata: { reason: reason ?? null },
      });
    }

    const updated = await this.requireUser(target.id);
    return UserSummaryDto.fromEntity(updated);
  }

  /** Reactivate a deactivated user. Erasure is permanent, so Deleted is refused. */
  async reactivateUser(
    targetUserId: string,
    actor: Principal,
    reason?: string,
  ): Promise<UserSummaryDto> {
    const target = await this.requireUser(targetUserId);

    if (target.status === UserStatus.Deleted) {
      throw new ConflictException({
        errorCode: ErrorCode.ACCOUNT_DELETED,
        message: 'Deleted users cannot be reactivated.',
      });
    }

    if (target.status !== UserStatus.Active) {
      await this.usersService.setStatus(target.id, UserStatus.Active);
      await this.audit.record({
        action: AUDIT_USER_REACTIVATED,
        actor,
        targetUserId: target.id,
        metadata: { reason: reason ?? null },
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
    if (target.role !== Role.Trainer) {
      throw new ConflictException({
        errorCode: ErrorCode.ROLE_MISMATCH,
        message: 'This user does not have a trainer profile.',
      });
    }

    const updated = await this.trainersService.updateProfileByUserId(targetUserId, input);
    if (!updated) {
      throw new NotFoundException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'Trainer profile not found.',
      });
    }

    await this.audit.record({
      action: AUDIT_TRAINER_PROFILE_UPDATED,
      actor,
      targetUserId,
      target: { type: 'TrainerProfile', id: updated.id },
      metadata: { fields: changedFields(input) },
    });
    return AdminTrainerProfileView.from(updated);
  }

  /** Super Admin edits a coach's public profile fields on their active engagement. */
  async updateCoachProfile(
    targetUserId: string,
    actor: Principal,
    input: UpdateCoachProfileDto,
  ): Promise<CoachView> {
    const target = await this.requireUser(targetUserId);
    if (target.role !== Role.Coach) {
      throw new ConflictException({
        errorCode: ErrorCode.ROLE_MISMATCH,
        message: 'This user does not have a coach profile.',
      });
    }
    return this.coachesService.adminUpdateProfile(targetUserId, actor, input);
  }

  /** Super Admin edits a player's own (non-child) trainee profile fields. */
  async updatePlayerProfile(
    targetUserId: string,
    actor: Principal,
    input: UpdatePlayerProfileDto,
  ): Promise<AdminPlayerProfileView> {
    const target = await this.requireUser(targetUserId);
    if (target.role !== Role.PlayerParent) {
      throw new ConflictException({
        errorCode: ErrorCode.ROLE_MISMATCH,
        message: 'This user does not have a player profile.',
      });
    }
    if (input.birthDate !== undefined) {
      // Same floor as the self-service route: the age rule belongs to the
      // account, not to whoever is editing it.
      this.authService.assertOldEnoughForOwnAccount(input.birthDate);
    }

    const updated = await this.playersService.updateSelfProfile(targetUserId, input);
    if (!updated) {
      throw new NotFoundException({
        errorCode: ErrorCode.PLAYER_PROFILE_NOT_FOUND,
        message: 'This account has no self player profile — it may be a child login.',
      });
    }

    await this.audit.record({
      action: AUDIT_PLAYER_PROFILE_UPDATED,
      actor,
      targetUserId,
      target: { type: 'PlayerProfile', id: updated.id },
      metadata: { fields: changedFields(input) },
    });
    return AdminPlayerProfileView.from(updated);
  }

  /**
   * Permanent erasure: anonymise the user and every profile they own, mark them
   * Deleted, revoke sessions. The audit row keeps the original email and name as
   * the compliance record; everything else reads "Deleted User".
   */
  async deleteUser(
    targetUserId: string,
    actor: Principal,
    reason: string,
  ): Promise<UserSummaryDto> {
    const target = await this.requireUser(targetUserId);

    if (target.role === Role.SuperAdmin) {
      throw new ForbiddenException({
        errorCode: ErrorCode.CANNOT_DELETE_SUPER_ADMIN,
        message: 'Super Admin accounts cannot be deleted.',
      });
    }
    if (target.status === UserStatus.Deleted) {
      throw new ConflictException({
        errorCode: ErrorCode.ACCOUNT_DELETED,
        message: 'This user has already been deleted.',
      });
    }

    const now = this.clock.now();
    const photoPublicId = target.photoPublicId;
    // Captured before anonymisation: copies living outside `users` can only be
    // found by the original value.
    const originalEmail = target.email;

    // Cascades to the children's own logins, which would otherwise stay usable
    // with the child's name and email intact.
    const childUserIds = await this.playersService.childUserIdsByOwner(target.id);
    // Each child login has its own address to sweep out of those same copies.
    const erasedEmails = [
      originalEmail,
      ...(await this.usersService.findByIds(childUserIds)).map((u) => u.email),
    ];

    // Profile photos live outside `users` too — captured before anonymisation
    // wipes the column, same reason as photoPublicId above. Covers deleting a
    // parent (owned profiles) and deleting a child login directly (the profile
    // is owned by the parent, so it is found by childUserId instead).
    const ownedProfiles = await this.playersService.findByOwner(target.id);
    const childLoginProfile = await this.playersService.findByChildUserId(target.id);
    const profilePhotoPublicIds = [
      ...ownedProfiles.map((p) => p.photoPublicId),
      childLoginProfile?.photoPublicId ?? null,
    ].filter((id): id is string => id !== null);

    await this.dataSource.transaction(async (manager: EntityManager) => {
      const deletionLogs = manager.getRepository(UserDeletionLog);
      await deletionLogs.save(
        deletionLogs.create({
          userId: target.id,
          originalEmail: target.email,
          originalFirstName: target.firstName ?? null,
          originalLastName: target.lastName ?? null,
          originalPhone: target.phone ?? null,
          originalRole: target.role,
          deletedByUserId: actor.userId,
          reason,
          deletedAt: now,
          originalData: { childUserIds, hadPhoto: photoPublicId !== null },
        }),
      );

      await this.usersService.anonymize(target.id, manager);
      await this.playersService.anonymizeByOwner(target.id, manager);
      // A child's profile is owned by the parent, so the owner sweep above never
      // reaches it when the child's own account is the target.
      await this.playersService.anonymizeByChildUserId(target.id, manager);
      for (const childUserId of childUserIds) {
        await this.usersService.anonymize(childUserId, manager);
        await this.playersService.anonymizeByChildUserId(childUserId, manager);
      }

      // Copies outside `users`, matched on the pre-anonymisation values captured
      // above rather than rows this transaction has already rewritten.
      for (const email of erasedEmails) {
        await this.shareLinks.scrubTargetEmail(email, manager);
        await this.audit.scrubEmailFromMetadata(email, manager);
      }

      await this.audit.record(
        {
          action: AUDIT_USER_DELETED,
          actor,
          targetUserId: target.id,
          metadata: { reason, childAccountsAnonymized: childUserIds.length },
        },
        manager,
      );
    });

    await this.authService.revokeAllUserSessions(target.id, 'deleted');
    for (const childUserId of childUserIds) {
      await this.authService.revokeAllUserSessions(childUserId, 'parent-deleted');
    }

    // Outside the transaction: the storage provider is not transactional, and an
    // outage there must not roll back a recorded erasure.
    if (photoPublicId !== null) {
      await discardAsset(this.storage, photoPublicId, this.logger);
    }
    for (const publicId of profilePhotoPublicIds) {
      await discardAsset(this.storage, publicId, this.logger);
    }

    const updated = await this.requireUser(target.id);
    return UserSummaryDto.fromEntity(updated);
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
    const user = await this.usersService.findById(id);
    if (!user) {
      throw new NotFoundException({ errorCode: ErrorCode.NOT_FOUND, message: 'User not found.' });
    }
    return user;
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
