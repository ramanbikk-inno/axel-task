import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { repoFor } from '../../shared/database/repo-for';
import { User } from './entities/user.entity';
import { Role, UserStatus } from './entities/user.enums';

export interface CreateUserInput {
  email: string;
  role: Role;
  firstName?: string;
  lastName?: string;
  phone?: string;
  passwordHash?: string;
  emailVerified?: boolean;
  mustSetPassword?: boolean;
  status?: UserStatus;
}

export interface SearchUsersInput {
  search?: string;
  role?: Role;
  status?: UserStatus;
  page: number;
  limit: number;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  /**
   * Paginated directory search over all users. Matches `search` as a substring
   * of email / first name / last name (tool-specific, not global), optionally
   * filtered by role and status. Ordered newest-first.
   */
  async search(input: SearchUsersInput): Promise<{ items: User[]; total: number }> {
    const qb = this.usersRepository.createQueryBuilder('user');

    if (input.search !== undefined && input.search.trim() !== '') {
      qb.andWhere('(user.email ILIKE :q OR user.firstName ILIKE :q OR user.lastName ILIKE :q)', {
        q: `%${input.search.trim()}%`,
      });
    }
    if (input.role !== undefined) {
      qb.andWhere('user.role = :role', { role: input.role });
    }
    if (input.status !== undefined) {
      qb.andWhere('user.status = :status', { status: input.status });
    }

    qb.orderBy('user.createdAt', 'DESC')
      .skip((input.page - 1) * input.limit)
      .take(input.limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async findByIds(ids: string[]): Promise<User[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.usersRepository.find({ where: { id: In(ids) } });
  }

  async create(input: CreateUserInput, manager?: EntityManager): Promise<User> {
    const repository = repoFor(this.usersRepository, User, manager);
    const user: User = repository.create({
      email: input.email,
      role: input.role,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      phone: input.phone ?? null,
      passwordHash: input.passwordHash ?? null,
      emailVerified: input.emailVerified ?? false,
      mustSetPassword: input.mustSetPassword ?? false,
      status: input.status ?? UserStatus.Active,
    });
    return repository.save(user);
  }

  async findByEmailWithPassword(email: string): Promise<User | null> {
    return this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email })
      .getOne();
  }

  async findByIdWithPassword(id: string): Promise<User | null> {
    return this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id })
      .getOne();
  }

  async touchLastLogin(id: string, at: Date): Promise<void> {
    await this.usersRepository.update({ id }, { lastLoginAt: at });
  }

  /**
   * Update common profile fields. Only keys present in `input` are changed;
   * `undefined` values are left untouched (email/role/status are not editable
   * here).
   */
  async updateProfile(
    id: string,
    input: { firstName?: string | null; lastName?: string | null; phone?: string | null },
  ): Promise<User> {
    const patch: Partial<User> = {};
    if (input.firstName !== undefined) {
      patch.firstName = input.firstName;
    }
    if (input.lastName !== undefined) {
      patch.lastName = input.lastName;
    }
    if (input.phone !== undefined) {
      patch.phone = input.phone;
    }
    if (Object.keys(patch).length > 0) {
      await this.usersRepository.update({ id }, patch);
    }
    return (await this.findById(id)) as User;
  }

  /**
   * Store the delivery URL together with the provider's handle for it. The URL
   * is what gets served; the public id is the only thing that can delete the
   * asset later, so writing one without the other orphans every replacement.
   */
  async setPhoto(id: string, photo: { url: string; publicId: string } | null): Promise<User> {
    await this.usersRepository.update(
      { id },
      { photoUrl: photo?.url ?? null, photoPublicId: photo?.publicId ?? null },
    );
    return (await this.findById(id)) as User;
  }

  async setStatus(id: string, status: UserStatus, manager?: EntityManager): Promise<void> {
    await repoFor(this.usersRepository, User, manager).update({ id }, { status });
  }

  /**
   * GDPR anonymization: strip PII, disable login, and mark the
   * account Deleted. Irreversible; historical rows keep referring to this id as
   * "Deleted User".
   */
  async anonymize(id: string, manager?: EntityManager): Promise<void> {
    await repoFor(this.usersRepository, User, manager).update(
      { id },
      {
        firstName: 'Deleted',
        lastName: 'User',
        email: `deleted_${id}@example.com`,
        phone: null,
        photoUrl: null,
        // Nulling only photoUrl left the stored image in place with its handle
        // still on the row — the person's face, still served, after an
        // erasure request. The caller deletes the asset itself; this makes
        // sure nothing in the database can find it again either way.
        photoPublicId: null,
        passwordHash: null,
        status: UserStatus.Deleted,
      },
    );
  }

  /**
   * Records email verification only. This deliberately does NOT touch `status`:
   * accounts are created Active already, so writing Active here let a
   * deactivated or GDPR-deleted user restore themselves by redeeming an
   * outstanding verification or setup token. Status transitions belong to the
   * Super Admin lifecycle endpoints.
   */
  async markEmailVerified(id: string, at: Date): Promise<void> {
    await this.usersRepository.update(
      { id },
      {
        emailVerified: true,
        emailVerifiedAt: at,
      },
    );
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.usersRepository.update({ id }, { passwordHash });
  }

  async setPasswordAndBumpVersion(id: string, passwordHash: string): Promise<void> {
    await this.usersRepository
      .createQueryBuilder()
      .update(User)
      .set({
        passwordHash,
        mustSetPassword: false,
        tokenVersion: () => '"token_version" + 1',
      })
      .where('id = :id', { id })
      .execute();
  }
}
