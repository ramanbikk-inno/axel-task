import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { CoachProfile } from '../coaches/entities/coach-profile.entity';
import { MailService } from '../mail/mail.service';
import { TrainersService } from '../trainers/trainers.service';
import { UsersService } from '../users/users.service';
import { AvailabilityService, toHHMM, toMinutes } from './availability.service';
import { CoachOverrideView, RecordCoachOverrideDto } from './dto/availability.dto';
import { CoachAvailabilityOverride } from './entities/coach-availability-override.entity';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function toView(row: CoachAvailabilityOverride): CoachOverrideView {
  return {
    id: row.id,
    eventId: row.eventId,
    coachProfileId: row.coachProfileId,
    trainerProfileId: row.trainerProfileId,
    dayOfWeek: row.dayOfWeek,
    startTime: toHHMM(row.startMinute),
    endTime: toHHMM(row.endMinute),
    overrideReason: row.overrideReason,
    overriddenByUserId: row.overriddenByUserId,
    createdAt: row.createdAt,
  };
}

/**
 * US-01.10: a trainer may schedule a coach outside their stated availability,
 * but the reason is mandatory and the decision is logged and disclosed to the
 * coach (Q-01.06: the coach IS notified).
 */
@Injectable()
export class CoachOverridesService {
  private readonly logger = new Logger(CoachOverridesService.name);

  constructor(
    @InjectRepository(CoachAvailabilityOverride)
    private readonly overrides: Repository<CoachAvailabilityOverride>,
    @InjectRepository(CoachProfile)
    private readonly coachProfiles: Repository<CoachProfile>,
    private readonly availability: AvailabilityService,
    private readonly trainersService: TrainersService,
    private readonly usersService: UsersService,
    private readonly mail: MailService,
  ) {}

  async record(trainerUserId: string, dto: RecordCoachOverrideDto): Promise<CoachOverrideView> {
    const coach = await this.availability.resolveCoachInOwnOrg(trainerUserId, dto.coachProfileId);
    const startMinute = toMinutes(dto.startTime);
    const endMinute = toMinutes(dto.endTime);
    if (endMinute <= startMinute) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'endTime must be after startTime.',
      });
    }

    const saved = await this.overrides.save(
      this.overrides.create({
        eventId: dto.eventId ?? null,
        coachProfileId: coach.id,
        trainerProfileId: coach.trainerProfileId,
        dayOfWeek: dto.dayOfWeek,
        startMinute,
        endMinute,
        overrideReason: dto.overrideReason,
        overriddenByUserId: trainerUserId,
      }),
    );

    await this.notifyCoach(coach, saved);
    return toView(saved);
  }

  /**
   * The override log is only useful if someone can read it. A trainer sees
   * every override their organisation recorded; a coach sees the ones filed
   * against them, which is the disclosure half of Q-01.06.
   */
  async listForTrainer(trainerUserId: string): Promise<CoachOverrideView[]> {
    const trainer = await this.trainersService.findByUserId(trainerUserId);
    if (!trainer) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      });
    }
    const rows = await this.overrides.find({
      where: { trainerProfileId: trainer.id },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toView);
  }

  async listForCoach(coachUserId: string): Promise<CoachOverrideView[]> {
    const coach = await this.coachProfiles.findOne({ where: { userId: coachUserId } });
    if (!coach) {
      throw new ForbiddenException({
        errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
        message: 'No coach profile for this account.',
      });
    }
    const rows = await this.overrides.find({
      where: { coachProfileId: coach.id },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toView);
  }

  /**
   * The log row is already committed by the time this runs. A mail provider
   * outage must not surface as a 500 the trainer retries, because the retry
   * would append a second override for the same assignment.
   */
  private async notifyCoach(
    coach: CoachProfile,
    override: CoachAvailabilityOverride,
  ): Promise<void> {
    const [coachUser, trainer] = await Promise.all([
      this.usersService.findById(coach.userId),
      this.trainersService.findById(coach.trainerProfileId),
    ]);
    if (!coachUser) {
      return;
    }
    try {
      await this.mail.sendCoachAvailabilityOverrideEmail(coachUser.email, {
        trainerName: trainer?.businessName ?? 'Your trainer',
        dayName: DAY_NAMES[override.dayOfWeek],
        startTime: toHHMM(override.startMinute),
        endTime: toHHMM(override.endMinute),
        reason: override.overrideReason,
      });
    } catch (error) {
      this.logger.error(
        `Override ${override.id} recorded but notification to coach ${coach.id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
