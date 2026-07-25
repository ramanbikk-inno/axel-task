import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { CoachProfile } from '../coaches/entities/coach-profile.entity';
import { AssociationsService } from '../enrollment/associations.service';
import { AssociationStatus } from '../enrollment/entities/trainer-player-association.entity';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import { UsersService } from '../users/users.service';
import {
  AvailabilitySlotInput,
  AvailabilitySlotView,
  CoachAvailabilityView,
  ConflictCheckQuery,
  ConflictCheckView,
  PlayerAvailabilityView,
  TrainerAvailabilityQuery,
} from './dto/availability.dto';
import { AvailabilitySlot } from './entities/availability-slot.entity';

/**
 * Exactly one owner per slot, mirroring the CHK_availability_slots_owner XOR in
 * the database. Passing one of these around means no code path can accidentally
 * write a slot owned by nobody or by both.
 */
export type SlotOwner =
  | { playerProfileId: string; coachProfileId?: undefined }
  | { coachProfileId: string; playerProfileId?: undefined };

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => Number(v));
  return h * 60 + m;
}

export function toHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function toView(slot: AvailabilitySlot): AvailabilitySlotView {
  return {
    dayOfWeek: slot.dayOfWeek,
    startTime: toHHMM(slot.startMinute),
    endTime: toHHMM(slot.endMinute),
    isAvailable: slot.isAvailable,
  };
}

/**
 * Merge sorted [start, end) ranges, joining touching ones so 16:00–18:00 and
 * 18:00–20:00 read as one continuous 16:00–20:00 window when testing coverage.
 */
function mergeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

@Injectable()
export class AvailabilityService {
  constructor(
    @InjectRepository(AvailabilitySlot) private readonly slots: Repository<AvailabilitySlot>,
    @InjectRepository(CoachProfile) private readonly coachProfiles: Repository<CoachProfile>,
    private readonly dataSource: DataSource,
    private readonly playersService: PlayersService,
    private readonly trainersService: TrainersService,
    private readonly usersService: UsersService,
    private readonly associations: AssociationsService,
  ) {}

  /** Replace a player profile's full availability set (US-01.09). Owner-only. */
  async setForProfile(
    ownerUserId: string,
    profileId: string,
    input: AvailabilitySlotInput[],
  ): Promise<AvailabilitySlotView[]> {
    await this.requireOwnedProfile(ownerUserId, profileId);
    return this.replaceSlots({ playerProfileId: profileId }, input);
  }

  async getForProfile(ownerUserId: string, profileId: string): Promise<AvailabilitySlotView[]> {
    await this.requireOwnedProfile(ownerUserId, profileId);
    return this.listSlots({ playerProfileId: profileId });
  }

  /** Replace the calling coach's own weekly availability — "My Times" (US-01.10). */
  async setForCoach(
    coachUserId: string,
    input: AvailabilitySlotInput[],
  ): Promise<AvailabilitySlotView[]> {
    const coach = await this.requireOwnCoachProfile(coachUserId);
    return this.replaceSlots({ coachProfileId: coach.id }, input);
  }

  async getForCoach(coachUserId: string): Promise<AvailabilitySlotView[]> {
    const coach = await this.requireOwnCoachProfile(coachUserId);
    return this.listSlots({ coachProfileId: coach.id });
  }

  /** A trainer reads one of their own coaches' availability before scheduling. */
  async coachViewForTrainer(
    trainerUserId: string,
    coachProfileId: string,
  ): Promise<CoachAvailabilityView> {
    const coach = await this.resolveCoachInOwnOrg(trainerUserId, coachProfileId);
    return {
      coachProfileId: coach.id,
      displayName: await this.coachDisplayName(coach.userId),
      slots: await this.listSlots({ coachProfileId: coach.id }),
    };
  }

  /**
   * US-01.10 trainer assignment flow: does a proposed session time fall inside
   * the coach's stated availability? This never blocks — it returns the warning
   * copy the trainer is shown before choosing to override.
   */
  async checkCoachConflict(
    trainerUserId: string,
    coachProfileId: string,
    query: ConflictCheckQuery,
  ): Promise<ConflictCheckView> {
    const coach = await this.resolveCoachInOwnOrg(trainerUserId, coachProfileId);
    const start = toMinutes(query.startTime);
    const end = toMinutes(query.endTime);
    if (end <= start) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'endTime must be after startTime.',
      });
    }

    const daySlots = (
      await this.slots.find({
        where: { coachProfileId: coach.id, dayOfWeek: query.dayOfWeek },
        order: { startMinute: 'ASC' },
      })
    ).map(toView);

    const available = this.covers(daySlots, start, end);
    return {
      available,
      message: available
        ? null
        : `Coach ${await this.coachDisplayName(coach.userId)} is not available at this time per their schedule. Continue anyway?`,
      daySlots,
    };
  }

  /**
   * Available for the whole window means: covered by the union of the coach's
   * available windows, and untouched by any blackout. A blackout that overlaps
   * even partially is a conflict — the trainer should see the warning.
   */
  private covers(daySlots: AvailabilitySlotView[], start: number, end: number): boolean {
    const blocked = daySlots
      .filter((s) => !s.isAvailable)
      .some((s) => toMinutes(s.startTime) < end && toMinutes(s.endTime) > start);
    if (blocked) {
      return false;
    }
    const open = mergeRanges(
      daySlots
        .filter((s) => s.isAvailable)
        .map((s) => ({ start: toMinutes(s.startTime), end: toMinutes(s.endTime) })),
    );
    return open.some((r) => r.start <= start && r.end >= end);
  }

  private async replaceSlots(
    owner: SlotOwner,
    input: AvailabilitySlotInput[],
  ): Promise<AvailabilitySlotView[]> {
    this.assertValidSlots(input);

    await this.dataSource.transaction(async (manager: EntityManager) => {
      const repo = manager.getRepository(AvailabilitySlot);
      await repo.delete(this.ownerWhere(owner));
      if (input.length > 0) {
        await repo.save(
          input.map((s) =>
            repo.create({
              playerProfileId: owner.playerProfileId ?? null,
              coachProfileId: owner.coachProfileId ?? null,
              dayOfWeek: s.dayOfWeek,
              startMinute: toMinutes(s.startTime),
              endMinute: toMinutes(s.endTime),
              isAvailable: s.isAvailable ?? true,
            }),
          ),
        );
      }
    });

    return this.listSlots(owner);
  }

  private async listSlots(owner: SlotOwner): Promise<AvailabilitySlotView[]> {
    const rows = await this.slots.find({
      where: this.ownerWhere(owner),
      order: { dayOfWeek: 'ASC', startMinute: 'ASC' },
    });
    return rows.map(toView);
  }

  /**
   * Both columns are pinned in every query. Matching only the owning column
   * would let a player id delete or read rows that happen to share it with a
   * coach id, and IsNull() makes the XOR explicit at the query level.
   */
  private ownerWhere(owner: SlotOwner): {
    playerProfileId: ReturnType<typeof IsNull> | string;
    coachProfileId: ReturnType<typeof IsNull> | string;
  } {
    return owner.playerProfileId !== undefined
      ? { playerProfileId: owner.playerProfileId, coachProfileId: IsNull() }
      : { playerProfileId: IsNull(), coachProfileId: owner.coachProfileId };
  }

  /**
   * Validate a proposed set of windows: each must be a single-day range with
   * endTime strictly after startTime (windows never cross midnight), and
   * windows must not overlap another window of the same kind on the same day.
   * Touching windows (17:00–18:00 and 18:00–19:00) are allowed because ranges
   * are end-exclusive. An available and a blackout window may overlap — that is
   * exactly how a blackout carves a hole out of a longer available window.
   */
  private assertValidSlots(input: AvailabilitySlotInput[]): void {
    const byDay = new Map<string, AvailabilitySlotInput[]>();
    for (const s of input) {
      if (toMinutes(s.endTime) <= toMinutes(s.startTime)) {
        throw new BadRequestException({
          errorCode: ErrorCode.VALIDATION_ERROR,
          message: `endTime must be after startTime (day ${s.dayOfWeek}).`,
        });
      }
      const key = `${s.dayOfWeek}:${s.isAvailable ?? true}`;
      const list = byDay.get(key) ?? [];
      list.push(s);
      byDay.set(key, list);
    }

    for (const daySlots of byDay.values()) {
      const sorted = [...daySlots].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
      for (let i = 1; i < sorted.length; i++) {
        if (toMinutes(sorted[i].startTime) < toMinutes(sorted[i - 1].endTime)) {
          throw new BadRequestException({
            errorCode: ErrorCode.VALIDATION_ERROR,
            message: `Availability windows overlap on day ${sorted[i].dayOfWeek}.`,
          });
        }
      }
    }
  }

  /** Trainer view of associated players' availability, optionally filtered. */
  async trainerView(
    trainerUserId: string,
    query: TrainerAvailabilityQuery,
  ): Promise<PlayerAvailabilityView[]> {
    const trainer = await this.requireTrainer(trainerUserId);

    const associations = await this.associations.findByTrainer(trainer.id);
    const profileIds = [
      ...new Set(
        associations
          .filter((a) => a.status === AssociationStatus.Active)
          .map((a) => a.playerProfileId),
      ),
    ];
    if (profileIds.length === 0) {
      return [];
    }

    // Sorted for stable ordering across requests. The day/time filter applied
    // below narrows *which* players are returned; each returned player keeps
    // their full weekly availability for scheduling context.
    const profiles = (await this.playersService.findByIds(profileIds)).sort(
      (a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id),
    );
    const rows = await this.slots.find({ where: { playerProfileId: In(profileIds) } });

    const byProfile = new Map<string, AvailabilitySlot[]>();
    for (const r of rows) {
      if (r.playerProfileId === null) {
        continue;
      }
      const list = byProfile.get(r.playerProfileId) ?? [];
      list.push(r);
      byProfile.set(r.playerProfileId, list);
    }

    const filterMinute = query.time !== undefined ? toMinutes(query.time) : undefined;

    const views: PlayerAvailabilityView[] = profiles.map((p) => {
      const slots = (byProfile.get(p.id) ?? []).sort(
        (a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinute - b.startMinute,
      );
      return { playerProfileId: p.id, displayName: p.displayName, slots: slots.map(toView) };
    });

    if (query.dayOfWeek === undefined && filterMinute === undefined) {
      return views;
    }

    // Filter to players available at the requested day/time.
    return views.filter((v) => {
      const raw = byProfile.get(v.playerProfileId) ?? [];
      return raw.some((s) => {
        const dayOk = query.dayOfWeek === undefined || s.dayOfWeek === query.dayOfWeek;
        const timeOk =
          filterMinute === undefined ||
          (s.startMinute <= filterMinute && filterMinute < s.endMinute);
        return s.isAvailable && dayOk && timeOk;
      });
    });
  }

  private async coachDisplayName(coachUserId: string): Promise<string> {
    const user = await this.usersService.findById(coachUserId);
    if (!user) {
      return 'Coach';
    }
    const name = [user.firstName, user.lastName].filter((p) => p).join(' ');
    return name.length > 0 ? name : user.email;
  }

  private async requireOwnedProfile(ownerUserId: string, profileId: string): Promise<void> {
    const profile = await this.playersService.findById(profileId);
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'Player profile not found.',
      });
    }
    if (profile.ownerUserId !== ownerUserId) {
      throw new ForbiddenException({
        errorCode: ErrorCode.PROFILE_NOT_OWNED,
        message: 'You do not own this player profile.',
      });
    }
  }

  private async requireOwnCoachProfile(coachUserId: string): Promise<CoachProfile> {
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
  async resolveCoachInOwnOrg(trainerUserId: string, coachProfileId: string): Promise<CoachProfile> {
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

  private async requireTrainer(trainerUserId: string): Promise<{ id: string }> {
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
