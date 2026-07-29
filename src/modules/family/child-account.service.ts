import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { PasswordService } from '../../shared/crypto/password.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { Role, UserStatus } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import { ChildLoginStatusView, ChildLoginView } from './dto/child-login.dto';

export const AUDIT_CHILD_LOGIN_CREATED = 'family.child-login-created';
export const AUDIT_CHILD_LOGIN_REVOKED = 'family.child-login-revoked';

/**
 * The credential lifecycle of a child profile — minting a login, revoking it,
 * and reporting whether one exists. Password hashing, `users` rows and session
 * revocation have nothing to do with the profile/trainer orchestration in
 * FamilyService, which is the only caller.
 *
 * Every method takes an already-resolved profile: the ownership check stays in
 * FamilyService.requireOwnedProfile, so there is still exactly one of it.
 */
@Injectable()
export class ChildAccountService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Give a child profile its own login. The account is an ordinary PlayerParent;
   * what makes it a child is `player_profiles.child_user_id` pointing at it. The
   * link is unique and a CHECK refuses it on a profile that is not a child.
   */
  async createLogin(
    actor: Principal,
    profile: PlayerProfile,
    input: { email: string; password: string },
  ): Promise<ChildLoginView> {
    if (!profile.isChild) {
      throw new BadRequestException({
        errorCode: ErrorCode.NOT_A_CHILD_PROFILE,
        message: 'Only a child profile can be given its own login.',
      });
    }
    if (profile.childUserId !== null) {
      throw new ConflictException({
        errorCode: ErrorCode.CHILD_LOGIN_EXISTS,
        message: 'This child already has a login.',
      });
    }

    const existing = await this.usersService.findByEmail(input.email);
    if (existing) {
      // Not enumeration-sensitive: the caller is an authenticated parent
      // choosing an address, and a silent no-op here would leave them thinking
      // the login was created.
      throw new ConflictException({
        errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
        message: 'An account with this email already exists.',
      });
    }

    const passwordHash = await this.passwords.hash(input.password);
    const childUser = await this.dataSource.transaction(async (manager: EntityManager) => {
      const created = await this.usersService.create(
        {
          email: input.email,
          role: Role.PlayerParent,
          passwordHash,
          firstName: profile.displayName,
          // The parent vouching for the address is the verification; there is
          // no separate mailbox to confirm.
          emailVerified: true,
          mustSetPassword: false,
          status: UserStatus.Active,
        },
        manager,
      );
      await manager
        .getRepository(PlayerProfile)
        .update({ id: profile.id }, { childUserId: created.id });
      return created;
    });

    await this.audit.record({
      action: AUDIT_CHILD_LOGIN_CREATED,
      actor,
      targetUserId: childUser.id,
      target: { type: 'PlayerProfile', id: profile.id },
    });

    return {
      playerProfileId: profile.id,
      displayName: profile.displayName,
      childUserId: childUser.id,
      email: childUser.email,
    };
  }

  /**
   * Revoke a child's login. The profile stays; only the ability to sign in as
   * it goes away, along with every session currently doing so — otherwise a
   * live child session keeps working for up to its refresh lifetime after the
   * parent has withdrawn access.
   */
  async revokeLogin(actor: Principal, profile: PlayerProfile): Promise<void> {
    if (profile.childUserId === null) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'This child does not have a login.',
      });
    }

    const childUserId = profile.childUserId;
    await this.dataSource.transaction(async (manager: EntityManager) => {
      await manager.getRepository(PlayerProfile).update({ id: profile.id }, { childUserId: null });
      await this.usersService.setStatus(childUserId, UserStatus.Inactive, manager);
    });
    await this.auth.revokeAllUserSessions(childUserId, 'child-login-revoked');
    await this.audit.record({
      action: AUDIT_CHILD_LOGIN_REVOKED,
      actor,
      targetUserId: childUserId,
      target: { type: 'PlayerProfile', id: profile.id },
    });
  }

  async loginStatus(profile: PlayerProfile): Promise<ChildLoginStatusView> {
    if (profile.childUserId === null) {
      return { hasLogin: false };
    }
    const user = await this.usersService.findById(profile.childUserId);
    return user ? { hasLogin: true, childUserId: user.id, email: user.email } : { hasLogin: false };
  }
}
