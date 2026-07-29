import { In, Repository } from 'typeorm';

import { Principal } from '../auth/principal';
import {
  AssociationStatus,
  TrainerPlayerAssociation,
} from '../enrollment/entities/trainer-player-association.entity';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { Role } from '../users/entities/user.enums';
import { OrgMembershipService } from './org-membership.service';

const ORG = 'trainer-org-1';

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

/** Only ids matter here, so the rest of the profile stays unset. */
const profile = (id: string): PlayerProfile => ({ id }) as PlayerProfile;

describe('OrgMembershipService', () => {
  let count: jest.Mock;
  let findByOwner: jest.Mock;
  let service: OrgMembershipService;

  beforeEach(() => {
    count = jest.fn().mockResolvedValue(0);
    findByOwner = jest.fn().mockResolvedValue([]);
    service = new OrgMembershipService(
      { count } as unknown as Repository<TrainerPlayerAssociation>,
      { findByOwner } as unknown as PlayersService,
    );
  });

  it('lets a SuperAdmin through without touching the database', async () => {
    await expect(service.isOrgMember(principal({ role: Role.SuperAdmin }), ORG)).resolves.toBe(
      true,
    );
    expect(count).not.toHaveBeenCalled();
    expect(findByOwner).not.toHaveBeenCalled();
  });

  it.each([Role.Trainer, Role.Coach])('compares %s against the resolved org', async (role) => {
    await expect(service.isOrgMember(principal({ role, trainerOrgId: ORG }), ORG)).resolves.toBe(
      true,
    );
    await expect(
      service.isOrgMember(principal({ role, trainerOrgId: 'other-org' }), ORG),
    ).resolves.toBe(false);
    // A Coach whose engagement ended has no org at all.
    await expect(service.isOrgMember(principal({ role, trainerOrgId: null }), ORG)).resolves.toBe(
      false,
    );
    expect(count).not.toHaveBeenCalled();
  });

  it('resolves a parent through the profiles they own', async () => {
    findByOwner.mockResolvedValue([profile('p-1'), profile('p-2')]);
    count.mockResolvedValue(1);

    await expect(service.isOrgMember(principal(), ORG)).resolves.toBe(true);
    expect(findByOwner).toHaveBeenCalledWith('user-1');
    expect(count).toHaveBeenCalledWith({
      where: {
        trainerProfileId: ORG,
        playerProfileId: In(['p-1', 'p-2']),
        status: AssociationStatus.Active,
      },
    });
  });

  it('resolves a child through childPlayerProfileId, never the owning parent', async () => {
    count.mockResolvedValue(1);
    const child = principal({ isChild: true, childPlayerProfileId: 'p-child', userId: 'child-1' });

    await expect(service.isOrgMember(child, ORG)).resolves.toBe(true);
    // Owner lookup would return the parent's whole set, letting a child see a
    // sibling's org.
    expect(findByOwner).not.toHaveBeenCalled();
    expect(count.mock.calls[0][0].where.playerProfileId).toEqual(In(['p-child']));
  });

  it('refuses a child login with no profile attached', async () => {
    const child = principal({ isChild: true, childPlayerProfileId: null });

    await expect(service.isOrgMember(child, ORG)).resolves.toBe(false);
    expect(count).not.toHaveBeenCalled();
  });

  it('refuses a player whose only association is inactive', async () => {
    findByOwner.mockResolvedValue([profile('p-1')]);
    // The Active filter runs in the database, so an inactive-only player counts 0.
    count.mockResolvedValue(0);

    await expect(service.isOrgMember(principal(), ORG)).resolves.toBe(false);
  });

  it('refuses a player who owns no profiles at all', async () => {
    await expect(service.isOrgMember(principal(), ORG)).resolves.toBe(false);
    expect(count).not.toHaveBeenCalled();
  });
});
