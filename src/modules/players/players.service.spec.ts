import { Repository } from 'typeorm';

import { PlayerProfile } from './entities/player-profile.entity';
import { PlayersService } from './players.service';

interface Stub {
  service: PlayersService;
  update: jest.Mock;
  findOne: jest.Mock;
}

function build(row: Partial<PlayerProfile> = { id: 'profile-1' }): Stub {
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const findOne = jest.fn().mockResolvedValue(row);
  const profiles = { update, findOne } as unknown as Repository<PlayerProfile>;
  return { service: new PlayersService(profiles), update, findOne };
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
  const profiles = { findOne, save } as unknown as Repository<PlayerProfile>;
  return { service: new PlayersService(profiles), findOne, save, row };
}

/**
 * The account holder's own profile. Same three-state partial-update rule as the
 * child path, plus one thing that only matters here: the lookup is scoped to
 * `isChild: false`, which is what keeps a child's row out of reach.
 */
describe('PlayersService.updateSelfProfile', () => {
  it('resolves only the non-child profile for the owner', async () => {
    const { service, findOne } = buildSelf();

    await service.updateSelfProfile('user-1', { displayName: 'Sam' });

    expect(findOne).toHaveBeenCalledWith({ where: { ownerUserId: 'user-1', isChild: false } });
  });

  it('writes a supplied birth date', async () => {
    const { service, save } = buildSelf();

    await service.updateSelfProfile('user-1', { birthDate: '1990-06-15' });

    expect(save.mock.calls[0][0]).toMatchObject({ birthDate: '1990-06-15' });
  });

  it('leaves the birth date alone when the caller does not mention it', async () => {
    const { service, save } = buildSelf();

    await service.updateSelfProfile('user-1', { school: 'Oakwood' });

    expect(save.mock.calls[0][0]).toMatchObject({
      birthDate: '1994-03-22',
      school: 'Oakwood',
    });
  });

  it('clears the nullable fields on an explicit null', async () => {
    const { service, save } = buildSelf();

    await service.updateSelfProfile('user-1', { school: null, jerseyNumber: null, gender: null });

    expect(save.mock.calls[0][0]).toMatchObject({
      school: null,
      jerseyNumber: null,
      gender: null,
      // Not swept up by the clears beside it.
      birthDate: '1994-03-22',
    });
  });

  it('returns null rather than creating anything when there is no self profile', async () => {
    const { service, save } = buildSelf({}, false);

    // ProfileService relies on this to decide whether to create one.
    const result = await service.updateSelfProfile('user-1', { birthDate: '1990-06-15' });

    expect(result).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('saves once, with the whole row', async () => {
    const { service, save } = buildSelf();

    await service.updateSelfProfile('user-1', { displayName: 'Sam', birthDate: '1990-06-15' });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      id: 'self-1',
      displayName: 'Sam',
      birthDate: '1990-06-15',
    });
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
