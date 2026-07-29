import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Principal } from '../auth/principal';
import { CoachProfileService } from './coach-profile.service';
import { CoachView, UpdateCoachProfileDto } from './dto/coach.dto';

/**
 * Thin facade over CoachProfileService, kept only for AdminService — including
 * the erasure cascade, which calls `anonymizeByUserId`. New code should inject
 * CoachProfileService or CoachInvitationService directly; this class goes away
 * once AdminService is migrated.
 */
@Injectable()
export class CoachesService {
  constructor(private readonly profiles: CoachProfileService) {}

  async adminUpdateProfile(
    targetUserId: string,
    actor: Principal,
    dto: UpdateCoachProfileDto,
  ): Promise<CoachView> {
    return this.profiles.adminUpdateProfile(targetUserId, actor, dto);
  }

  async anonymizeByUserId(userId: string, manager?: EntityManager): Promise<void> {
    return this.profiles.anonymizeByUserId(userId, manager);
  }

  async findActiveByUserId(userId: string): Promise<CoachView | null> {
    return this.profiles.findActiveByUserId(userId);
  }
}
