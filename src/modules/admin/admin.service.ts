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
import { Principal } from '../auth/principal';
import { AuthService } from '../auth/auth.service';
import { ShareLinksService } from '../enrollment/share-links.service';
import { MailService } from '../mail/mail.service';
import { Role, UserStatus } from '../users/entities/user.enums';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { PlayersService } from '../players/players.service';
import { STORAGE, StorageService } from '../storage/storage.service';
import { TrainersService } from '../trainers/trainers.service';
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
    // Previously any non-SuperAdmin role was accepted and then quietly
    // overwritten with Trainer, so POST /users {role:'Coach'} returned 201
    // describing an account that was never created. Coaches are invited by
    // their trainer, not minted here.
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

      // Audit log: who created the trainer, when, and the trainer details.
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
   * Soft-deactivate a user (US-01.12): flips status to Inactive, revokes their
   * active sessions so they are logged out, and records the action. All
   * historical data is preserved. Super Admin accounts (including the caller)
   * cannot be deactivated to avoid locking the platform out.
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

    // Without this, Deleted -> deactivate -> Inactive -> reactivate -> Active
    // walks a GDPR-deleted account back to life past the guard on reactivate.
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

  /**
   * Reactivate a previously deactivated user (US-01.12). Deleted (anonymized)
   * users cannot be reactivated (US-01.13 — deletion is permanent).
   */
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

  /** Super Admin edits any user's common profile fields (US-01.11). */
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
      metadata: {
        fields: Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined),
      },
    });
    return UserSummaryDto.fromEntity(updated);
  }

  /**
   * GDPR delete (US-01.13): permanently anonymize a user's PII (and the PII on
   * every player profile they own), mark them Deleted, revoke sessions, and
   * write a compliance record to the audit log (original email/name preserved
   * there for legal purposes). Historical references become "Deleted User".
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
    // Captured before anonymisation overwrites the column: the copies of this
    // address living outside `users` can only be found by the original value.
    const originalEmail = target.email;

    // Cascades to the children's own logins. A parent's erasure that left
    // their child's account signed-in-able, with the child's name and email
    // still on it, would not be an erasure of the family's data at all.
    const childUserIds = await this.playersService.childUserIdsByOwner(target.id);
    // A child login carries its own address, so the family's erasure has to
    // sweep those out of the same off-`users` copies.
    const erasedEmails = [
      originalEmail,
      ...(await this.usersService.findByIds(childUserIds)).map((u) => u.email),
    ];

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
      // Covers the target being a child login rather than a parent: that
      // profile is owned by the parent, so the owner sweep above never reaches
      // it and the child's name, birth date, school and emergency contact
      // would survive their own erasure.
      await this.playersService.anonymizeByChildUserId(target.id, manager);
      for (const childUserId of childUserIds) {
        await this.usersService.anonymize(childUserId, manager);
        await this.playersService.anonymizeByChildUserId(childUserId, manager);
      }

      // Copies of the address that live outside `users`. These take the
      // pre-anonymisation values, which is why they run against the emails
      // captured above rather than re-reading rows this transaction just wrote.
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

    // Outside the transaction: the provider is not transactional, and an
    // outage there must not roll back an erasure that is already recorded.
    if (photoPublicId !== null) {
      await this.discardAsset(photoPublicId);
    }

    const updated = await this.requireUser(target.id);
    return UserSummaryDto.fromEntity(updated);
  }

  /** Best-effort: the erasure is already committed, so an outage costs an orphan. */
  private async discardAsset(publicId: string): Promise<void> {
    try {
      await this.storage.delete(publicId);
    } catch (error) {
      this.logger.warn(
        `Orphaned stored asset ${publicId} after GDPR deletion: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
