import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../mail/mail.service';
import { Role, UserStatus } from '../users/entities/user.enums';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import { CreateTrainerDto } from './dto/create-trainer.dto';
import { ListUsersQueryDto } from './dto/list-users.query.dto';
import { PaginatedUsersDto, UserSummaryDto } from './dto/user-summary.dto';

export const AUDIT_TRAINER_CREATED = 'trainer.created';
export const AUDIT_USER_DEACTIVATED = 'user.deactivated';
export const AUDIT_USER_REACTIVATED = 'user.reactivated';
export const AUDIT_USER_UPDATED = 'user.updated';
export const AUDIT_USER_DELETED = 'user.deleted';

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
  ) {}

  async createTrainer(
    input: CreateTrainerDto,
    actorUserId?: string,
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
          actorUserId: actorUserId ?? null,
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
    actorUserId: string,
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
        actorUserId,
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
    actorUserId: string,
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
        actorUserId,
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
    actorUserId: string,
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
      actorUserId,
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
    actorUserId: string,
    reason?: string,
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

    const originalEmail = target.email;
    const originalName = [target.firstName, target.lastName]
      .filter((v) => v !== null && v !== undefined && v.trim() !== '')
      .join(' ');
    const originalPhone = target.phone;

    await this.dataSource.transaction(async (manager: EntityManager) => {
      await this.usersService.anonymize(target.id, manager);
      await this.playersService.anonymizeByOwner(target.id, manager);
      await this.audit.record(
        {
          action: AUDIT_USER_DELETED,
          actorUserId,
          targetUserId: target.id,
          metadata: { originalEmail, originalName, originalPhone, reason: reason ?? null },
        },
        manager,
      );
    });

    await this.authService.revokeAllUserSessions(target.id, 'deleted');

    const updated = await this.requireUser(target.id);
    return UserSummaryDto.fromEntity(updated);
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
