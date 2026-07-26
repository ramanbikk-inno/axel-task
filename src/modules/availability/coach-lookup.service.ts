import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { CoachProfile, CoachStatus } from '../coaches/entities/coach-profile.entity';
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

  /**
   * The caller's own coach profile, for the "me" endpoints.
   *
   * Active only. Off-boarding keeps the row (so the engagement stays in the
   * record) and the unique index is partial, so a coach who was off-boarded and
   * later re-hired has *two* rows. An unfiltered findOne picks between them
   * arbitrarily, which silently sent My Times writes to the ended engagement:
   * the coach saw a saved schedule, while the trainer's conflict check — which
   * resolves the coach through the org-scoped id — read an empty one. Filtering
   * on Active also means an off-boarded coach cannot write availability at all,
   * which is correct: their tenancy ended with the row.
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
   * Tenancy gate for every trainer-facing coach read. A coach from another
   * organisation is reported as not found rather than forbidden, so the
   * endpoint cannot be used to probe which coach ids exist elsewhere.
   *
   * Active only, for the same reason: a former employer still owns the ended
   * row's trainerProfileId, and without this they keep a live read on a coach
   * who no longer works for them.
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
