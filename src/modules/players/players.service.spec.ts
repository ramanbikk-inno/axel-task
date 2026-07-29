import { EntityManager, Repository } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import { Principal } from '../auth/principal';
import { PlayerProfile } from './entities/player-profile.entity';
import { AUDIT_PLAYER_PROFILE_UPDATED, PlayersService } from './players.service';

const auditStub = (record: jest.Mock): AuditService => ({ record }) as unknown as AuditService;

interface Stub {
  service: PlayersService;
  update: jest.Mock;
  findOne: jest.Mock;
}

function build(row: Partial<PlayerProfile> = { id: 'profile-1' }): Stub {
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const findOne = jest.fn().mockResolvedValue(row);
  const profiles = { update, findOne } as unknown as Repository<PlayerProfile>;
  return { service: new PlayersService(profiles, auditStub(jest.fn())), update, findOne };
}

/** The patch the repository is asked to apply, for the single update call made. */
const patchFrom = (update: jest.Mock): Record<string, unknown> =>
  update.mock.calls[0][1] as Record<string, unknown>;

/**
 * A partial update has to distinguish three states per field: absent (leave it),
 * a value (write it), and null (clear it). Collapsing the first two is how a
 * one-field PATCH silently blanks everything else, and collapsing the last two
 * is how a clear becomes a no-op — so the distinction is asserted directly on
 * the patch rather than inferred from a response body.
 */
describe('PlayersService.updateChildProfile', () => {
  it('writes only the keys the caller supplied', async () => {
    const { service, update } = build();

    await service.updateChildProfile('profile-1', { school: 'Riverside High' });

    expect(update).toHaveBeenCalledTimes(1);
    expect(patchFrom(update)).toEqual({ school: 'Riverside High' });
  });

  it('leaves an absent key out of the patch entirely', async () => {
    const { service, update } = build();

    await service.updateChildProfile('profile-1', {
      displayName: 'Maya',
      school: undefined,
      jerseyNumber: undefined,
    });

    // Not `{ displayName: 'Maya', school: undefined }` — an undefined in the
    // patch is a key TypeORM may still decide to write.
    expect(Object.keys(patchFrom(update))).toEqual(['displayName']);
  });

  it('carries an explicit null through, so a parent can clear a field', async () => {
    const { service, update } = build();

    await service.updateChildProfile('profile-1', {
      school: null,
      jerseyNumber: null,
      emergencyContact: null,
    });

    expect(patchFrom(update)).toEqual({
      school: null,
      jerseyNumber: null,
      emergencyContact: null,
    });
  });

  it('distinguishes clearing a field from not mentioning it, in one call', async () => {
    const { service, update } = build();

    await service.updateChildProfile('profile-1', { school: null, jerseyNumber: undefined });

    expect(patchFrom(update)).toEqual({ school: null });
  });

  it('does not touch the row at all when nothing was supplied', async () => {
    const { service, update, findOne } = build();

    await service.updateChildProfile('profile-1', {});

    expect(update).not.toHaveBeenCalled();
    // Still re-reads, so an empty PATCH is a well-formed no-op rather than an error.
    expect(findOne).toHaveBeenCalledWith({ where: { id: 'profile-1' } });
  });

  it('writes an emergency contact as a whole object', async () => {
    const { service, update } = build();
    const contact = { name: 'Jane Smith', phone: '+1 555 123 4567', relationship: 'Grandmother' };

    await service.updateChildProfile('profile-1', { emergencyContact: contact });

    expect(patchFrom(update)).toEqual({ emergencyContact: contact });
  });

  it('returns the re-read row rather than the patch it applied', async () => {
    const stored = { id: 'profile-1', displayName: 'Maya' } as PlayerProfile;
    const { service } = build(stored);

    const result = await service.updateChildProfile('profile-1', { displayName: 'Maya' });

    expect(result).toBe(stored);
  });

  it('targets the requested id and nothing else', async () => {
    const { service, update } = build();

    await service.updateChildProfile('profile-1', { gender: 'female' });

    expect(update.mock.calls[0][0]).toEqual({ id: 'profile-1' });
  });
});

interface SelfStub {
  service: PlayersService;
  findOne: jest.Mock;
  save: jest.Mock;
  auditRecord: jest.Mock;
  row: PlayerProfile;
}

function buildSelf(over: Partial<PlayerProfile> = {}, found = true): SelfStub {
  const row = {
    id: 'self-1',
    ownerUserId: 'user-1',
    isChild: false,
    displayName: 'Sam Smith',
    birthDate: '1994-03-22',
    gender: 'male',
    school: 'Riverside',
    jerseyNumber: '7',
    ...over,
  } as PlayerProfile;
  const findOne = jest.fn().mockResolvedValue(found ? row : null);
  const save = jest.fn().mockImplementation((p: PlayerProfile) => Promise.resolve(p));
  const auditRecord = jest.fn();
  const profiles = { findOne, save } as unknown as Repository<PlayerProfile>;
  return {
    service: new PlayersService(profiles, auditStub(auditRecord)),
    findOne,
    save,
    auditRecord,
    row,
  };
}

const ACTOR = { userId: 'user-1', sessionId: 'sess-1' } as Principal;

/** Scoped to isChild: false, keeping a child's row out of the owner's own profile lookup. */
describe('PlayersService.findSelfProfile', () => {
  it('resolves only the non-child profile for the owner', async () => {
    const { service, findOne } = buildSelf();

    await service.findSelfProfile('user-1');

    expect(findOne).toHaveBeenCalledWith({ where: { ownerUserId: 'user-1', isChild: false } });
  });

  it('returns null when the owner has no self profile', async () => {
    const { service } = buildSelf({}, false);

    await expect(service.findSelfProfile('user-1')).resolves.toBeNull();
  });
});

/**
 * Update and audit are one unit here, so neither the self-service nor the admin
 * route can edit a profile without leaving a record behind.
 */
describe('PlayersService.applyProfileUpdate', () => {
  it('writes only the keys the caller supplied', async () => {
    const { service, save, row } = buildSelf();

    await service.applyProfileUpdate(row, { school: 'Oakwood' }, ACTOR);

    expect(save.mock.calls[0][0]).toMatchObject({
      school: 'Oakwood',
      displayName: 'Sam Smith',
      birthDate: '1994-03-22',
    });
  });

  it('clears a nullable field on an explicit null', async () => {
    const { service, save, row } = buildSelf();

    await service.applyProfileUpdate(row, { school: null, emergencyContact: null }, ACTOR);

    expect(save.mock.calls[0][0]).toMatchObject({ school: null, emergencyContact: null });
  });

  it('records the update against the profile owner, naming the changed fields', async () => {
    const { service, auditRecord, row } = buildSelf();

    await service.applyProfileUpdate(row, { school: 'Oakwood', jerseyNumber: undefined }, ACTOR);

    expect(auditRecord).toHaveBeenCalledTimes(1);
    expect(auditRecord.mock.calls[0][0]).toEqual({
      action: AUDIT_PLAYER_PROFILE_UPDATED,
      actor: ACTOR,
      // The owner, not the actor: an admin or an impersonating session edits
      // somebody else's profile.
      targetUserId: 'user-1',
      target: { type: 'PlayerProfile', id: 'self-1' },
      metadata: { fields: ['school'] },
    });
  });

  it('audits only after the row is saved', async () => {
    const order: string[] = [];
    const { service, save, auditRecord, row } = buildSelf();
    save.mockImplementation((p: PlayerProfile) => {
      order.push('save');
      return Promise.resolve(p);
    });
    auditRecord.mockImplementation(() => {
      order.push('audit');
      return Promise.resolve(undefined);
    });

    await service.applyProfileUpdate(row, { school: 'Oakwood' }, ACTOR);

    expect(order).toEqual(['save', 'audit']);
  });

  it('runs the save and the audit row on a supplied transaction', async () => {
    const { service, save, auditRecord, row } = buildSelf();
    const txSave = jest.fn().mockImplementation((p: PlayerProfile) => Promise.resolve(p));
    const manager = {
      getRepository: jest.fn().mockReturnValue({ save: txSave }),
    } as unknown as EntityManager;

    await service.applyProfileUpdate(row, { school: 'Oakwood' }, ACTOR, manager);

    expect(txSave).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(auditRecord.mock.calls[0][1]).toBe(manager);
  });
});

describe('PlayersService.setSkillLevel', () => {
  it('records the trainer’s assessment', async () => {
    const { service, update } = build();

    await service.setSkillLevel('profile-1', 'Intermediate');

    expect(update).toHaveBeenCalledWith({ id: 'profile-1' }, { skillLevel: 'Intermediate' });
  });

  it('clears the assessment on null rather than skipping the write', async () => {
    const { service, update } = build();

    await service.setSkillLevel('profile-1', null);

    expect(update).toHaveBeenCalledWith({ id: 'profile-1' }, { skillLevel: null });
  });
});

describe('PlayersService.setPhoto', () => {
  it('writes both the url and the storage id', async () => {
    const { service, update } = build();

    await service.setPhoto('profile-1', { url: 'https://cdn/x.png', publicId: 'avatars/x' });

    expect(update).toHaveBeenCalledWith(
      { id: 'profile-1' },
      { photoUrl: 'https://cdn/x.png', photoPublicId: 'avatars/x' },
    );
  });

  it('nulls both fields together on removal', async () => {
    const { service, update } = build();

    await service.setPhoto('profile-1', null);

    expect(update).toHaveBeenCalledWith(
      { id: 'profile-1' },
      { photoUrl: null, photoPublicId: null },
    );
  });
});

describe('PlayersService anonymization', () => {
  it('clears a profile photo alongside the rest of the PII sweep', async () => {
    const { service, update } = build();

    await service.anonymizeByOwner('user-1');

    expect(update).toHaveBeenCalledWith(
      { ownerUserId: 'user-1' },
      expect.objectContaining({ photoUrl: null, photoPublicId: null }),
    );
  });
});
