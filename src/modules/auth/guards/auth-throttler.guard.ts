import { ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { Request, Response } from 'express';

import { ErrorCode } from '../../../shared/errors/error-codes';
import { clientIp } from './throttle-trackers';

@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  /**
   * Fallback only. Each named throttler declares its own tracker in
   * AppModule (see throttle-trackers.ts); this is what a throttler configured
   * without one would get.
   */
  protected async getTracker(req: Request): Promise<string> {
    return clientIp(req);
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response: Response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', throttlerLimitDetail.timeToExpire);
    throw new HttpException(
      { errorCode: ErrorCode.RATE_LIMITED, message: 'Too many requests' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
