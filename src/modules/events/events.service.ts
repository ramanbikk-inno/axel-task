import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { Principal } from '../auth/principal';
import { TrainersService } from '../trainers/trainers.service';
import { CreateEventDto, EventView } from './dto/event.dto';
import { Event } from './entities/event.entity';

export const AUDIT_EVENT_CREATED = 'event.created';

/** Bounds an event to at most two weekday segments for the availability check. */
export const MAX_EVENT_DURATION_MS = 24 * 60 * 60 * 1000;

export function toEventView(event: Event): EventView {
  return {
    id: event.id,
    trainerProfileId: event.trainerProfileId,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    priceCents: event.priceCents,
    priceTokens: event.priceTokens,
    createdAt: event.createdAt,
  };
}

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    private readonly trainersService: TrainersService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: Principal, dto: CreateEventDto): Promise<EventView> {
    const trainer = await this.trainersService.requireOwnProfile(actor.userId);
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'endsAt must be after startsAt.',
      });
    }
    // A session is checked against a weekly availability schedule, so it has to
    // stay short enough to be expressed in one. Anything longer is a camp or a
    // series, which is a different thing than a session.
    if (endsAt.getTime() - startsAt.getTime() > MAX_EVENT_DURATION_MS) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'An event cannot run longer than 24 hours.',
      });
    }

    const saved = await this.events.save(
      this.events.create({
        trainerProfileId: trainer.id,
        title: dto.title,
        startsAt,
        endsAt,
        priceCents: dto.priceCents ?? null,
        priceTokens: dto.priceTokens ?? null,
        createdByUserId: actor.userId,
      }),
    );

    await this.audit.record({
      action: AUDIT_EVENT_CREATED,
      actor,
      target: { type: 'Event', id: saved.id },
      metadata: { title: saved.title, startsAt: saved.startsAt.toISOString() },
    });
    return toEventView(saved);
  }

  async listForTrainer(trainerUserId: string): Promise<EventView[]> {
    const trainer = await this.trainersService.requireOwnProfile(trainerUserId);
    const rows = await this.events.find({
      where: { trainerProfileId: trainer.id },
      order: { startsAt: 'ASC' },
    });
    return rows.map(toEventView);
  }

  /**
   * An event in the caller's own organisation, or 404 — the same shape every
   * other by-id lookup uses, so another org's id gives nothing away.
   */
  async requireOwnEvent(trainerUserId: string, eventId: string): Promise<Event> {
    const trainer = await this.trainersService.requireOwnProfile(trainerUserId);
    const event = await this.events.findOne({ where: { id: eventId } });
    if (!event || event.trainerProfileId !== trainer.id) {
      throw new NotFoundException({
        errorCode: ErrorCode.EVENT_NOT_FOUND,
        message: 'Event not found.',
      });
    }
    return event;
  }

  findById(eventId: string): Promise<Event | null> {
    return this.events.findOne({ where: { id: eventId } });
  }
}
