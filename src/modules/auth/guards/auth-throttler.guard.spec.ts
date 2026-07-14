import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerLimitDetail } from '@nestjs/throttler';
import { Request, Response } from 'express';

import { AuthThrottlerGuard } from './auth-throttler.guard';
import { ErrorCode } from '../../../shared/errors/error-codes';

describe('AuthThrottlerGuard', () => {
  const makeGuard = (): AuthThrottlerGuard =>
    Object.create(AuthThrottlerGuard.prototype) as AuthThrottlerGuard;

  describe('getTracker', () => {
    it('keys on x-forwarded-for IP plus the email identifier from the body', async () => {
      const guard = makeGuard();
      const req: Partial<Request> = {
        ips: ['203.0.113.7'],
        ip: '10.0.0.1',
        body: { email: 'User@Example.com' },
      };

      const tracker = await guard['getTracker'](req as Request);

      expect(tracker).toBe('203.0.113.7|user@example.com');
    });

    it('falls back to req.ip and empty identifier when no proxy IP / no email', async () => {
      const guard = makeGuard();
      const req: Partial<Request> = { ips: [], ip: '10.0.0.1', body: {} };

      const tracker = await guard['getTracker'](req as Request);

      expect(tracker).toBe('10.0.0.1|');
    });
  });

  describe('throwThrottlingException', () => {
    it('throws a 429 HttpException with an object body carrying RATE_LIMITED and sets Retry-After', async () => {
      const guard = makeGuard();
      const setHeader = jest.fn();
      const req = {} as Request;
      const res = { setHeader } as unknown as Response;
      const context = {
        switchToHttp: () => ({
          getRequest: (): Request => req,
          getResponse: (): Response => res,
        }),
      } as unknown as ExecutionContext;
      const detail: ThrottlerLimitDetail = {
        limit: 5,
        ttl: 60000,
        key: 'k',
        tracker: 't',
        totalHits: 6,
        timeToExpire: 42,
        isBlocked: true,
        timeToBlockExpire: 42,
      };

      await expect(guard['throwThrottlingException'](context, detail)).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });

      try {
        await guard['throwThrottlingException'](context, detail);
        fail('expected throw');
      } catch (err) {
        const exception = err as HttpException;
        expect(exception.getStatus()).toBe(429);
        expect(exception.getResponse()).toEqual({
          errorCode: ErrorCode.RATE_LIMITED,
          message: 'Too many requests',
        });
      }
      expect(setHeader).toHaveBeenCalledWith('Retry-After', 42);
    });
  });
});
