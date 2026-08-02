import { Injectable } from '@nestjs/common';
import {
  AbilityBuilder,
  createMongoAbility,
  ExtractSubjectType,
  MongoAbility,
  MongoQuery,
} from '@casl/ability';

import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';

export enum Action {
  Manage = 'manage',
  Create = 'create',
  Read = 'read',
  Update = 'update',
  Delete = 'delete',
  Impersonate = 'impersonate',
}

export type Subjects =
  | 'User'
  | 'PlayerProfile'
  | 'CoachProfile'
  | 'TrainerOrg'
  | 'ShareLink'
  | 'Availability'
  | 'TrainerPlayerAssociation'
  | 'PurchaseApproval'
  | 'ImpersonationLog'
  | 'Branding'
  | 'all';

export type AppAbility = MongoAbility<[Action, Subjects | Record<string, unknown>]>;

type Can = AbilityBuilder<AppAbility>['can'];
type Cannot = AbilityBuilder<AppAbility>['cannot'];

/**
 * NOT the enforcement layer. These rules are consulted only where a route
 * declares `@CheckPolicies` and lists `PoliciesGuard` — today that is the
 * impersonation route alone. Everywhere else, access is decided by `@Roles`,
 * `NotAChildGuard` and the ownership checks inside each service.
 *
 * PoliciesGuard cannot be registered globally to close that gap: global guards
 * run before the controller-scoped `JwtAuthGuard`, so it would read a principal
 * that is not on the request yet.
 *
 * The practical rule when editing this file: a `can` that no route reaches
 * grants nothing and misleads the next reader — add the route or drop the rule.
 * A `cannot` is worth keeping regardless, as a standing denial for whatever
 * consults it later.
 */
@Injectable()
export class AbilityFactory {
  /**
   * A child shares the PlayerParent role but not its permissions: the parent
   * rules key on `ownerUserId`, which matches nothing for a child login. Every
   * rule here keys on `childPlayerProfileId`, so none can reach a sibling.
   */
  private applyChildRules(principal: Principal, can: Can, cannot: Cannot): void {
    const ownProfile: MongoQuery = { id: principal.childPlayerProfileId } as MongoQuery;
    const ownAssociations: MongoQuery = {
      playerProfileId: principal.childPlayerProfileId,
    } as MongoQuery;

    // "View own training progress", "Update basic profile info".
    can(Action.Read, 'PlayerProfile', ownProfile);
    can(Action.Update, 'PlayerProfile', ownProfile);
    // "Switch between trainer contexts (if trains with multiple trainers)",
    // read-only: the child sees their own contexts and cannot change them.
    can(Action.Read, 'TrainerPlayerAssociation', ownAssociations);
    can(Action.Read, 'Branding');
    // Unconditioned; AvailabilityService.requireAccessibleProfile does the narrowing.
    can(Action.Manage, 'Availability');

    // "Add new trainers (ShareLink registration blocked)" and "Change trainer
    // associations". Written as explicit `cannot` rather than simply omitted:
    // a later `can` added to a shared branch cannot silently grant these.
    cannot(Action.Create, 'TrainerPlayerAssociation');
    cannot(Action.Update, 'TrainerPlayerAssociation');
    cannot(Action.Delete, 'TrainerPlayerAssociation');
    // "Delete their account", and no creating siblings or sub-profiles.
    cannot(Action.Create, 'PlayerProfile');
    cannot(Action.Delete, 'PlayerProfile');
    cannot(Action.Manage, 'User');
    cannot(Action.Manage, 'ShareLink');
    cannot(Action.Manage, 'CoachProfile');
    // "Purchase tokens", "Complete purchases without parent approval".
    cannot(Action.Create, 'PurchaseApproval');
    cannot(Action.Update, 'PurchaseApproval');
  }

  createForPrincipal(principal: Principal): AppAbility {
    const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

    switch (principal.role) {
      case Role.SuperAdmin: {
        can(Action.Manage, 'all');
        cannot(Action.Impersonate, 'User', { role: Role.SuperAdmin } as MongoQuery);
        cannot(Action.Impersonate, 'User', { id: principal.userId } as MongoQuery);
        break;
      }

      case Role.Trainer: {
        // principal.trainerOrgId is resolved per request from trainer_profiles.
        // It used to be hardcoded null at every token-issue site, which meant
        // every rule below was scoped to a null org and matched nothing.
        const orgScope: MongoQuery = { trainerOrgId: principal.trainerOrgId } as MongoQuery;
        can(Action.Read, 'User', orgScope);
        // No Update on 'User': editing an account is a Super Admin function
        // (PATCH /users/:id), and a trainer edits their org through the roster
        // and CoachProfile rules below.
        can(Action.Manage, 'TrainerPlayerAssociation', orgScope);
        can(Action.Read, 'PlayerProfile', orgScope);
        can(Action.Read, 'Availability', orgScope);
        can(Action.Manage, 'CoachProfile', orgScope);
        can(Action.Manage, 'ShareLink', orgScope);
        can(Action.Manage, 'Branding', orgScope);
        can(Action.Read, 'TrainerOrg', { id: principal.trainerOrgId } as MongoQuery);
        break;
      }

      case Role.Coach: {
        // A Coach works for exactly one trainer, is view-only on most features,
        // and may edit their own profile and availability. Their org comes from
        // coach_profiles.trainer_profile_id, resolved per request.
        const ownProfile: MongoQuery = { userId: principal.userId } as MongoQuery;
        const orgScope: MongoQuery = { trainerOrgId: principal.trainerOrgId } as MongoQuery;

        can(Action.Read, 'CoachProfile', ownProfile);
        can(Action.Update, 'CoachProfile', ownProfile);
        // Keyed on the real column (availability_slots.coach_profile_id), per
        // design 15.3: conditions must match what the row actually stores.
        can(Action.Manage, 'Availability', {
          coachProfileId: principal.coachProfileId,
        } as MongoQuery);

        // No Read on 'PlayerProfile': the roster route is trainer-only, and a
        // coach-facing roster belongs to Epic-03. Restore this with the route,
        // not before it.
        can(Action.Read, 'TrainerOrg', { id: principal.trainerOrgId } as MongoQuery);
        can(Action.Read, 'Branding', orgScope);

        // Running the organisation is the trainer's job, not the coach's.
        cannot(Action.Manage, 'ShareLink');
        cannot(Action.Manage, 'TrainerPlayerAssociation');
        cannot(Action.Manage, 'User');
        break;
      }

      case Role.PlayerParent: {
        if (principal.isChild) {
          this.applyChildRules(principal, can, cannot);
          break;
        }

        // Self-service over the profiles this account owns — the parent's own
        // profile and each child's.
        const owned: MongoQuery = { ownerUserId: principal.userId } as MongoQuery;

        can(Action.Read, 'PlayerProfile', owned);
        can(Action.Update, 'PlayerProfile', owned);
        can(Action.Create, 'PlayerProfile');
        // Unconditioned on purpose: availability_slots stores playerProfileId,
        // not ownerUserId, and CASL cannot express the join to player_profiles.
        // A condition on ownerUserId would read as a scope but match no row.
        // The owner check runs in AvailabilityService.requireOwnedProfile.
        can(Action.Manage, 'Availability');

        // Joining a trainer is allowed; nothing here lets them read or alter
        // another family's association.
        can(Action.Create, 'TrainerPlayerAssociation', owned);
        can(Action.Read, 'TrainerPlayerAssociation', owned);
        can(Action.Delete, 'TrainerPlayerAssociation', owned);

        // Branding of a trainer they actually train with is readable; the
        // association check itself lives in the service, which knows the list.
        can(Action.Read, 'Branding');

        cannot(Action.Manage, 'ShareLink');
        cannot(Action.Manage, 'CoachProfile');
        cannot(Action.Manage, 'User');
        break;
      }

      default: {
        break;
      }
    }

    return build({
      detectSubjectType: (subject) =>
        (subject as { __type?: ExtractSubjectType<Subjects> }).__type ??
        (subject as unknown as ExtractSubjectType<Subjects>),
    });
  }
}
