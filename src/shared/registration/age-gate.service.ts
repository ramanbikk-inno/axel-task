import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ClockService } from '../clock/clock.service';
import { MIN_SELF_REGISTRATION_AGE_DEFAULT } from '../config/env.validation';
import { ErrorCode } from '../errors/error-codes';
import { ageInYears, parseCalendarDate } from '../validation/calendar-date';

/**
 * Eligibility for an account in your own name. A registration rule, not an
 * authentication one — it lived on AuthService, which three other modules were
 * injecting mostly to reach it.
 */
@Injectable()
export class AgeGateService {
  constructor(
    private readonly clock: ClockService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Minors belong to a parent's account as a child profile, not their own. Every
   * path onto an own-name account must call this, including the edit.
   */
  assertOldEnoughForOwnAccount(birthDate: string): void {
    const born = parseCalendarDate(birthDate);
    if (born === null) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'birthDate must be a calendar date in YYYY-MM-DD format.',
      });
    }

    const now = this.clock.now();
    if (born.getTime() > now.getTime()) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'birthDate cannot be in the future.',
      });
    }

    const minimumAge =
      this.config.get<number>('MIN_SELF_REGISTRATION_AGE') ?? MIN_SELF_REGISTRATION_AGE_DEFAULT;
    if (ageInYears(born, now) < minimumAge) {
      throw new ForbiddenException({
        errorCode: ErrorCode.UNDERAGE_SELF_REGISTRATION,
        message: `You must be at least ${minimumAge} to create your own account. Ask a parent to add you to their account.`,
      });
    }
  }
}
