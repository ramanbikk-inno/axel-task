import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { PasswordService } from '../../shared/crypto/password.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AgeGateService } from '../../shared/registration/age-gate.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { MailService } from '../mail/mail.service';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import { Role } from '../users/entities/user.enums';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AssociationsService } from './associations.service';
import { JoinRegisterDto } from './dto/join-register.dto';
import { ShareLinkType } from './entities/share-link.entity';
import { AssociationStatus } from './entities/trainer-player-association.entity';
import { AUDIT_ENROLLMENT_JOINED, AUDIT_ENROLLMENT_REGISTERED, JoinService } from './join.service';
import { ShareLinksService } from './share-links.service';

const CODE = 'share-code-1';
/** A sentinel so tests can assert the manager handed into the transaction is reused. */
const MANAGER = {} as EntityManager;

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    role: Role.PlayerParent,
    sessionId: 'session-1',
    activeTrainerProfileId: null,
    activePlayerProfileId: null,
    trainerOrgId: null,
    coachProfileId: null,
    isChild: false,
    childPlayerProfileId: null,
    parentUserId: null,
    tokenVersion: 0,
    scope: 'trainer',
    impersonating: false,
    ...over,
  };
}

describe('JoinService.registerViaShareLink', () => {
  const registerDto = (over: Partial<JoinRegisterDto> = {}): JoinRegisterDto => ({
    email: 'new.player@example.com',
    password: 'Sup3r$ecretPW1',
    firstName: 'New',
    lastName: 'Player',
    birthDate: '1994-03-22',
    ...over,
  });

  function build(): {
    service: JoinService;
    assertOldEnough: jest.Mock;
    hash: jest.Mock;
    transaction: jest.Mock;
    lockForRedemption: jest.Mock;
    incrementUse: jest.Mock;
    findByEmail: jest.Mock;
    createUnverifiedPlayer: jest.Mock;
    create: jest.Mock;
    associate: jest.Mock;
    sendVerificationEmail: jest.Mock;
    sendJoinConfirmationEmail: jest.Mock;
    recordSystemAction: jest.Mock;
    record: jest.Mock;
  } {
    const assertOldEnough = jest.fn();
    const hash = jest.fn().mockResolvedValue('hashed-pw');
    const transaction = jest
      .fn()
      .mockImplementation((cb: (m: EntityManager) => Promise<unknown>) => cb(MANAGER));
    const lockForRedemption = jest
      .fn()
      .mockResolvedValue({ id: 'link-1', trainerProfileId: 'trainer-1' });
    const incrementUse = jest.fn().mockResolvedValue(undefined);
    const findByEmail = jest.fn().mockResolvedValue(null);
    const createUnverifiedPlayer = jest.fn().mockResolvedValue({
      user: { id: 'user-1', email: 'new.player@example.com' } as User,
      verificationToken: 'verify-token-1',
    });
    const create = jest.fn().mockResolvedValue({ id: 'profile-1' } as PlayerProfile);
    const associate = jest
      .fn()
      .mockResolvedValue({ association: { id: 'assoc-1' }, created: true });
    const findById = jest.fn().mockResolvedValue({ id: 'trainer-1', businessName: 'Ace Tennis' });
    const sendVerificationEmail = jest.fn().mockResolvedValue(undefined);
    const sendJoinConfirmationEmail = jest.fn().mockResolvedValue(undefined);
    const recordSystemAction = jest.fn().mockResolvedValue(undefined);
    const record = jest.fn();

    const service = new JoinService(
      { transaction } as unknown as DataSource,
      { createUnverifiedPlayer } as unknown as AuthService,
      { assertOldEnoughForOwnAccount: assertOldEnough } as unknown as AgeGateService,
      { findByEmail } as unknown as UsersService,
      { create } as unknown as PlayersService,
      { findById } as unknown as TrainersService,
      { lockForRedemption, incrementUse } as unknown as ShareLinksService,
      { associate } as unknown as AssociationsService,
      { sendVerificationEmail, sendJoinConfirmationEmail } as unknown as MailService,
      { recordSystemAction, record } as unknown as AuditService,
      { hash } as unknown as PasswordService,
    );

    return {
      service,
      assertOldEnough,
      hash,
      transaction,
      lockForRedemption,
      incrementUse,
      findByEmail,
      createUnverifiedPlayer,
      create,
      associate,
      sendVerificationEmail,
      sendJoinConfirmationEmail,
      recordSystemAction,
      record,
    };
  }

  it('checks the age floor before hashing the password or opening a transaction', async () => {
    const { service, assertOldEnough, hash, transaction } = build();
    assertOldEnough.mockImplementation(() => {
      throw new ForbiddenException({ errorCode: ErrorCode.UNDERAGE_SELF_REGISTRATION });
    });

    await expect(service.registerViaShareLink(CODE, registerDto())).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(hash).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('throws EMAIL_ALREADY_EXISTS from inside the transaction, without creating anything', async () => {
    const { service, findByEmail, lockForRedemption, create, associate, incrementUse } = build();
    findByEmail.mockResolvedValue({ id: 'existing-user' } as User);

    try {
      await service.registerViaShareLink(CODE, registerDto());
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
      });
    }

    // Locked and read before the email check, so the rejection still proves
    // the code was of the right link type.
    expect(lockForRedemption).toHaveBeenCalledWith(CODE, ShareLinkType.PlayerStatic, MANAGER);
    expect(create).not.toHaveBeenCalled();
    expect(associate).not.toHaveBeenCalled();
    expect(incrementUse).not.toHaveBeenCalled();
  });

  it('creates the account and association inside the transaction, then audits and emails outside it', async () => {
    const {
      service,
      assertOldEnough,
      hash,
      transaction,
      lockForRedemption,
      createUnverifiedPlayer,
      create,
      associate,
      incrementUse,
      recordSystemAction,
      record,
      sendVerificationEmail,
      sendJoinConfirmationEmail,
    } = build();
    const order: string[] = [];
    assertOldEnough.mockImplementation(() => order.push('age-gate'));
    hash.mockImplementation(async () => {
      order.push('hash');
      return 'hashed-pw';
    });
    transaction.mockImplementation(async (cb: (m: EntityManager) => Promise<unknown>) => {
      order.push('transaction-start');
      const result = await cb(MANAGER);
      order.push('transaction-end');
      return result;
    });
    recordSystemAction.mockImplementation(async () => {
      order.push('audit');
    });
    sendVerificationEmail.mockImplementation(async () => {
      order.push('verification-email');
    });
    sendJoinConfirmationEmail.mockImplementation(async () => {
      order.push('join-email');
    });

    const result = await service.registerViaShareLink(CODE, registerDto());

    // Audit and mail wait for the commit; a public registration must not act
    // on a write a later step inside the transaction could still roll back.
    expect(order).toEqual([
      'age-gate',
      'hash',
      'transaction-start',
      'transaction-end',
      'audit',
      'verification-email',
      'join-email',
    ]);

    expect(lockForRedemption).toHaveBeenCalledWith(CODE, ShareLinkType.PlayerStatic, MANAGER);
    expect(createUnverifiedPlayer).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new.player@example.com', passwordHash: 'hashed-pw' }),
      MANAGER,
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'user-1', isChild: false, gender: null }),
      MANAGER,
    );
    expect(associate).toHaveBeenCalledWith(
      { trainerProfileId: 'trainer-1', playerProfileId: 'profile-1', shareLinkId: 'link-1' },
      MANAGER,
    );
    expect(incrementUse).toHaveBeenCalledWith('link-1', MANAGER);

    // recordSystemAction, not record: there is no authenticated principal on
    // this public endpoint, and the new account is the target, not the actor.
    expect(recordSystemAction).toHaveBeenCalledWith({
      action: AUDIT_ENROLLMENT_REGISTERED,
      targetUserId: 'user-1',
      target: { type: 'TrainerOrg', id: 'trainer-1' },
      metadata: { playerProfileId: 'profile-1' },
    });
    expect(record).not.toHaveBeenCalled();

    expect(sendVerificationEmail).toHaveBeenCalledWith('new.player@example.com', 'verify-token-1');
    expect(sendJoinConfirmationEmail).toHaveBeenCalledWith('new.player@example.com', 'Ace Tennis');

    expect(result.playerProfileIds).toEqual(['profile-1']);
  });
});

describe('JoinService.eligibleMembers', () => {
  function build(): {
    service: JoinService;
    requireUsable: jest.Mock;
    lockForRedemption: jest.Mock;
    findByOwner: jest.Mock;
    findByPlayerProfiles: jest.Mock;
  } {
    const requireUsable = jest.fn().mockResolvedValue({ trainerProfileId: 'trainer-1' });
    const lockForRedemption = jest.fn();
    const findById = jest.fn().mockResolvedValue({ id: 'trainer-1', businessName: 'Ace Tennis' });
    const findByOwner = jest.fn().mockResolvedValue([]);
    const findByPlayerProfiles = jest.fn().mockResolvedValue([]);

    const service = new JoinService(
      {} as DataSource,
      {} as AuthService,
      {} as AgeGateService,
      {} as UsersService,
      { findByOwner } as unknown as PlayersService,
      { findById } as unknown as TrainersService,
      { requireUsable, lockForRedemption } as unknown as ShareLinksService,
      { findByPlayerProfiles } as unknown as AssociationsService,
      {} as MailService,
      {} as AuditService,
      {} as PasswordService,
    );

    return { service, requireUsable, lockForRedemption, findByOwner, findByPlayerProfiles };
  }

  it('reads the link with the non-locking check, not the redemption lock', async () => {
    const { service, requireUsable, lockForRedemption } = build();

    await service.eligibleMembers(CODE, principal());

    expect(requireUsable).toHaveBeenCalledWith(CODE, ShareLinkType.PlayerStatic);
    expect(lockForRedemption).not.toHaveBeenCalled();
  });

  it('orders self before children regardless of the order findByOwner returns them in', async () => {
    const { service, findByOwner } = build();
    findByOwner.mockResolvedValue([
      { id: 'child-1', displayName: 'Kid', isChild: true },
      { id: 'self-1', displayName: 'Parent', isChild: false },
    ] as PlayerProfile[]);

    const result = await service.eligibleMembers(CODE, principal());

    expect(result.members.map((m) => m.playerProfileId)).toEqual(['self-1', 'child-1']);
    expect(result.members[0].isChild).toBe(false);
    expect(result.members[1].isChild).toBe(true);
  });

  it("marks alreadyAssociated only for an active association with this link's trainer", async () => {
    const { service, findByOwner, findByPlayerProfiles } = build();
    findByOwner.mockResolvedValue([
      { id: 'self-1', displayName: 'Self', isChild: false },
      { id: 'child-1', displayName: 'Child One', isChild: true },
      { id: 'child-2', displayName: 'Child Two', isChild: true },
    ] as PlayerProfile[]);
    findByPlayerProfiles.mockResolvedValue([
      {
        playerProfileId: 'self-1',
        trainerProfileId: 'trainer-1',
        status: AssociationStatus.Active,
      },
      // Active, but with a different trainer than this link's.
      {
        playerProfileId: 'child-1',
        trainerProfileId: 'other-trainer',
        status: AssociationStatus.Active,
      },
      // This link's trainer, but the association itself is inactive.
      {
        playerProfileId: 'child-2',
        trainerProfileId: 'trainer-1',
        status: AssociationStatus.Inactive,
      },
    ]);

    const result = await service.eligibleMembers(CODE, principal());

    const alreadyAssociatedById = new Map(
      result.members.map((m) => [m.playerProfileId, m.alreadyAssociated]),
    );
    expect(alreadyAssociatedById.get('self-1')).toBe(true);
    expect(alreadyAssociatedById.get('child-1')).toBe(false);
    expect(alreadyAssociatedById.get('child-2')).toBe(false);
  });
});

describe('JoinService.joinAsExistingPlayer', () => {
  function build(): {
    service: JoinService;
    findUserById: jest.Mock;
    findSelfProfile: jest.Mock;
    findByOwner: jest.Mock;
    createProfile: jest.Mock;
    findPlayerProfileById: jest.Mock;
    transaction: jest.Mock;
    lockForRedemption: jest.Mock;
    incrementUse: jest.Mock;
    findByCode: jest.Mock;
    evaluate: jest.Mock;
    associate: jest.Mock;
    sendChildJoinRequestEmail: jest.Mock;
    record: jest.Mock;
  } {
    const findUserById = jest.fn();
    const findSelfProfile = jest.fn();
    const findByOwner = jest.fn().mockResolvedValue([]);
    const createProfile = jest.fn();
    const findPlayerProfileById = jest.fn();
    const transaction = jest
      .fn()
      .mockImplementation((cb: (m: EntityManager) => Promise<unknown>) => cb(MANAGER));
    const lockForRedemption = jest
      .fn()
      .mockResolvedValue({ id: 'link-1', trainerProfileId: 'trainer-1' });
    const incrementUse = jest.fn().mockResolvedValue(undefined);
    const findByCode = jest.fn();
    const evaluate = jest.fn();
    const associate = jest.fn();
    const sendChildJoinRequestEmail = jest.fn().mockResolvedValue(undefined);
    const record = jest.fn().mockResolvedValue(undefined);
    const findTrainerById = jest
      .fn()
      .mockResolvedValue({ id: 'trainer-1', businessName: 'Ace Tennis' });

    const service = new JoinService(
      { transaction } as unknown as DataSource,
      {} as AuthService,
      {} as AgeGateService,
      { findById: findUserById } as unknown as UsersService,
      {
        findSelfProfile,
        findByOwner,
        create: createProfile,
        findById: findPlayerProfileById,
      } as unknown as PlayersService,
      { findById: findTrainerById } as unknown as TrainersService,
      { lockForRedemption, incrementUse, findByCode, evaluate } as unknown as ShareLinksService,
      { associate } as unknown as AssociationsService,
      { sendChildJoinRequestEmail } as unknown as MailService,
      { record } as unknown as AuditService,
      {} as PasswordService,
    );

    return {
      service,
      findUserById,
      findSelfProfile,
      findByOwner,
      createProfile,
      findPlayerProfileById,
      transaction,
      lockForRedemption,
      incrementUse,
      findByCode,
      evaluate,
      associate,
      sendChildJoinRequestEmail,
      record,
    };
  }

  it('blocks a child, still attempts the parent notification when mail fails, and throws CHILD_CANNOT_ADD_TRAINER', async () => {
    const {
      service,
      findUserById,
      findByCode,
      evaluate,
      findPlayerProfileById,
      sendChildJoinRequestEmail,
      lockForRedemption,
      transaction,
    } = build();
    const child = principal({
      userId: 'child-user-1',
      isChild: true,
      parentUserId: 'parent-1',
      childPlayerProfileId: 'child-profile-1',
    });
    findUserById.mockResolvedValue({ id: 'parent-1', email: 'parent@example.com' } as User);
    findByCode.mockResolvedValue({
      id: 'link-1',
      code: CODE,
      trainerProfileId: 'trainer-1',
      type: ShareLinkType.PlayerStatic,
    });
    evaluate.mockReturnValue({ ok: true, link: { trainerProfileId: 'trainer-1' } });
    findPlayerProfileById.mockResolvedValue({
      id: 'child-profile-1',
      displayName: 'Kid',
    } as PlayerProfile);
    // Best-effort: a mail outage must not turn the 403 into an unrelated 500.
    sendChildJoinRequestEmail.mockRejectedValue(new Error('smtp is down'));

    await expect(service.joinAsExistingPlayer(CODE, child)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(sendChildJoinRequestEmail).toHaveBeenCalledTimes(1);

    try {
      await service.joinAsExistingPlayer(CODE, child);
      fail('expected throw');
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        errorCode: ErrorCode.CHILD_CANNOT_ADD_TRAINER,
      });
    }

    expect(lockForRedemption).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('404s a profile id the caller does not own, before the link is even locked', async () => {
    const { service, findByOwner, lockForRedemption, transaction } = build();
    findByOwner.mockResolvedValue([{ id: 'owned-1' } as PlayerProfile]);

    try {
      await service.joinAsExistingPlayer(CODE, principal(), ['owned-1', 'not-owned']);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toMatchObject({
        errorCode: ErrorCode.NOT_FOUND,
      });
    }

    expect(lockForRedemption).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  const fallbackCases: Array<[string, string[] | undefined]> = [
    ['omitted', undefined],
    ['an empty array', []],
  ];

  it.each(fallbackCases)(
    'creates a self profile on demand when playerProfileIds is %s and none exists yet',
    async (_label, ids) => {
      const { service, findSelfProfile, findUserById, createProfile, associate } = build();
      findSelfProfile.mockResolvedValue(null);
      findUserById.mockResolvedValue({
        id: 'user-1',
        email: 'player@example.com',
        firstName: null,
        lastName: null,
      } as User);
      createProfile.mockResolvedValue({ id: 'self-1' } as PlayerProfile);
      associate.mockResolvedValue({ association: { id: 'assoc-1' }, created: true });

      const result = await service.joinAsExistingPlayer(CODE, principal(), ids);

      expect(createProfile).toHaveBeenCalledWith(
        { ownerUserId: 'user-1', displayName: 'player@example.com', isChild: false },
        MANAGER,
      );
      expect(result.playerProfileIds).toEqual(['self-1']);
    },
  );

  it('reuses an existing self profile instead of creating one', async () => {
    const { service, findSelfProfile, createProfile, associate } = build();
    findSelfProfile.mockResolvedValue({ id: 'self-existing' } as PlayerProfile);
    associate.mockResolvedValue({ association: { id: 'assoc-1' }, created: false });

    const result = await service.joinAsExistingPlayer(CODE, principal(), undefined);

    expect(createProfile).not.toHaveBeenCalled();
    expect(result.playerProfileIds).toEqual(['self-existing']);
  });

  it('connects exactly once when every requested association is newly created, and reports being newly connected', async () => {
    const { service, findByOwner, associate, incrementUse, record } = build();
    findByOwner.mockResolvedValue([{ id: 'p1' } as PlayerProfile, { id: 'p2' } as PlayerProfile]);
    associate.mockResolvedValue({ association: { id: 'assoc-x' }, created: true });

    const result = await service.joinAsExistingPlayer(CODE, principal(), ['p1', 'p2']);

    expect(associate).toHaveBeenCalledTimes(2);
    // One use per redemption, not one per connected family member.
    expect(incrementUse).toHaveBeenCalledTimes(1);
    expect(incrementUse).toHaveBeenCalledWith('link-1', MANAGER);
    expect(result.message).toBe('You are now connected with this trainer.');
    expect(result.playerProfileIds).toEqual(['p1', 'p2']);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ENROLLMENT_JOINED }),
    );
  });

  it('does not spend the link again when every association already existed, and reports being already connected', async () => {
    const { service, findByOwner, associate, incrementUse } = build();
    findByOwner.mockResolvedValue([{ id: 'p1' } as PlayerProfile, { id: 'p2' } as PlayerProfile]);
    associate.mockResolvedValue({ association: { id: 'assoc-x' }, created: false });

    const result = await service.joinAsExistingPlayer(CODE, principal(), ['p1', 'p2']);

    expect(incrementUse).not.toHaveBeenCalled();
    expect(result.message).toBe('You are already connected with this trainer.');
  });
});
