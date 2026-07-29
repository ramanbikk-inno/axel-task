import { EntityManager, EntityTarget, ObjectLiteral, Repository } from 'typeorm';

/**
 * Pick the repository a call should run against: the transactional one when the
 * caller passed its `EntityManager`, otherwise the injected one.
 *
 * Before: `manager !== undefined ? manager.getRepository(User) : this.usersRepository`
 * After:  `repoFor(this.usersRepository, User, manager)`
 *
 * A plain function on purpose — nothing to inject, so no provider and no module.
 */
export function repoFor<T extends ObjectLiteral>(
  injected: Repository<T>,
  entity: EntityTarget<T>,
  manager?: EntityManager,
): Repository<T> {
  return manager !== undefined ? manager.getRepository(entity) : injected;
}
