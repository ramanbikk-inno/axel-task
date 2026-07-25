import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, FindOptionsWhere, In, IsNull, Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { CoachProfile } from '../coaches/entities/coach-profile.entity';
import { AssociationsService } from '../enrollment/associations.service';
import { AssociationStatus } from '../enrollment/entities/trainer-player-association.entity';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { UsersService } from '../users/users.service';
import { CoachLookupService } from './coach-lookup.service';
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

/** The shape both stored rows and proposed windows reduce to for coverage maths. */
export interface Window {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  isAvailable: boolean;
}

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
 * Merge [start, end) ranges, joining touching ones so 16:00–18:00 and
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

/**
 * Is [start, end) on `day` fully available? Covered by the union of available
 * windows and untouched by any blackout. A blackout that overlaps even
 * partially disqualifies the window.
 *
 * The single primitive behind both the coach conflict check and the trainer's
 * player filter — when only the coach path knew about blackouts, the two
 * disagreed about whether a blacked-out slot counted as free.
 */
export function coversWindow(windows: Window[], day: number, start: number, end: number): boolean {
  const onDay = windows.filter((w) => w.dayOfWeek === day);
  const blocked = onDay.some((w) => !w.isAvailable && w.startMinute < end && w.endMinute > start);
  if (blocked) {
    return false;
  }
  const open = mergeRanges(
    onDay.filter((w) => w.isAvailable).map((w) => ({ start: w.startMinute, end: w.endMinute })),
  );
  return open.some((r) => r.start <= start && r.end >= end);
}

/**
 * Is there any free minute at all on `day`? The day-only filter cannot use
 * coversWindow (there is no window to test), but it must still subtract
 * blackouts, or a fully blacked-out day reads as available and the same query
 * with a time added contradicts it.
 */
export function hasFreeMinuteOnDay(windows: Window[], day: number): boolean {
  const onDay = windows.filter((w) => w.dayOfWeek === day);
  const blackouts = onDay.filter((w) => !w.isAvailable);
  return onDay
    .filter((w) => w.isAvailable)
    .some((open) => {
      // Any minute of this window left uncovered once blackouts are removed.
      const covering = blackouts
        .filter((b) => b.startMinute < open.endMinute && b.endMinute > open.startMinute)
        .map((b) => ({ start: b.startMinute, end: b.endMinute }));
      let cursor = open.startMinute;
      for (const b of mergeRanges(covering)) {
        if (b.start > cursor) {
          return true;
        }
        cursor = Math.max(cursor, b.end);
      }
      return cursor < open.endMinute;
    });
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

@Injectable()
export class AvailabilityService {
  constructor(
    @InjectRepository(AvailabilitySlot) private readonly slots: Repository<AvailabilitySlot>,
    private readonly dataSource: DataSource,
    private readonly playersService: PlayersService,
    private readonly usersService: UsersService,
    private readonly coachLookup: CoachLookupService,
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
    const coach = await this.coachLookup.requireOwnProfile(coachUserId);
    return this.replaceSlots({ coachProfileId: coach.id }, input);
  }

  async getForCoach(coachUserId: string): Promise<AvailabilitySlotView[]> {
    const coach = await this.coachLookup.requireOwnProfile(coachUserId);
    return this.listSlots({ coachProfileId: coach.id });
  }

  /** A trainer reads one of their own coaches' availability before scheduling. */
  async coachViewForTrainer(
    trainerUserId: string,
    coachProfileId: string,
  ): Promise<CoachAvailabilityView> {
    const coach = await this.coachLookup.requireInOwnOrg(trainerUserId, coachProfileId);
    return {
      coachProfileId: coach.id,
      displayName: await this.coachDisplayName(coach.userId),
      slots: await this.listSlots({ coachProfileId: coach.id }),
    };
  }

  /**
   * Is a coach free for a proposed window? Shared by the advisory conflict
   * check and by override recording, so the verdict stored on an override row
   * is computed exactly the way the warning the trainer saw was.
   */
  async isCoachFreeFor(
    coachProfileId: string,
    day: number,
    startMinute: number,
    endMinute: number,
  ): Promise<boolean> {
    const rows = await this.slots.find({
      where: { coachProfileId, dayOfWeek: day },
    });
    return coversWindow(rows, day, startMinute, endMinute);
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
    const coach = await this.coachLookup.requireInOwnOrg(trainerUserId, coachProfileId);
    const start = toMinutes(query.startTime);
    const end = toMinutes(query.endTime);
    if (end <= start) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'endTime must be after startTime.',
      });
    }

    const rows = await this.slots.find({
      where: { coachProfileId: coach.id, dayOfWeek: query.dayOfWeek },
      order: { startMinute: 'ASC' },
    });
    // Same primitive the recorded override verdict uses, so the warning the
    // trainer sees and the hadConflict written later cannot disagree.
    const available = coversWindow(rows, query.dayOfWeek, start, end);

    return {
      available,
      message: available
        ? null
        : `Coach ${await this.coachDisplayName(coach.userId)} is not available at this time per their schedule. Continue anyway?`,
      daySlots: rows.map(toView),
    };
  }

  private async replaceSlots(
    owner: SlotOwner,
    input: AvailabilitySlotInput[],
  ): Promise<AvailabilitySlotView[]> {
    this.assertValidSlots(input);

    // Read back inside the same transaction: a read after commit can pick up a
    // concurrent writer's set and hand the caller back slots they never sent.
    return this.dataSource.transaction(async (manager: EntityManager) => {
      // Without the lock the replace is not atomic against a concurrent
      // replace: both transactions' DELETEs see the pre-existing set, both
      // INSERT, and the union survives — overlapping windows that
      // assertValidSlots would have rejected.
      await this.lockOwner(owner, manager);

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

      const rows = await repo.find({
        where: this.ownerWhere(owner),
        order: { dayOfWeek: 'ASC', startMinute: 'ASC' },
      });
      return rows.map(toView);
    });
  }

  /**
   * SELECT ... FOR UPDATE on a row that does not exist locks nothing and
   * returns quietly, which would let the replace proceed unserialised. The
   * callers already check the owner exists, so a miss here means it vanished
   * mid-flight: fail rather than write an orphan set.
   */
  private async lockOwner(owner: SlotOwner, manager: EntityManager): Promise<void> {
    const locked =
      owner.playerProfileId !== undefined
        ? await manager.getRepository(PlayerProfile).findOne({
            where: { id: owner.playerProfileId },
            lock: { mode: 'pessimistic_write' },
          })
        : await manager.getRepository(CoachProfile).findOne({
            where: { id: owner.coachProfileId },
            lock: { mode: 'pessimistic_write' },
          });
    if (!locked) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'The profile this availability belongs to no longer exists.',
      });
    }
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
  private ownerWhere(owner: SlotOwner): FindOptionsWhere<AvailabilitySlot> {
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
    const trainer = await this.coachLookup.requireTrainer(trainerUserId);

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

    const days = query.dayOfWeek !== undefined ? [query.dayOfWeek] : ALL_DAYS;
    return views.filter((v) => {
      const raw = byProfile.get(v.playerProfileId) ?? [];
      // Evaluated per day so a blackout on Tuesday cannot suppress a match on
      // Monday when no dayOfWeek filter was given.
      return days.some((day) =>
        filterMinute === undefined
          ? hasFreeMinuteOnDay(raw, day)
          : coversWindow(raw, day, filterMinute, filterMinute + 1),
      );
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
}
