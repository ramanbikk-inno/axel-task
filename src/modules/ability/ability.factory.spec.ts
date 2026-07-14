import { AbilityFactory, Action, AppAbility } from './ability.factory';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';

describe('AbilityFactory', () => {
  const factory = new AbilityFactory();

  const principalFor = (over: Partial<Principal>): Principal => ({
    userId: 'admin-1',
    role: Role.SuperAdmin,
    sessionId: 's1',
    activeTrainerProfileId: null,
    trainerOrgId: null,
    tokenVersion: 0,
    scope: 'platform',
    impersonating: false,
    ...over,
  });

  describe('SuperAdmin', () => {
    let ability: AppAbility;
    beforeEach(() => {
      ability = factory.createForPrincipal(principalFor({}));
    });

    it('can manage all subjects', () => {
      expect(ability.can(Action.Manage, 'all')).toBe(true);
      expect(ability.can(Action.Create, 'User')).toBe(true);
      expect(ability.can(Action.Read, 'TrainerOrg')).toBe(true);
    });

    it('cannot impersonate a User whose role is SuperAdmin', () => {
      expect(ability.cannot(Action.Impersonate, { __type: 'User', role: Role.SuperAdmin })).toBe(
        true,
      );
    });

    it('can impersonate a non-SuperAdmin User that is not self', () => {
      expect(
        ability.can(Action.Impersonate, { __type: 'User', id: 'other', role: Role.Trainer }),
      ).toBe(true);
    });

    it('cannot impersonate self', () => {
      expect(
        ability.cannot(Action.Impersonate, { __type: 'User', id: 'admin-1', role: Role.Trainer }),
      ).toBe(true);
    });
  });

  describe('Trainer', () => {
    let ability: AppAbility;
    beforeEach(() => {
      ability = factory.createForPrincipal(
        principalFor({
          userId: 'trainer-user-1',
          role: Role.Trainer,
          trainerOrgId: 'org-1',
          scope: 'trainer',
        }),
      );
    });

    it('can read a User in its own org', () => {
      expect(ability.can(Action.Read, { __type: 'User', trainerOrgId: 'org-1' })).toBe(true);
    });

    it('cannot read a User in a different org', () => {
      expect(ability.can(Action.Read, { __type: 'User', trainerOrgId: 'org-2' })).toBe(false);
    });

    it('cannot manage all', () => {
      expect(ability.can(Action.Manage, 'all')).toBe(false);
    });
  });

  describe('Coach / PlayerParent (M1 skeleton: no broad grants yet)', () => {
    it('Coach cannot manage all', () => {
      const ability = factory.createForPrincipal(
        principalFor({ role: Role.Coach, scope: 'trainer', trainerOrgId: 'org-1' }),
      );
      expect(ability.can(Action.Manage, 'all')).toBe(false);
    });

    it('PlayerParent cannot create a User', () => {
      const ability = factory.createForPrincipal(
        principalFor({ role: Role.PlayerParent, scope: 'trainer' }),
      );
      expect(ability.can(Action.Create, 'User')).toBe(false);
    });
  });
});
