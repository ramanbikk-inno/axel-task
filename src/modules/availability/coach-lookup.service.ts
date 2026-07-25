import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { CoachProfile } from '../coaches/entities/coach-profile.entity';
import { TrainersService } from '../trainers/trainers.service';

/**
 * Resolves the coach a request is allowed to act on. Both the availability
 * service and the override service need the same two questions answered, and
 * the tenancy gate is the security boundary for every trainer-facing coach
 * endpoint — it belongs in one place rather than reached through from a
 * sibling service.
 */
@Injectable()
export class CoachLookupService {
  constructor(
    @InjectRepository(CoachProfile) private readonly coachProfiles: Repository<CoachProfile>,
    private readonly trainersService: TrainersService,
  ) {}

  /** The caller's own coach profile, for the "me" endpoints. */
  async requireOwnProfile(coachUserId: string): Promise<CoachProfile> {
    const coach = await this.coachProfiles.findOne({ where: { userId: coachUserId } });
    if (!coach) {
      throw new ForbiddenException({
        errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
        message: 'No coach profile for this account.',
      });
    }
    return coach;
  }

  /**
   * Tenancy gate for every trainer-facing coach read. A coach from another
   * organisation is reported as not found rather than forbidden, so the
   * endpoint cannot be used to probe which coach ids exist elsewhere.
   */
  async requireInOwnOrg(trainerUserId: string, coachProfileId: string): Promise<CoachProfile> {
    const trainer = await this.requireTrainer(trainerUserId);
    const coach = await this.coachProfiles.findOne({
      where: { id: coachProfileId, trainerProfileId: trainer.id },
    });
    if (!coach) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'Coach not found in your organisation.',
      });
    }
    return coach;
  }

  async requireTrainer(trainerUserId: string): Promise<{ id: string }> {
    const trainer = await this.trainersService.findByUserId(trainerUserId);
    if (!trainer) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      });
    }
    return { id: trainer.id };
  }
}
