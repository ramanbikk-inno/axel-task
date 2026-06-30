import { ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { Request, Response } from 'express';

import { ErrorCode } from '../../../shared/errors/error-codes';

@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    const ip: string =
      Array.isArray(req.ips) && req.ips.length > 0 ? req.ips[0] : (req.ip ?? 'unknown');
    const body: unknown = req.body;
    const rawEmail: unknown =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['email']
        : undefined;
    const identifier: string = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    return `${ip}|${identifier}`;
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
