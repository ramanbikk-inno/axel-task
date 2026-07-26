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
