import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { TrainerProfile } from './entities/trainer-profile.entity';

export interface CreateTrainerProfileInput {
  userId: string;
  businessName: string;
  website?: string | null;
  address?: string | null;
  description?: string | null;
}

@Injectable()
export class TrainersService {
  constructor(
    @InjectRepository(TrainerProfile)
    private readonly trainersRepository: Repository<TrainerProfile>,
  ) {}

  async create(input: CreateTrainerProfileInput, manager?: EntityManager): Promise<TrainerProfile> {
    const repository: Repository<TrainerProfile> =
      manager !== undefined ? manager.getRepository(TrainerProfile) : this.trainersRepository;
    const profile: TrainerProfile = repository.create({
      userId: input.userId,
      businessName: input.businessName,
      website: input.website ?? null,
      address: input.address ?? null,
      description: input.description ?? null,
      stripeAccountId: null,
      subscriptionStatus: null,
      platformFeePercent: null,
    });
    return repository.save(profile);
  }

  async findByUserId(userId: string): Promise<TrainerProfile | null> {
    return this.trainersRepository.findOne({ where: { userId } });
  }
}
