import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { AssociationsService } from '../enrollment/associations.service';
import { AssociationStatus } from '../enrollment/entities/trainer-player-association.entity';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import {
  AvailabilitySlotInput,
  AvailabilitySlotView,
  PlayerAvailabilityView,
  TrainerAvailabilityQuery,
} from './dto/availability.dto';
import { AvailabilitySlot } from './entities/availability-slot.entity';

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => Number(v));
  return h * 60 + m;
}

function toHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function toView(slot: AvailabilitySlot): AvailabilitySlotView {
  return {
    dayOfWeek: slot.dayOfWeek,
    startTime: toHHMM(slot.startMinute),
    endTime: toHHMM(slot.endMinute),
  };
}

@Injectable()
export class AvailabilityService {
  constructor(
    @InjectRepository(AvailabilitySlot) private readonly slots: Repository<AvailabilitySlot>,
    private readonly dataSource: DataSource,
    private readonly playersService: PlayersService,
    private readonly trainersService: TrainersService,
    private readonly associations: AssociationsService,
  ) {}

  /** Replace a profile's full availability set (US-01.09). Owner-only. */
  async setForProfile(
    ownerUserId: string,
    profileId: string,
    input: AvailabilitySlotInput[],
  ): Promise<AvailabilitySlotView[]> {
    await this.requireOwnedProfile(ownerUserId, profileId);

    for (const s of input) {
      if (toMinutes(s.endTime) <= toMinutes(s.startTime)) {
        throw new BadRequestException({
          errorCode: ErrorCode.VALIDATION_ERROR,
          message: `endTime must be after startTime (day ${s.dayOfWeek}).`,
        });
      }
    }

    await this.dataSource.transaction(async (manager: EntityManager) => {
      const repo = manager.getRepository(AvailabilitySlot);
      await repo.delete({ playerProfileId: profileId });
      if (input.length > 0) {
        await repo.save(
          input.map((s) =>
            repo.create({
              playerProfileId: profileId,
              dayOfWeek: s.dayOfWeek,
              startMinute: toMinutes(s.startTime),
              endMinute: toMinutes(s.endTime),
            }),
          ),
        );
      }
    });

    return this.getForProfile(ownerUserId, profileId);
  }

  async getForProfile(ownerUserId: string, profileId: string): Promise<AvailabilitySlotView[]> {
    await this.requireOwnedProfile(ownerUserId, profileId);
    const rows = await this.slots.find({
      where: { playerProfileId: profileId },
      order: { dayOfWeek: 'ASC', startMinute: 'ASC' },
    });
    return rows.map(toView);
  }

  /** Trainer view of associated players' availability, optionally filtered. */
  async trainerView(
    trainerUserId: string,
    query: TrainerAvailabilityQuery,
  ): Promise<PlayerAvailabilityView[]> {
    const trainer = await this.trainersService.findByUserId(trainerUserId);
    if (!trainer) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      });
    }

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

    const profiles = await this.playersService.findByIds(profileIds);
    const rows = await this.slots.find({ where: { playerProfileId: In(profileIds) } });

    const byProfile = new Map<string, AvailabilitySlot[]>();
    for (const r of rows) {
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
        return dayOk && timeOk;
      });
    });
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
