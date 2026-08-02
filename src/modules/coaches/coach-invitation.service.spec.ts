import { NotFoundException } from '@nestjs/common';
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
import { TrainerProfile } from '../trainers/entities/trainer-profile.entity';
import { TrainersService } from '../trainers/trainers.service';
import { User } from '../users/entities/user.entity';
import { Role } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import {
  AUDIT_COACH_INVITE_RESENT,
  AUDIT_COACH_INVITE_REVOKED,
  AUDIT_COACH_INVITED,
} from './coach-audit-actions';
import { CoachInvitationService } from './coach-invitation.service';
import { CoachProfileService } from './coach-profile.service';
import { AcceptCoachInviteDto, InviteCoachDto } from './dto/coach.dto';

const NOW = new Date('2024-01-01T00:00:00.000Z');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const PRINCIPAL: Principal = {
  userId: 'user-1',
  role: Role.Trainer,
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
};

const trainerProfile = (over: Partial<TrainerProfile> = {}): TrainerProfile =>
  ({
    id: 'trainer-1',
    userId: 'user-1',
    businessName: 'Acme Sports',
    ...over,
  }) as TrainerProfile;

const shareLink = (over: Partial<ShareLink> = {}): ShareLink =>
  ({
    id: 'link-1',
    trainerProfileId: 'trainer-1',
    code: 'code-abc',
    type: ShareLinkType.CoachUnique,
    targetEmail: 'coach@example.com',
    targetName: null,
    expiresAt: new Date(NOW.getTime() + SEVEN_DAYS_MS),
    maxUses: 1,
    useCount: 0,
    active: true,
    createdByUserId: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as ShareLink;

interface Stub {
  service: CoachInvitationService;
  manager: EntityManager;
  transaction: jest.Mock;
  requireOwnProfile: jest.Mock;
  findByIdTrainer: jest.Mock;
  assertNotActiveElsewhere: jest.Mock;
  startEngagement: jest.Mock;
  create: jest.Mock;
  findByTrainer: jest.Mock;
  findByIdLink: jest.Mock;
  deactivate: jest.Mock;
  evaluate: jest.Mock;
  findByCode: jest.Mock;
  lockForRedemption: jest.Mock;
  incrementUse: jest.Mock;
  createUnverifiedAccount: jest.Mock;
  findByEmail: jest.Mock;
  sendCoachInviteEmail: jest.Mock;
  sendVerificationEmail: jest.Mock;
  record: jest.Mock;
  hash: jest.Mock;
}

function build(): Stub {
  // A distinguishable, non-empty marker: proves the manager handed to a
  // transactional call is the *same* one the DataSource stub yields, not a
  // fresh mock object satisfying `expect.anything()` by accident.
  const manager = { __marker: 'tx-manager' } as unknown as EntityManager;
  const transaction = jest.fn(async (cb: (m: EntityManager) => Promise<unknown>) => cb(manager));
  const dataSource = { transaction } as unknown as DataSource;

  const requireOwnProfile = jest.fn().mockResolvedValue(trainerProfile());
  const findByIdTrainer = jest.fn().mockResolvedValue(trainerProfile());
  const trainersService = {
    requireOwnProfile,
    findById: findByIdTrainer,
  } as unknown as TrainersService;

  const assertNotActiveElsewhere = jest.fn().mockResolvedValue(undefined);
  const startEngagement = jest.fn().mockResolvedValue({ id: 'coach-profile-1' });
  const coachProfiles = {
    assertNotActiveElsewhere,
    startEngagement,
  } as unknown as CoachProfileService;

  const create = jest.fn().mockResolvedValue(shareLink());
  const findByTrainer = jest.fn().mockResolvedValue([]);
  const findByIdLink = jest.fn();
  const deactivate = jest.fn().mockResolvedValue(undefined);
  const evaluate = jest.fn().mockReturnValue({ ok: true, link: shareLink() });
  const findByCode = jest.fn();
  const lockForRedemption = jest.fn();
  const incrementUse = jest.fn().mockResolvedValue(undefined);
  const shareLinks = {
    create,
    findByTrainer,
    findById: findByIdLink,
    deactivate,
    evaluate,
    findByCode,
    lockForRedemption,
    incrementUse,
  } as unknown as ShareLinksService;

  const createUnverifiedAccount = jest.fn();
  const authService = { createUnverifiedAccount } as unknown as AuthService;

  const findByEmail = jest.fn().mockResolvedValue(null);
  const usersService = { findByEmail } as unknown as UsersService;

  const sendCoachInviteEmail = jest.fn().mockResolvedValue(undefined);
  const sendVerificationEmail = jest.fn().mockResolvedValue(undefined);
  const mail = { sendCoachInviteEmail, sendVerificationEmail } as unknown as MailService;

  const record = jest.fn().mockResolvedValue(undefined);
  const audit = { record } as unknown as AuditService;

  const now = jest.fn().mockReturnValue(NOW);
  const clock = { now } as unknown as ClockService;

  const hash = jest.fn().mockResolvedValue('hashed-password');
  const passwords = { hash } as unknown as PasswordService;

  const service = new CoachInvitationService(
    dataSource,
    trainersService,
    coachProfiles,
    shareLinks,
    authService,
    usersService,
    mail,
    audit,
    clock,
    passwords,
  );

  return {
    service,
    manager,
    transaction,
    requireOwnProfile,
    findByIdTrainer,
    assertNotActiveElsewhere,
    startEngagement,
    create,
    findByTrainer,
    findByIdLink,
    deactivate,
    evaluate,
    findByCode,
    lockForRedemption,
    incrementUse,
    createUnverifiedAccount,
    findByEmail,
    sendCoachInviteEmail,
    sendVerificationEmail,
    record,
    hash,
  };
}

describe('CoachInvitationService.invite', () => {
  const dto: InviteCoachDto = { email: 'coach@example.com', message: 'Join us!' };

  it('creates a single-use CoachUnique link, expiring in 7 days, for the invitee email', async () => {
    const { service, create } = build();
    create.mockResolvedValue(shareLink({ id: 'link-9', code: 'code-9' }));

    await service.invite(PRINCIPAL, dto);

    expect(create).toHaveBeenCalledWith({
      trainerProfileId: 'trainer-1',
      type: ShareLinkType.CoachUnique,
      createdByUserId: 'user-1',
      targetEmail: dto.email,
      targetName: null,
      expiresAt: new Date(NOW.getTime() + SEVEN_DAYS_MS),
      maxUses: 1,
    });
  });

  it('stores the optional invitee name when the trainer supplies one', async () => {
    const { service, create } = build();
    create.mockResolvedValue(shareLink({ id: 'link-9', code: 'code-9' }));

    await service.invite(PRINCIPAL, { ...dto, name: 'Jordan Lee' });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ targetName: 'Jordan Lee' }));
  });

  it('sends the invite email to the invitee, naming the trainer and carrying the optional message', async () => {
    const { service, create, sendCoachInviteEmail } = build();
    create.mockResolvedValue(shareLink({ code: 'code-9' }));

    await service.invite(PRINCIPAL, dto);

    expect(sendCoachInviteEmail).toHaveBeenCalledWith(
      'coach@example.com',
      'Acme Sports',
      'code-9',
      'Join us!',
    );
  });

  it('records AUDIT_COACH_INVITED against the newly created link', async () => {
    const { service, create, record } = build();
    create.mockResolvedValue(shareLink({ id: 'link-9' }));

    await service.invite(PRINCIPAL, dto);

    expect(record).toHaveBeenCalledWith({
      action: AUDIT_COACH_INVITED,
      actor: PRINCIPAL,
      target: { type: 'ShareLink', id: 'link-9' },
      metadata: { email: dto.email },
    });
  });

  it('returns a pending view built from the new link', async () => {
    const { service, create, evaluate } = build();
    const created = shareLink({ id: 'link-9', code: 'code-9', useCount: 0 });
    create.mockResolvedValue(created);
    evaluate.mockReturnValue({ ok: true, link: created });

    const result = await service.invite(PRINCIPAL, dto);

    expect(result).toEqual({
      id: 'link-9',
      code: 'code-9',
      email: dto.email,
      name: null,
      status: 'pending',
      expiresAt: created.expiresAt,
      createdAt: created.createdAt,
    });
  });
});

describe('CoachInvitationService.listInvitations', () => {
  it('returns only CoachUnique invitations, filtering out player links for the same trainer', async () => {
    const { service, findByTrainer, evaluate } = build();
    const coachInvite = shareLink({ id: 'coach-link', type: ShareLinkType.CoachUnique });
    const playerLink = shareLink({
      id: 'player-link',
      type: ShareLinkType.PlayerStatic,
      targetEmail: null,
    });
    findByTrainer.mockResolvedValue([coachInvite, playerLink]);
    evaluate.mockReturnValue({ ok: true, link: coachInvite });

    const result = await service.listInvitations(PRINCIPAL);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('coach-link');
  });

  it('scopes the lookup to the caller’s own trainer profile', async () => {
    const { service, findByTrainer, requireOwnProfile } = build();

    await service.listInvitations(PRINCIPAL);

    expect(requireOwnProfile).toHaveBeenCalledWith('user-1');
    expect(findByTrainer).toHaveBeenCalledWith('trainer-1');
  });
});

describe('CoachInvitationService.resendInvitation', () => {
  it.each([
    ['a link owned by a different trainer', { trainerProfileId: 'other-trainer' }],
    ['a link of the wrong type', { type: ShareLinkType.PlayerStatic }],
  ])('404s on %s, even though shareLinks.findById found a row', async (_label, over) => {
    const { service, findByIdLink } = build();
    findByIdLink.mockResolvedValue(shareLink(over));

    const promise = service.resendInvitation(PRINCIPAL, 'link-1');

    await expect(promise).rejects.toBeInstanceOf(NotFoundException);
    await expect(promise).rejects.toMatchObject({ response: { errorCode: ErrorCode.NOT_FOUND } });
  });

  it('refuses to resend an invitation that has already been accepted', async () => {
    const { service, findByIdLink } = build();
    findByIdLink.mockResolvedValue(shareLink({ useCount: 1 }));

    await expect(service.resendInvitation(PRINCIPAL, 'link-1')).rejects.toMatchObject({
      response: { errorCode: ErrorCode.INVITATION_ALREADY_ACCEPTED },
    });
  });

  it('refuses to resend an invitation with no recipient email', async () => {
    const { service, findByIdLink } = build();
    findByIdLink.mockResolvedValue(shareLink({ targetEmail: null }));

    await expect(service.resendInvitation(PRINCIPAL, 'link-1')).rejects.toMatchObject({
      response: { errorCode: ErrorCode.SHARE_LINK_INVALID },
    });
  });

  it('deactivates the old link and creates the replacement inside one transaction', async () => {
    const { service, findByIdLink, deactivate, create, manager } = build();
    const existing = shareLink({
      id: 'link-1',
      targetEmail: 'coach@example.com',
      targetName: 'Jordan Lee',
    });
    findByIdLink.mockResolvedValue(existing);
    create.mockResolvedValue(shareLink({ id: 'link-2', code: 'new-code' }));

    await service.resendInvitation(PRINCIPAL, 'link-1');

    expect(deactivate).toHaveBeenCalledWith('link-1', manager);
    expect(create).toHaveBeenCalledWith(
      {
        trainerProfileId: 'trainer-1',
        type: ShareLinkType.CoachUnique,
        createdByUserId: 'user-1',
        targetEmail: 'coach@example.com',
        // A resend must not lose the name the trainer typed.
        targetName: 'Jordan Lee',
        expiresAt: new Date(NOW.getTime() + SEVEN_DAYS_MS),
        maxUses: 1,
      },
      manager,
    );
  });

  it('deactivates the old link before minting the replacement', async () => {
    const { service, findByIdLink, deactivate, create } = build();
    findByIdLink.mockResolvedValue(shareLink({ id: 'link-1' }));
    const order: string[] = [];
    deactivate.mockImplementation(async () => {
      order.push('deactivate');
    });
    create.mockImplementation(async () => {
      order.push('create');
      return shareLink({ id: 'link-2' });
    });

    await service.resendInvitation(PRINCIPAL, 'link-1');

    expect(order).toEqual(['deactivate', 'create']);
  });

  it('sends the new invite to the same email as the original', async () => {
    const { service, findByIdLink, create, sendCoachInviteEmail } = build();
    findByIdLink.mockResolvedValue(
      shareLink({ id: 'link-1', targetEmail: 'original@example.com' }),
    );
    create.mockResolvedValue(shareLink({ id: 'link-2', code: 'new-code' }));

    await service.resendInvitation(PRINCIPAL, 'link-1');

    expect(sendCoachInviteEmail).toHaveBeenCalledWith(
      'original@example.com',
      'Acme Sports',
      'new-code',
    );
  });

  it('records AUDIT_COACH_INVITE_RESENT, naming the replaced link', async () => {
    const { service, findByIdLink, create, record } = build();
    findByIdLink.mockResolvedValue(
      shareLink({ id: 'link-1', targetEmail: 'original@example.com' }),
    );
    create.mockResolvedValue(shareLink({ id: 'link-2' }));

    await service.resendInvitation(PRINCIPAL, 'link-1');

    expect(record).toHaveBeenCalledWith({
      action: AUDIT_COACH_INVITE_RESENT,
      actor: PRINCIPAL,
      target: { type: 'ShareLink', id: 'link-2' },
      metadata: { email: 'original@example.com', replaced: 'link-1' },
    });
  });

  // requireOwnInvitation checks owner + type only, never `active` — a revoked
  // (deactivated, never-used) invitation still clears every resend guard and
  // is silently reactivated under a new code. Documented as current behavior;
  // see the final report for why this looks like a gap rather than a choice.
  it('does not block resending a revoked-but-unused invitation (current behavior)', async () => {
    const { service, findByIdLink, create, deactivate } = build();
    findByIdLink.mockResolvedValue(shareLink({ id: 'link-1', active: false, useCount: 0 }));
    create.mockResolvedValue(shareLink({ id: 'link-2' }));

    await expect(service.resendInvitation(PRINCIPAL, 'link-1')).resolves.toBeDefined();
    expect(deactivate).toHaveBeenCalledWith('link-1', expect.anything());
  });
});

describe('CoachInvitationService.revokeInvitation', () => {
  it.each([
    ['a link owned by a different trainer', { trainerProfileId: 'other-trainer' }],
    ['a link of the wrong type', { type: ShareLinkType.PlayerStatic }],
  ])('404s on %s, even though shareLinks.findById found a row', async (_label, over) => {
    const { service, findByIdLink } = build();
    findByIdLink.mockResolvedValue(shareLink(over));

    await expect(service.revokeInvitation(PRINCIPAL, 'link-1')).rejects.toMatchObject({
      response: { errorCode: ErrorCode.NOT_FOUND },
    });
  });

  it('refuses to revoke an invitation that has already been accepted', async () => {
    const { service, findByIdLink } = build();
    findByIdLink.mockResolvedValue(shareLink({ useCount: 1 }));

    await expect(service.revokeInvitation(PRINCIPAL, 'link-1')).rejects.toMatchObject({
      response: { errorCode: ErrorCode.INVITATION_ALREADY_ACCEPTED },
    });
  });

  it('deactivates the link and records AUDIT_COACH_INVITE_REVOKED', async () => {
    const { service, findByIdLink, deactivate, record } = build();
    findByIdLink.mockResolvedValue(shareLink({ id: 'link-1', targetEmail: 'coach@example.com' }));

    await service.revokeInvitation(PRINCIPAL, 'link-1');

    expect(deactivate).toHaveBeenCalledWith('link-1');
    expect(record).toHaveBeenCalledWith({
      action: AUDIT_COACH_INVITE_REVOKED,
      actor: PRINCIPAL,
      target: { type: 'ShareLink', id: 'link-1' },
      metadata: { email: 'coach@example.com' },
    });
  });

  it('re-reads the link to build the returned view, calling findById twice', async () => {
    const { service, findByIdLink, evaluate } = build();
    const before = shareLink({ id: 'link-1', active: true });
    const after = shareLink({ id: 'link-1', active: false, code: 'unchanged-code' });
    findByIdLink.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    // Deactivation happens on the mock, not the fixture: evaluate is stubbed to
    // report what a real (now-inactive) row would.
    evaluate.mockReturnValue({ ok: false, reason: 'revoked' });

    const result = await service.revokeInvitation(PRINCIPAL, 'link-1');

    expect(findByIdLink).toHaveBeenCalledTimes(2);
    expect(findByIdLink).toHaveBeenNthCalledWith(1, 'link-1');
    expect(findByIdLink).toHaveBeenNthCalledWith(2, 'link-1');
    expect(result.status).toBe('expired');
  });
});

describe('CoachInvitationService.resolve', () => {
  it('returns invalid with no details when the code resolves to no link', async () => {
    const { service, findByCode, findByIdTrainer } = build();
    findByCode.mockResolvedValue(null);

    await expect(service.resolve('nope')).resolves.toEqual({
      valid: false,
      email: null,
      trainerName: null,
    });
    expect(findByIdTrainer).not.toHaveBeenCalled();
  });

  it.each(['wrong-type', 'revoked'] as const)(
    'hides the email when the link is not ok for reason "%s"',
    async (reason) => {
      const { service, findByCode, evaluate, findByIdTrainer } = build();
      findByCode.mockResolvedValue(shareLink());
      evaluate.mockReturnValue({ ok: false, reason });

      await expect(service.resolve('code')).resolves.toEqual({
        valid: false,
        email: null,
        trainerName: null,
      });
      expect(findByIdTrainer).not.toHaveBeenCalled();
    },
  );

  it.each(['expired', 'exhausted'] as const)(
    'still names the sender when the link is merely "%s"',
    async (reason) => {
      const { service, findByCode, evaluate, findByIdTrainer } = build();
      findByCode.mockResolvedValue(shareLink({ targetEmail: 'coach@example.com' }));
      evaluate.mockReturnValue({ ok: false, reason });
      findByIdTrainer.mockResolvedValue(trainerProfile({ businessName: 'Acme Sports' }));

      await expect(service.resolve('code')).resolves.toEqual({
        valid: false,
        email: 'coach@example.com',
        trainerName: 'Acme Sports',
      });
    },
  );

  it('returns valid with full details for a usable link', async () => {
    const { service, findByCode, evaluate, findByIdTrainer } = build();
    const link = shareLink({ targetEmail: 'coach@example.com' });
    findByCode.mockResolvedValue(link);
    evaluate.mockReturnValue({ ok: true, link });
    findByIdTrainer.mockResolvedValue(trainerProfile({ businessName: 'Acme Sports' }));

    await expect(service.resolve('code')).resolves.toEqual({
      valid: true,
      email: 'coach@example.com',
      trainerName: 'Acme Sports',
    });
  });

  it('falls back to a null trainerName when the trainer profile no longer exists', async () => {
    const { service, findByCode, evaluate, findByIdTrainer } = build();
    const link = shareLink();
    findByCode.mockResolvedValue(link);
    evaluate.mockReturnValue({ ok: true, link });
    findByIdTrainer.mockResolvedValue(null);

    const result = await service.resolve('code');

    expect(result.trainerName).toBeNull();
  });
});

describe('CoachInvitationService.accept', () => {
  const dto: AcceptCoachInviteDto = {
    password: 'Str0ngPassw0rd!',
    firstName: 'Jamie',
    lastName: 'Lee',
  };

  it('hashes the password once, before the transaction opens', async () => {
    const { service, hash, lockForRedemption, findByEmail } = build();
    const order: string[] = [];
    hash.mockImplementation(async () => {
      order.push('hash');
      return 'hashed-pw';
    });
    lockForRedemption.mockImplementation(async () => {
      order.push('lock');
      return shareLink({ targetEmail: 'coach@example.com' });
    });
    findByEmail.mockResolvedValue({
      id: 'user-2',
      email: 'coach@example.com',
      role: Role.Coach,
    } as User);

    await service.accept('code-1', dto);

    expect(order).toEqual(['hash', 'lock']);
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it('still hashes the password even when the transaction fails immediately', async () => {
    const { service, hash, lockForRedemption } = build();
    lockForRedemption.mockRejectedValue(new NotFoundException('invite gone'));

    await expect(service.accept('code-1', dto)).rejects.toThrow();
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it('locks the link for redemption, scoped to CoachUnique, inside the transaction', async () => {
    const { service, lockForRedemption, findByEmail, manager } = build();
    lockForRedemption.mockResolvedValue(shareLink({ targetEmail: 'coach@example.com' }));
    findByEmail.mockResolvedValue({
      id: 'user-2',
      email: 'coach@example.com',
      role: Role.Coach,
    } as User);

    await service.accept('code-1', dto);

    expect(lockForRedemption).toHaveBeenCalledWith('code-1', ShareLinkType.CoachUnique, manager);
  });

  it('rejects a locked link that carries no target email', async () => {
    const { service, lockForRedemption, findByEmail } = build();
    lockForRedemption.mockResolvedValue(shareLink({ targetEmail: null }));

    await expect(service.accept('code-1', dto)).rejects.toMatchObject({
      response: { errorCode: ErrorCode.SHARE_LINK_INVALID },
    });
    expect(findByEmail).not.toHaveBeenCalled();
  });

  describe('when an account with that email already exists', () => {
    it('refuses a non-coach account with EMAIL_ALREADY_EXISTS', async () => {
      const { service, lockForRedemption, findByEmail, assertNotActiveElsewhere } = build();
      lockForRedemption.mockResolvedValue(shareLink({ targetEmail: 'existing@example.com' }));
      findByEmail.mockResolvedValue({
        id: 'user-3',
        email: 'existing@example.com',
        role: Role.PlayerParent,
      } as User);

      await expect(service.accept('code-1', dto)).rejects.toMatchObject({
        response: { errorCode: ErrorCode.EMAIL_ALREADY_EXISTS },
      });
      expect(assertNotActiveElsewhere).not.toHaveBeenCalled();
    });

    it('re-homes an existing coach without creating a new account or sending a verification email', async () => {
      const {
        service,
        lockForRedemption,
        findByEmail,
        assertNotActiveElsewhere,
        startEngagement,
        incrementUse,
        sendVerificationEmail,
        createUnverifiedAccount,
        manager,
      } = build();
      const link = shareLink({
        id: 'link-1',
        trainerProfileId: 'trainer-9',
        targetEmail: 'existing@example.com',
      });
      lockForRedemption.mockResolvedValue(link);
      findByEmail.mockResolvedValue({
        id: 'user-2',
        email: 'existing@example.com',
        role: Role.Coach,
      } as User);

      const result = await service.accept('code-1', dto);

      expect(assertNotActiveElsewhere).toHaveBeenCalledWith('user-2', 'trainer-9', manager);
      expect(startEngagement).toHaveBeenCalledWith('user-2', 'trainer-9', manager);
      expect(incrementUse).toHaveBeenCalledWith('link-1', manager);
      expect(createUnverifiedAccount).not.toHaveBeenCalled();
      expect(sendVerificationEmail).not.toHaveBeenCalled();
      expect(result).toEqual({ message: 'You have joined this trainer. Sign in as usual.' });
    });
  });

  describe('when no account exists for that email', () => {
    it('creates an unverified Coach account, starts the engagement, and emails the verification token', async () => {
      const {
        service,
        lockForRedemption,
        findByEmail,
        createUnverifiedAccount,
        startEngagement,
        incrementUse,
        sendVerificationEmail,
        hash,
        manager,
      } = build();
      const link = shareLink({
        id: 'link-1',
        trainerProfileId: 'trainer-9',
        targetEmail: 'new@example.com',
      });
      lockForRedemption.mockResolvedValue(link);
      findByEmail.mockResolvedValue(null);
      const newUser = { id: 'user-4', email: 'new@example.com', role: Role.Coach } as User;
      createUnverifiedAccount.mockResolvedValue({ user: newUser, verificationToken: 'verify-tok' });

      const result = await service.accept('code-1', dto);

      expect(hash).toHaveBeenCalledWith(dto.password);
      expect(createUnverifiedAccount).toHaveBeenCalledWith(
        {
          email: 'new@example.com',
          passwordHash: 'hashed-password',
          role: Role.Coach,
          firstName: dto.firstName,
          lastName: dto.lastName,
        },
        manager,
      );
      expect(startEngagement).toHaveBeenCalledWith('user-4', 'trainer-9', manager);
      expect(incrementUse).toHaveBeenCalledWith('link-1', manager);
      expect(sendVerificationEmail).toHaveBeenCalledWith('new@example.com', 'verify-tok');
      expect(result).toEqual({
        message: 'Coach account created. Verify your email to finish joining.',
      });
    });
  });
});
