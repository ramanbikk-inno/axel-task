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
    activePlayerProfileId: null,
    trainerOrgId: null,
    coachProfileId: null,
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

  describe('Coach', () => {
    let ability: AppAbility;
    beforeEach(() => {
      ability = factory.createForPrincipal(
        principalFor({
          userId: 'coach-user-1',
          role: Role.Coach,
          trainerOrgId: 'org-1',
          coachProfileId: 'coach-profile-1',
          scope: 'trainer',
        }),
      );
    });

    it('can read and update its own coach profile', () => {
      const own = { __type: 'CoachProfile', userId: 'coach-user-1', trainerOrgId: 'org-1' };
      expect(ability.can(Action.Read, own)).toBe(true);
      expect(ability.can(Action.Update, own)).toBe(true);
    });

    it('cannot touch another coach’s profile in the same org', () => {
      const other = { __type: 'CoachProfile', userId: 'coach-user-2', trainerOrgId: 'org-1' };
      expect(ability.can(Action.Read, other)).toBe(false);
      expect(ability.can(Action.Update, other)).toBe(false);
    });

    it('can manage its own availability only', () => {
      // Keyed on availability_slots.coach_profile_id, the column the row
      // actually carries — a condition on a userId the table does not store
      // would read like a scope but match nothing.
      expect(
        ability.can(Action.Manage, { __type: 'Availability', coachProfileId: 'coach-profile-1' }),
      ).toBe(true);
      expect(
        ability.can(Action.Manage, { __type: 'Availability', coachProfileId: 'coach-profile-2' }),
      ).toBe(false);
    });

    it('is granted nothing over availability when its profile is unresolved', () => {
      const unresolved = factory.createForPrincipal(
        principalFor({ userId: 'coach-user-1', role: Role.Coach, scope: 'trainer' }),
      );

      expect(
        unresolved.can(Action.Manage, {
          __type: 'Availability',
          coachProfileId: 'coach-profile-1',
        }),
      ).toBe(false);
    });

    it('scopes org reads to the employer resolved from coach_profiles', () => {
      // A Coach's trainerOrgId comes from their employer's row; when the
      // session validator left it null every rule below silently matched
      // nothing.
      expect(ability.can(Action.Read, { __type: 'PlayerProfile', trainerOrgId: 'org-1' })).toBe(
        true,
      );
      expect(ability.can(Action.Read, { __type: 'Branding', trainerOrgId: 'org-1' })).toBe(true);
      expect(ability.can(Action.Read, { __type: 'TrainerOrg', id: 'org-1' })).toBe(true);
    });

    it('is view-only over the roster of the trainer it works for', () => {
      const player = { __type: 'PlayerProfile', trainerOrgId: 'org-1' };
      expect(ability.can(Action.Read, player)).toBe(true);
      expect(ability.can(Action.Update, player)).toBe(false);
    });

    it('cannot see another trainer’s roster', () => {
      expect(ability.can(Action.Read, { __type: 'PlayerProfile', trainerOrgId: 'org-2' })).toBe(
        false,
      );
    });

    it('cannot run the organisation', () => {
      expect(ability.can(Action.Manage, 'ShareLink')).toBe(false);
      expect(ability.can(Action.Manage, 'TrainerPlayerAssociation')).toBe(false);
      expect(ability.can(Action.Manage, 'User')).toBe(false);
      expect(ability.can(Action.Manage, 'all')).toBe(false);
    });
  });

  describe('PlayerParent', () => {
    let ability: AppAbility;
    beforeEach(() => {
      ability = factory.createForPrincipal(
        principalFor({ userId: 'parent-1', role: Role.PlayerParent, scope: 'trainer' }),
      );
    });

    it('can read and update the profiles it owns (self and children)', () => {
      const own = { __type: 'PlayerProfile', ownerUserId: 'parent-1' };
      expect(ability.can(Action.Read, own)).toBe(true);
      expect(ability.can(Action.Update, own)).toBe(true);
    });

    it('cannot read another family’s profile', () => {
      const other = { __type: 'PlayerProfile', ownerUserId: 'parent-2' };
      expect(ability.can(Action.Read, other)).toBe(false);
      expect(ability.can(Action.Update, other)).toBe(false);
    });

    it('can manage availability at type level, with row ownership left to the service', () => {
      // availability_slots stores playerProfileId, not ownerUserId, so CASL
      // cannot express the join to player_profiles. The previous condition on
      // ownerUserId matched no real row. AvailabilityService.requireOwnedProfile
      // is what actually enforces ownership.
      expect(ability.can(Action.Manage, 'Availability')).toBe(true);
      expect(ability.can(Action.Manage, { __type: 'Availability', playerProfileId: 'p1' })).toBe(
        true,
      );
    });

    it('can join and leave trainers for its own profiles', () => {
      const own = { __type: 'TrainerPlayerAssociation', ownerUserId: 'parent-1' };
      expect(ability.can(Action.Create, own)).toBe(true);
      expect(ability.can(Action.Delete, own)).toBe(true);
    });

    it('cannot alter another family’s association', () => {
      expect(
        ability.can(Action.Delete, { __type: 'TrainerPlayerAssociation', ownerUserId: 'parent-2' }),
      ).toBe(false);
    });

    it('cannot mint ShareLinks, manage coaches or create users', () => {
      expect(ability.can(Action.Manage, 'ShareLink')).toBe(false);
      expect(ability.can(Action.Manage, 'CoachProfile')).toBe(false);
      expect(ability.can(Action.Create, 'User')).toBe(false);
      expect(ability.can(Action.Manage, 'all')).toBe(false);
    });
  });

  describe('org scoping depends on a real trainerOrgId', () => {
    it('grants a Trainer nothing across orgs when their org is unresolved', () => {
      // trainerOrgId used to be hardcoded null everywhere, so this was the
      // ability every Trainer actually got.
      const ability = factory.createForPrincipal(
        principalFor({ role: Role.Trainer, trainerOrgId: null, scope: 'trainer' }),
      );

      expect(ability.can(Action.Read, { __type: 'User', trainerOrgId: 'org-1' })).toBe(false);
      expect(ability.can(Action.Manage, { __type: 'ShareLink', trainerOrgId: 'org-1' })).toBe(
        false,
      );
    });
  });
});
