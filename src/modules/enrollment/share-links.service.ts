import { randomBytes } from 'node:crypto';

import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { ShareLink, ShareLinkType } from './entities/share-link.entity';

export interface CreateShareLinkInput {
  trainerProfileId: string;
  type: ShareLinkType;
  createdByUserId: string;
  targetEmail?: string | null;
  expiresAt?: Date | null;
  maxUses?: number | null;
}

@Injectable()
export class ShareLinksService {
  constructor(
    @InjectRepository(ShareLink)
    private readonly links: Repository<ShareLink>,
    private readonly clock: ClockService,
  ) {}

  private repo(manager?: EntityManager): Repository<ShareLink> {
    return manager !== undefined ? manager.getRepository(ShareLink) : this.links;
  }

  private generateCode(): string {
    // URL-safe, ~13 chars; collisions are caught by the unique index.
    return randomBytes(9).toString('base64url');
  }

  async create(input: CreateShareLinkInput): Promise<ShareLink> {
    const link = this.links.create({
      trainerProfileId: input.trainerProfileId,
      code: this.generateCode(),
      type: input.type,
      targetEmail: input.targetEmail ?? null,
      expiresAt: input.expiresAt ?? null,
      maxUses: input.maxUses ?? null,
      useCount: 0,
      active: true,
      createdByUserId: input.createdByUserId,
    });
    return this.links.save(link);
  }

  async findByTrainer(trainerProfileId: string): Promise<ShareLink[]> {
    return this.links.find({
      where: { trainerProfileId },
      order: { createdAt: 'DESC' },
    });
  }

  async findByCode(code: string, manager?: EntityManager): Promise<ShareLink | null> {
    return this.repo(manager).findOne({ where: { code } });
  }

  /**
   * Resolve a code and validate it is usable (active, not expired, uses left),
   * throwing the appropriate error otherwise.
   */
  async requireUsable(code: string, manager?: EntityManager): Promise<ShareLink> {
    const link = await this.findByCode(code, manager);
    if (!link || !link.active) {
      throw new NotFoundException({
        errorCode: ErrorCode.SHARE_LINK_INVALID,
        message: 'This invite link is invalid.',
      });
    }
    if (link.expiresAt !== null && link.expiresAt.getTime() < this.clock.now().getTime()) {
      throw new GoneException({
        errorCode: ErrorCode.SHARE_LINK_EXPIRED,
        message: 'This invite link has expired.',
      });
    }
    if (link.maxUses !== null && link.useCount >= link.maxUses) {
      throw new GoneException({
        errorCode: ErrorCode.SHARE_LINK_EXPIRED,
        message: 'This invite link has already been used.',
      });
    }
    return link;
  }

  async incrementUse(id: string, manager?: EntityManager): Promise<void> {
    await this.repo(manager)
      .createQueryBuilder()
      .update(ShareLink)
      .set({ useCount: () => '"use_count" + 1' })
      .where('id = :id', { id })
      .execute();
  }
}
