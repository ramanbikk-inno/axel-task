import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuthService } from './auth.service';

const NOW = new Date('2026-07-26T12:00:00.000Z');

class FixedClock extends ClockService {
  now(): Date {
    return NOW;
  }
}

/**
 * `assertOldEnoughForOwnAccount` reads only the clock and the configured
 * threshold, so the rest of AuthService's dependencies are left unset rather
 * than stubbed into noise. If that ever stops being true this will fail loudly
 * on a null dereference, which is the correct outcome.
 */
function build(minimumAge?: number): AuthService {
  const config = {
    get: jest.fn().mockReturnValue(minimumAge),
  } as unknown as ConfigService;
  const unused = null as never;
  return new AuthService(
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    new FixedClock(),
    unused,
    unused,
    unused,
    config,
    unused,
  );
}

const expectRejection = (
  minimumAge: number | undefined,
  birthDate: string,
  type: typeof BadRequestException | typeof ForbiddenException,
  errorCode: ErrorCode,
): void => {
  const service = build(minimumAge);
  expect(() => service.assertOldEnoughForOwnAccount(birthDate)).toThrow(type);
  try {
    service.assertOldEnoughForOwnAccount(birthDate);
  } catch (error) {
    expect(
      ((error as BadRequestException).getResponse() as { errorCode: ErrorCode }).errorCode,
    ).toBe(errorCode);
  }
};

/**
 * Minors cannot hold an account in their own name. The boundary days are the
 * substance of the rule: an off-by-one is the difference between admitting and
 * refusing a minor.
 */
describe('AuthService.assertOldEnoughForOwnAccount', () => {
  describe('at the default threshold of 18', () => {
    it('admits an applicant on the morning of their eighteenth birthday', () => {
      expect(() => build(18).assertOldEnoughForOwnAccount('2008-07-26')).not.toThrow();
    });

    it('refuses the same applicant one day earlier', () => {
      expectRejection(18, '2008-07-27', ForbiddenException, ErrorCode.UNDERAGE_SELF_REGISTRATION);
    });

    it('admits an adult', () => {
      expect(() => build(18).assertOldEnoughForOwnAccount('1994-03-22')).not.toThrow();
    });

    it('refuses a child', () => {
      expectRejection(18, '2015-01-01', ForbiddenException, ErrorCode.UNDERAGE_SELF_REGISTRATION);
    });

    it('refuses someone born today rather than treating age 0 as unset', () => {
      expectRejection(18, '2026-07-26', ForbiddenException, ErrorCode.UNDERAGE_SELF_REGISTRATION);
    });

    it('handles a 29 February birthday, which does not exist in the current year', () => {
      // Turns 18 on 1 March 2026, because 29 Feb has not passed on 28 Feb.
      expect(() => build(18).assertOldEnoughForOwnAccount('2008-02-29')).not.toThrow();
    });

    it('names the threshold in the message, so the UI need not hardcode it', () => {
      try {
        build(18).assertOldEnoughForOwnAccount('2015-01-01');
        throw new Error('expected a rejection');
      } catch (error) {
        const body = (error as ForbiddenException).getResponse() as { message: string };
        expect(body.message).toContain('18');
      }
    });
  });

  describe('with the threshold configured elsewhere', () => {
    it('admits a sixteen-year-old once the floor is 16', () => {
      expect(() => build(16).assertOldEnoughForOwnAccount('2010-07-26')).not.toThrow();
    });

    it('still refuses a fifteen-year-old at that floor', () => {
      expectRejection(16, '2010-07-27', ForbiddenException, ErrorCode.UNDERAGE_SELF_REGISTRATION);
    });

    it('admits anyone born in the past when the floor is 0', () => {
      expect(() => build(0).assertOldEnoughForOwnAccount('2026-07-26')).not.toThrow();
    });

    it('falls back to 18 when the setting is missing', () => {
      // Defence in depth: the zod schema already defaults it, so this only
      // matters if the service is ever constructed outside that validation.
      expectRejection(
        undefined,
        '2015-01-01',
        ForbiddenException,
        ErrorCode.UNDERAGE_SELF_REGISTRATION,
      );
      expect(() => build(undefined).assertOldEnoughForOwnAccount('1994-03-22')).not.toThrow();
    });
  });

  describe('malformed input is a 400, not a 403', () => {
    it('rejects a value that is not a date at all', () => {
      expectRejection(18, 'yesterday', BadRequestException, ErrorCode.VALIDATION_ERROR);
    });

    it('rejects a date carrying a time component', () => {
      // The regression that made this a shared helper: an ISO date-time used to
      // pass validation, produce an Invalid Date, and compare false against
      // every bound — so the age gate let anything through.
      expectRejection(
        18,
        '2015-01-01T00:00:00.000Z',
        BadRequestException,
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('rejects a day that does not exist', () => {
      expectRejection(18, '2008-02-30', BadRequestException, ErrorCode.VALIDATION_ERROR);
    });

    it('rejects an empty string', () => {
      expectRejection(18, '', BadRequestException, ErrorCode.VALIDATION_ERROR);
    });

    it('rejects a future birth date as malformed rather than as underage', () => {
      // A 403 would tell the caller their date was understood and refused; it
      // was not understood.
      expectRejection(18, '2027-01-01', BadRequestException, ErrorCode.VALIDATION_ERROR);
    });

    it('treats yesterday as a real date, not a malformed one', () => {
      // Distinguishes "in the future" from "very recent": only the former is a
      // 400. At a floor of 0 this is simply someone aged 0.
      expect(() => build(0).assertOldEnoughForOwnAccount('2026-07-25')).not.toThrow();
    });
  });
});
