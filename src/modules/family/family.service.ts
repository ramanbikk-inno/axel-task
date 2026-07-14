import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AssociationsService } from '../enrollment/associations.service';
import { AssociationStatus } from '../enrollment/entities/trainer-player-association.entity';
import { ShareLinksService } from '../enrollment/share-links.service';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import { CreateChildDto } from './dto/create-child.dto';
import { FamilyContextView } from './dto/family-context.view';
import { PlayerProfileView, TrainerContextView } from './dto/player-profile.view';

@Injectable()
export class FamilyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly playersService: PlayersService,
    private readonly associations: AssociationsService,
    private readonly shareLinks: ShareLinksService,
    private readonly trainersService: TrainersService,
    private readonly clock: ClockService,
  ) {}

  /** All profiles owned by the parent (self + children), each with its trainers. */
  async listFamily(parentUserId: string): Promise<PlayerProfileView[]> {
    const profiles = await this.playersService.findByOwner(parentUserId);
    return this.buildViews(profiles);
  }

  /** Create a child profile and optionally connect it to the parent's trainers. */
  async createChild(parentUserId: string, dto: CreateChildDto): Promise<PlayerProfileView> {
    const age = this.ageFromBirthDate(dto.birthDate);
    if (age < 1 || age > 18) {
      throw new BadRequestException({
        errorCode: ErrorCode.CHILD_AGE_INVALID,
        message: 'A child must be between 1 and 18 years old.',
      });
    }

    const owned = await this.playersService.findByOwner(parentUserId);
    const duplicate = owned.some(
      (p) =>
        p.isChild &&
        p.displayName.trim().toLowerCase() === dto.displayName.trim().toLowerCase() &&
        p.birthDate === dto.birthDate,
    );
    if (duplicate) {
      throw new ConflictException({
        errorCode: ErrorCode.DUPLICATE_CHILD,
        message: 'A child with the same name and birth date already exists.',
      });
    }

    const requested = dto.trainerProfileIds ?? [];
    if (requested.length > 0) {
      const parentTrainers = await this.parentTrainerProfileIds(owned);
      for (const trainerProfileId of requested) {
        if (!parentTrainers.has(trainerProfileId)) {
          throw new ForbiddenException({
            errorCode: ErrorCode.TRAINER_NOT_ASSOCIATED,
            message: 'You can only add a child to trainers you are associated with.',
          });
        }
      }
    }

    const child = await this.dataSource.transaction(async (manager: EntityManager) => {
      const created = await this.playersService.create(
        {
          ownerUserId: parentUserId,
          displayName: dto.displayName,
          isChild: true,
          birthDate: dto.birthDate,
          gender: dto.gender,
          school: dto.school ?? null,
          jerseyNumber: dto.jerseyNumber ?? null,
        },
        manager,
      );

      for (const trainerProfileId of requested) {
        await this.associations.associate(
          { trainerProfileId, playerProfileId: created.id },
          manager,
        );
      }

      return created;
    });

    const [view] = await this.buildViews([child]);
    return view;
  }

  /** Context-switcher data: the parent's own context + each child's contexts. */
  async getContext(parentUserId: string): Promise<FamilyContextView> {
    const views = await this.listFamily(parentUserId);
    return {
      self: views.find((v) => !v.isChild) ?? null,
      children: views.filter((v) => v.isChild),
    };
  }

  /** Connect an owned profile to a trainer the parent is already associated with. */
  async addTrainerFromExisting(
    parentUserId: string,
    profileId: string,
    trainerProfileId: string,
  ): Promise<PlayerProfileView> {
    const profile = await this.requireOwnedProfile(parentUserId, profileId);

    const owned = await this.playersService.findByOwner(parentUserId);
    const parentTrainers = await this.parentTrainerProfileIds(owned);
    if (!parentTrainers.has(trainerProfileId)) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_NOT_ASSOCIATED,
        message: 'You can only add a profile to trainers you are associated with.',
      });
    }

    await this.associations.associate({ trainerProfileId, playerProfileId: profile.id });
    const [view] = await this.buildViews([profile]);
    return view;
  }

  /** Connect an owned profile to a (possibly new) trainer via a ShareLink code. */
  async addTrainerByCode(
    parentUserId: string,
    profileId: string,
    code: string,
  ): Promise<PlayerProfileView> {
    const profile = await this.requireOwnedProfile(parentUserId, profileId);
    const link = await this.shareLinks.requireUsable(code);

    await this.dataSource.transaction(async (manager: EntityManager) => {
      const { created } = await this.associations.associate(
        {
          trainerProfileId: link.trainerProfileId,
          playerProfileId: profile.id,
          shareLinkId: link.id,
        },
        manager,
      );
      if (created) {
        await this.shareLinks.incrementUse(link.id, manager);
      }
    });

    const [view] = await this.buildViews([profile]);
    return view;
  }

  /**
   * Disconnect an owned profile from a trainer. The association is deactivated
   * (soft-deleted) so history is preserved.
   */
  async removeTrainer(
    parentUserId: string,
    profileId: string,
    trainerProfileId: string,
  ): Promise<PlayerProfileView> {
    const profile = await this.requireOwnedProfile(parentUserId, profileId);

    const updated = await this.associations.setStatus(
      trainerProfileId,
      profile.id,
      AssociationStatus.Inactive,
    );
    if (!updated) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'This profile is not connected to that trainer.',
      });
    }

    const [view] = await this.buildViews([profile]);
    return view;
  }

  private async requireOwnedProfile(
    parentUserId: string,
    profileId: string,
  ): Promise<PlayerProfile> {
    const profile = await this.playersService.findById(profileId);
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'Player profile not found.',
      });
    }
    if (profile.ownerUserId !== parentUserId) {
      throw new ForbiddenException({
        errorCode: ErrorCode.PROFILE_NOT_OWNED,
        message: 'You do not own this player profile.',
      });
    }
    return profile;
  }

  /** Distinct active trainer profile ids across all of the parent's profiles. */
  private async parentTrainerProfileIds(ownedProfiles: PlayerProfile[]): Promise<Set<string>> {
    const associations = await this.associations.findByPlayerProfiles(
      ownedProfiles.map((p) => p.id),
    );
    return new Set(
      associations
        .filter((a) => a.status === AssociationStatus.Active)
        .map((a) => a.trainerProfileId),
    );
  }

  private async buildViews(profiles: PlayerProfile[]): Promise<PlayerProfileView[]> {
    if (profiles.length === 0) {
      return [];
    }
    const associations = (
      await this.associations.findByPlayerProfiles(profiles.map((p) => p.id))
    ).filter((a) => a.status === AssociationStatus.Active);
    const trainerIds = [...new Set(associations.map((a) => a.trainerProfileId))];
    const trainers = await this.trainersService.findByIds(trainerIds);
    const nameById = new Map(trainers.map((t) => [t.id, t.businessName]));

    const byProfile = new Map<string, TrainerContextView[]>();
    for (const a of associations) {
      const list = byProfile.get(a.playerProfileId) ?? [];
      list.push({
        trainerProfileId: a.trainerProfileId,
        businessName: nameById.get(a.trainerProfileId) ?? 'Unknown',
        status: a.status,
      });
      byProfile.set(a.playerProfileId, list);
    }

    return profiles.map((p) => PlayerProfileView.from(p, byProfile.get(p.id) ?? []));
  }

  private ageFromBirthDate(birthDate: string): number {
    const now = this.clock.now();
    const born = new Date(`${birthDate}T00:00:00.000Z`);
    let age = now.getUTCFullYear() - born.getUTCFullYear();
    const monthDelta = now.getUTCMonth() - born.getUTCMonth();
    if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < born.getUTCDate())) {
      age -= 1;
    }
    return age;
  }
}
