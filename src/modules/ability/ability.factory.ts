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
        const orgScope: MongoQuery = { trainerOrgId: principal.trainerOrgId } as MongoQuery;
        can(Action.Read, 'User', orgScope);
        can(Action.Update, 'User', orgScope);
        can(Action.Manage, 'TrainerPlayerAssociation', orgScope);
        can(Action.Read, 'PlayerProfile', orgScope);
        can(Action.Manage, 'CoachProfile', orgScope);
        can(Action.Manage, 'ShareLink', orgScope);
        break;
      }
      case Role.Coach: {
        break;
      }
      case Role.PlayerParent: {
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
