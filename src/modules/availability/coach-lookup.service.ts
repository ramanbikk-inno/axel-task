import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { CoachProfile, CoachStatus } from '../coaches/entities/coach-profile.entity';
import { TrainersService } from '../trainers/trainers.service';

/**
 * Resolves the coach a request may act on. The tenancy gate for every
 * trainer-facing coach endpoint, shared by the availability and override
 * services so there is only one copy of it.
 */
@Injectable()
export class CoachLookupService {
  constructor(
    @InjectRepository(CoachProfile) private readonly coachProfiles: Repository<CoachProfile>,
    private readonly trainersService: TrainersService,
  ) {}

  /**
   * The caller's own coach profile, for the "me" endpoints.
   *
   * Active only. Off-boarding keeps the row and the unique index is partial, so
   * a re-hired coach has two — an unfiltered findOne picks arbitrarily and can
   * send writes to the ended engagement.
   */
  async requireOwnProfile(coachUserId: string): Promise<CoachProfile> {
    const coach = await this.coachProfiles.findOne({
      where: { userId: coachUserId, status: CoachStatus.Active },
    });
    if (!coach) {
      throw new ForbiddenException({
        errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
        message: 'No active coach profile for this account.',
      });
    }
    return coach;
  }

  /**
   * Tenancy gate for trainer-facing coach reads. Another org's coach is "not
   * found", not "forbidden", so the endpoint cannot probe for ids elsewhere.
   * Active only: an ended row still carries the former employer's id.
   */
  async requireInOwnOrg(trainerUserId: string, coachProfileId: string): Promise<CoachProfile> {
    const trainer = await this.requireTrainer(trainerUserId);
    const coach = await this.coachProfiles.findOne({
      where: { id: coachProfileId, trainerProfileId: trainer.id, status: CoachStatus.Active },
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
