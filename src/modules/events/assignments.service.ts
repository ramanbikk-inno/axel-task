import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { Principal } from '../auth/principal';
import { AvailabilityService, toHHMM } from '../availability/availability.service';
import { CoachLookupService } from '../availability/coach-lookup.service';
import { CoachOverridesService } from '../availability/coach-overrides.service';
import { AssignCoachDto, EventAssignmentView, RequestAssignmentChangeDto } from './dto/event.dto';
import { AssignmentResponse, EventCoachAssignment } from './entities/event-coach-assignment.entity';
import { Event } from './entities/event.entity';
import { EventsService } from './events.service';

export const AUDIT_COACH_ASSIGNED = 'event.coach-assigned';
export const AUDIT_COACH_UNASSIGNED = 'event.coach-unassigned';
export const AUDIT_ASSIGNMENT_ANSWERED = 'event.assignment-answered';

export interface WeeklySegment {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Availability is a weekly recurring schedule (day of week + minute window), so
 * an event's absolute interval has to be reduced to that shape to be checked
 * against it. UTC on both sides: the slots carry no zone either.
 *
 * One tuple cannot express an event that spans a UTC midnight, and collapsing
 * it to one silently drops whole days from the check. So the interval is cut at
 * each midnight it crosses and every piece is returned; the caller checks all
 * of them. A same-day event still yields exactly one segment.
 */
export function weeklySegmentsOf(event: Event): WeeklySegment[] {
  const startsAt = new Date(event.startsAt);
  const endsAt = new Date(event.endsAt);
  const segments: WeeklySegment[] = [];

  let cursor = startsAt;
  while (cursor.getTime() < endsAt.getTime()) {
    const dayStart = utcMidnight(cursor);
    const nextMidnight = dayStart + MINUTES_PER_DAY * MS_PER_MINUTE;
    const pieceEnd = Math.min(nextMidnight, endsAt.getTime());

    const startMinute = Math.floor((cursor.getTime() - dayStart) / MS_PER_MINUTE);
    // Ceil so a partial minute is covered rather than trimmed away.
    const endMinute = Math.ceil((pieceEnd - dayStart) / MS_PER_MINUTE);
    if (endMinute > startMinute) {
      segments.push({ dayOfWeek: cursor.getUTCDay(), startMinute, endMinute });
    }
    cursor = new Date(nextMidnight);
  }
  return segments;
}

@Injectable()
export class AssignmentsService {
  constructor(
    @InjectRepository(EventCoachAssignment)
    private readonly assignments: Repository<EventCoachAssignment>,
    private readonly events: EventsService,
    private readonly availability: AvailabilityService,
    private readonly coachLookup: CoachLookupService,
    private readonly overrides: CoachOverridesService,
    private readonly clock: ClockService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Assign a coach to an event. A conflict does not block: the first call comes
   * back with the warning to show the trainer, and repeating it with a reason
   * records the override and completes the assignment.
   */
  async assign(
    actor: Principal,
    eventId: string,
    dto: AssignCoachDto,
  ): Promise<EventAssignmentView> {
    const event = await this.events.requireOwnEvent(actor.userId, eventId);
    const coach = await this.coachLookup.requireInOwnOrg(actor.userId, dto.coachProfileId);

    const existing = await this.assignments.findOne({
      where: { eventId: event.id, coachProfileId: coach.id },
    });
    if (existing) {
      throw new ConflictException({
        errorCode: ErrorCode.COACH_ALREADY_ASSIGNED,
        message: 'This coach is already assigned to this event.',
      });
    }

    // Every piece the event covers has to clear, not just the first day of it.
    const segments = weeklySegmentsOf(event);
    const conflicting: WeeklySegment[] = [];
    for (const segment of segments) {
      const free = await this.availability.isCoachFreeFor(
        coach.id,
        segment.dayOfWeek,
        segment.startMinute,
        segment.endMinute,
      );
      if (!free) {
        conflicting.push(segment);
      }
    }

    const hadConflict = conflicting.length > 0;
    if (hadConflict && dto.overrideReason === undefined) {
      const windows = conflicting
        .map((s) => `${toHHMM(s.startMinute)}-${toHHMM(s.endMinute)}`)
        .join(', ');
      throw new ConflictException({
        errorCode: ErrorCode.COACH_UNAVAILABLE,
        message:
          `This coach is not available at this time per their schedule ` +
          `(${windows}). ` +
          `Continue anyway? Resend with an overrideReason to confirm.`,
      });
    }

    // Reuses the existing override machinery rather than a second record of the
    // same fact: it recomputes the conflict itself, audits, and emails the coach.
    // One row per conflicting segment, since a row carries a single weekday;
    // the assignment names the first, and the rest hang off the event id.
    let overrideId: string | null = null;
    for (const segment of conflicting) {
      const override = await this.overrides.record(actor, {
        coachProfileId: coach.id,
        eventId: event.id,
        dayOfWeek: segment.dayOfWeek,
        startTime: toHHMM(segment.startMinute),
        endTime: toHHMM(segment.endMinute),
        overrideReason: dto.overrideReason as string,
      });
      overrideId ??= override.id;
    }

    const saved = await this.assignments.save(
      this.assignments.create({
        eventId: event.id,
        coachProfileId: coach.id,
        assignedByUserId: actor.userId,
        response: AssignmentResponse.Pending,
        coachNote: null,
        hadConflict,
        overrideId,
        respondedAt: null,
      }),
    );

    await this.audit.record({
      action: AUDIT_COACH_ASSIGNED,
      actor,
      target: { type: 'Event', id: event.id },
      metadata: { coachProfileId: coach.id, hadConflict, overrideId },
    });
    return this.toView(saved, event);
  }

  async unassign(actor: Principal, eventId: string, coachProfileId: string): Promise<void> {
    const event = await this.events.requireOwnEvent(actor.userId, eventId);
    const assignment = await this.assignments.findOne({
      where: { eventId: event.id, coachProfileId },
    });
    if (!assignment) {
      throw new NotFoundException({
        errorCode: ErrorCode.ASSIGNMENT_NOT_FOUND,
        message: 'Assignment not found.',
      });
    }

    await this.assignments.delete({ id: assignment.id });
    await this.audit.record({
      action: AUDIT_COACH_UNASSIGNED,
      actor,
      target: { type: 'Event', id: event.id },
      metadata: { coachProfileId },
    });
  }

  async listForEvent(trainerUserId: string, eventId: string): Promise<EventAssignmentView[]> {
    const event = await this.events.requireOwnEvent(trainerUserId, eventId);
    const rows = await this.assignments.find({
      where: { eventId: event.id },
      order: { assignedAt: 'ASC' },
    });
    return rows.map((r) => this.toView(r, event));
  }

  /** What the coach sees: their own assignments, newest event first. */
  async listForCoach(coachUserId: string): Promise<EventAssignmentView[]> {
    const coach = await this.coachLookup.requireOwnProfile(coachUserId);
    const rows = await this.assignments.find({
      where: { coachProfileId: coach.id },
      order: { assignedAt: 'DESC' },
    });
    return this.withEvents(rows);
  }

  /**
   * The coach's answer. Neither branch cancels the assignment — the spec is
   * explicit that a coach is not blocking, only responding.
   */
  async respond(
    actor: Principal,
    assignmentId: string,
    response: AssignmentResponse,
    dto: RequestAssignmentChangeDto = {},
  ): Promise<EventAssignmentView> {
    const coach = await this.coachLookup.requireOwnProfile(actor.userId);
    const assignment = await this.assignments.findOne({ where: { id: assignmentId } });
    if (!assignment || assignment.coachProfileId !== coach.id) {
      throw new NotFoundException({
        errorCode: ErrorCode.ASSIGNMENT_NOT_FOUND,
        message: 'Assignment not found.',
      });
    }

    assignment.response = response;
    assignment.coachNote = dto.note ?? null;
    assignment.respondedAt = this.clock.now();
    const saved = await this.assignments.save(assignment);

    await this.audit.record({
      action: AUDIT_ASSIGNMENT_ANSWERED,
      actor,
      target: { type: 'Event', id: assignment.eventId },
      metadata: { assignmentId: saved.id, response, hasNote: dto.note !== undefined },
    });

    const [view] = await this.withEvents([saved]);
    return view;
  }

  /** One event lookup for the batch rather than one per row. */
  private async withEvents(rows: EventCoachAssignment[]): Promise<EventAssignmentView[]> {
    if (rows.length === 0) {
      return [];
    }
    const events = await this.eventsByIds([...new Set(rows.map((r) => r.eventId))]);
    return rows.map((r) => this.toView(r, events.get(r.eventId)));
  }

  private async eventsByIds(ids: string[]): Promise<Map<string, Event>> {
    const found = await this.assignments.manager.find(Event, { where: { id: In(ids) } });
    return new Map(found.map((e) => [e.id, e]));
  }

  private toView(row: EventCoachAssignment, event?: Event): EventAssignmentView {
    return {
      id: row.id,
      eventId: row.eventId,
      eventTitle: event?.title ?? '',
      startsAt: event?.startsAt as Date,
      endsAt: event?.endsAt as Date,
      coachProfileId: row.coachProfileId,
      response: row.response,
      coachNote: row.coachNote,
      hadConflict: row.hadConflict,
      overrideId: row.overrideId,
      assignedAt: row.assignedAt,
      respondedAt: row.respondedAt,
    };
  }
}
