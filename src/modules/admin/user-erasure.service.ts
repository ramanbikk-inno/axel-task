import { ConflictException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { CoachProfileService } from '../coaches/coach-profile.service';
import { ShareLinksService } from '../enrollment/share-links.service';
import { PlayersService } from '../players/players.service';
import { discardAsset } from '../storage/discard-asset';
import { STORAGE, StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { UserStatus, Role } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import { UserSummaryDto } from './dto/user-summary.dto';
import { UserDeletionLog } from './entities/user-deletion-log.entity';
import { requireUser } from './require-user';

export const AUDIT_USER_DELETED = 'user.deleted';

/**
 * GDPR erasure, split out of AdminService: one compliance-critical cascade
 * rather than a 128-line method sitting between CRUD calls.
 */
@Injectable()
export class UserErasureService {
  private readonly logger = new Logger(UserErasureService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
    private readonly playersService: PlayersService,
    private readonly shareLinks: ShareLinksService,
    @Inject(STORAGE) private readonly storage: StorageService,
    private readonly clock: ClockService,
    private readonly coachProfiles: CoachProfileService,
  ) {}

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
    const target = await requireUser(this.usersService, targetUserId);

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
    // with the child's name and email intact. Captured before anonymisation, same
    // reason as `originalEmail` above: each child gets its own compliance record.
    //
    // Erasing a child login does not clear `child_user_id`, so an already-erased
    // child is still listed here. Skipping it is what keeps this idempotent: its
    // deletion-log row exists, and the unique index on user_id would reject a
    // second one and roll the parent's erasure back.
    const childUsers = (
      await this.usersService.findByIds(await this.playersService.childUserIdsByOwner(target.id))
    ).filter((u) => u.status !== UserStatus.Deleted);
    const childUserIds = childUsers.map((u) => u.id);
    // Each child login has its own address to sweep out of those same copies.
    const erasedEmails = [originalEmail, ...childUsers.map((u) => u.email)];

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
      const logErasure = (
        user: User,
        originalData: Record<string, unknown> | null,
      ): Promise<UserDeletionLog> =>
        deletionLogs.save(
          deletionLogs.create({
            userId: user.id,
            originalEmail: user.email,
            originalFirstName: user.firstName ?? null,
            originalLastName: user.lastName ?? null,
            originalPhone: user.phone ?? null,
            originalRole: user.role,
            deletedByUserId: actor.userId,
            reason,
            deletedAt: now,
            originalData,
          }),
        );

      await logErasure(target, { childUserIds, hadPhoto: photoPublicId !== null });
      // Each cascaded child login is itself a deleted user under §8's compliance
      // requirement — the primary target's row alone doesn't cover their address.
      for (const childUser of childUsers) {
        await logErasure(childUser, { cascadedFromUserId: target.id });
      }

      await this.usersService.anonymize(target.id, manager);
      await this.playersService.anonymizeByOwner(target.id, manager);
      // A child's profile is owned by the parent, so the owner sweep above never
      // reaches it when the child's own account is the target.
      await this.playersService.anonymizeByChildUserId(target.id, manager);
      // No-op unless the target ever held a coach engagement — clears bio,
      // credentials and certifications that would otherwise outlive the erasure.
      await this.coachProfiles.anonymizeByUserId(target.id, manager);
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

    const updated = await requireUser(this.usersService, target.id);
    return UserSummaryDto.fromEntity(updated);
  }
}
