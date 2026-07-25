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

@Injectable()
export class AbilityFactory {
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
        can(Action.Update, 'User', orgScope);
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
        // Spec section 6: a Coach works for exactly one trainer, is view-only on
        // most features, and may edit their own profile and availability.
        const ownProfile: MongoQuery = { userId: principal.userId } as MongoQuery;
        const orgScope: MongoQuery = { trainerOrgId: principal.trainerOrgId } as MongoQuery;

        can(Action.Read, 'CoachProfile', ownProfile);
        can(Action.Update, 'CoachProfile', ownProfile);
        can(Action.Manage, 'Availability', { coachUserId: principal.userId } as MongoQuery);

        // View-only over the trainer's roster they deliver sessions for.
        can(Action.Read, 'PlayerProfile', orgScope);
        can(Action.Read, 'TrainerOrg', { id: principal.trainerOrgId } as MongoQuery);
        can(Action.Read, 'Branding', orgScope);

        // Running the organisation is the trainer's job, not the coach's.
        cannot(Action.Manage, 'ShareLink');
        cannot(Action.Manage, 'TrainerPlayerAssociation');
        cannot(Action.Manage, 'User');
        break;
      }

      case Role.PlayerParent: {
        // Self-service over the profiles this account owns — the parent's own
        // profile and each child's (US-01.03 / US-01.04).
        const owned: MongoQuery = { ownerUserId: principal.userId } as MongoQuery;

        can(Action.Read, 'PlayerProfile', owned);
        can(Action.Update, 'PlayerProfile', owned);
        can(Action.Create, 'PlayerProfile');
        can(Action.Manage, 'Availability', owned);

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
