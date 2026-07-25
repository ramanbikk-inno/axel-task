import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { CoachProfile } from '../coaches/entities/coach-profile.entity';
import { MailService } from '../mail/mail.service';
import { TrainersService } from '../trainers/trainers.service';
import { UsersService } from '../users/users.service';
import { AvailabilityService, toHHMM, toMinutes } from './availability.service';
import { CoachLookupService } from './coach-lookup.service';
import {
  CoachOverrideView,
  ListCoachOverridesQuery,
  PagedCoachOverrides,
  RecordCoachOverrideDto,
} from './dto/availability.dto';
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
    hadConflict: row.hadConflict,
    overriddenByUserId: row.overriddenByUserId,
    createdAt: row.createdAt,
  };
}

/**
 * US-01.10: a trainer may schedule a coach outside their stated availability,
 * but the reason is mandatory and the decision is logged. Q-01.06 — the coach
 * IS notified — applies to rows that actually overrode something: when the
 * server recomputes no conflict, nothing was overridden and an email claiming
 * otherwise would be false. `hadConflict` records which case each row was.
 */
@Injectable()
export class CoachOverridesService {
  private readonly logger = new Logger(CoachOverridesService.name);

  constructor(
    @InjectRepository(CoachAvailabilityOverride)
    private readonly overrides: Repository<CoachAvailabilityOverride>,
    private readonly availability: AvailabilityService,
    private readonly coachLookup: CoachLookupService,
    private readonly trainersService: TrainersService,
    private readonly usersService: UsersService,
    private readonly mail: MailService,
  ) {}

  async record(trainerUserId: string, dto: RecordCoachOverrideDto): Promise<CoachOverrideView> {
    const coach = await this.coachLookup.requireInOwnOrg(trainerUserId, dto.coachProfileId);
    const startMinute = toMinutes(dto.startTime);
    const endMinute = toMinutes(dto.endTime);
    if (endMinute <= startMinute) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'endTime must be after startTime.',
      });
    }

    // A client can legitimately race stale availability, so a non-conflicting
    // window is recorded rather than rejected — but the row says which it was,
    // otherwise the trail cannot distinguish a real override from a no-op and
    // "the trainer overrode me" becomes unfalsifiable.
    const hadConflict = !(await this.availability.isCoachFreeFor(
      coach.id,
      dto.dayOfWeek,
      startMinute,
      endMinute,
    ));

    const saved = await this.overrides.save(
      this.overrides.create({
        eventId: dto.eventId ?? null,
        coachProfileId: coach.id,
        trainerProfileId: coach.trainerProfileId,
        dayOfWeek: dto.dayOfWeek,
        startMinute,
        endMinute,
        overrideReason: dto.overrideReason,
        hadConflict,
        overriddenByUserId: trainerUserId,
      }),
    );

    // Nothing was overridden, so there is nothing to tell the coach about.
    if (hadConflict) {
      await this.notifyCoach(coach, saved);
    }
    return toView(saved);
  }

  /**
   * The override log is only useful if someone can read it. A trainer sees
   * every override their organisation recorded; a coach sees the ones filed
   * against them, which is the disclosure half of Q-01.06.
   */
  async listForTrainer(
    trainerUserId: string,
    query: ListCoachOverridesQuery,
  ): Promise<PagedCoachOverrides> {
    const trainer = await this.coachLookup.requireTrainer(trainerUserId);
    return this.page({ trainerProfileId: trainer.id }, query);
  }

  async listForCoach(
    coachUserId: string,
    query: ListCoachOverridesQuery,
  ): Promise<PagedCoachOverrides> {
    const coach = await this.coachLookup.requireOwnProfile(coachUserId);
    return this.page({ coachProfileId: coach.id }, query);
  }

  /** Platform-wide read for a Super Admin, who is not scoped to one org. */
  async listAll(query: ListCoachOverridesQuery): Promise<PagedCoachOverrides> {
    return this.page({}, query);
  }

  private async page(
    where: FindOptionsWhere<CoachAvailabilityOverride>,
    query: ListCoachOverridesQuery,
  ): Promise<PagedCoachOverrides> {
    const [rows, total] = await this.overrides.findAndCount({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { items: rows.map(toView), total, page: query.page, limit: query.limit };
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
