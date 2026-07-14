import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
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

  async create(input: CreateUserInput, manager?: EntityManager): Promise<User> {
    const repository: Repository<User> =
      manager !== undefined ? manager.getRepository(User) : this.usersRepository;
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

  async markEmailVerified(id: string, at: Date): Promise<void> {
    await this.usersRepository.update(
      { id },
      {
        emailVerified: true,
        emailVerifiedAt: at,
        status: UserStatus.Active,
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
