import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorCode } from './error-codes';

interface CapturedResponse {
  statusCode: number;
  error: string;
  errorCode: ErrorCode;
  message: string;
  details?: Array<{ field: string; message: string }>;
  timestamp: string;
  path: string;
  requestId: string;
}

function makeHost(
  url: string,
  requestId: string | undefined,
): {
  host: ArgumentsHost;
  captured: () => { status: number; body: CapturedResponse };
} {
  let capturedStatus = 0;
  let capturedBody: CapturedResponse = {} as CapturedResponse;

  interface MockResponse {
    status(code: number): MockResponse;
    json(body: CapturedResponse): MockResponse;
  }

  const response: MockResponse = {
    status(code: number): MockResponse {
      capturedStatus = code;
      return response;
    },
    json(body: CapturedResponse): MockResponse {
      capturedBody = body;
      return response;
    },
  };

  const request = {
    url,
    headers: requestId === undefined ? {} : { 'x-request-id': requestId },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: <T>(): T => response as unknown as T,
      getRequest: <T>(): T => request as unknown as T,
    }),
  } as unknown as ArgumentsHost;

  return {
    host,
    captured: () => ({ status: capturedStatus, body: capturedBody }),
  };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps a 404 NotFoundException to the NOT_FOUND envelope', () => {
    const { host, captured } = makeHost('/api/v1/missing', 'req-1');

    filter.catch(new NotFoundException('Nope'), host);

    const { status, body } = captured();
    expect(status).toBe(404);
    expect(body.statusCode).toBe(404);
    expect(body.error).toBe('Not Found');
    expect(body.errorCode).toBe(ErrorCode.NOT_FOUND);
    expect(body.message).toBe('Nope');
    expect(body.path).toBe('/api/v1/missing');
    expect(body.requestId).toBe('req-1');
    expect(typeof body.timestamp).toBe('string');
    expect(body.details).toBeUndefined();
  });

  it('uses the errorCode carried on an HttpException object response', () => {
    const { host, captured } = makeHost('/api/v1/auth/login', 'req-2');

    filter.catch(
      new ConflictException({
        errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
        message: 'An account with this email already exists.',
      }),
      host,
    );

    const { status, body } = captured();
    expect(status).toBe(409);
    expect(body.error).toBe('Conflict');
    expect(body.errorCode).toBe(ErrorCode.EMAIL_ALREADY_EXISTS);
    expect(body.message).toBe('An account with this email already exists.');
  });

  it('maps a 410 GoneException to EXPIRED_TOKEN with title Gone', () => {
    const { host, captured } = makeHost('/api/v1/auth/verify-email', undefined);

    filter.catch(
      new GoneException({
        errorCode: ErrorCode.EXPIRED_TOKEN,
        message: 'This link has expired.',
      }),
      host,
    );

    const { status, body } = captured();
    expect(status).toBe(410);
    expect(body.error).toBe('Gone');
    expect(body.errorCode).toBe(ErrorCode.EXPIRED_TOKEN);
    expect(body.message).toBe('This link has expired.');
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it('maps a 429 to RATE_LIMITED', () => {
    const { host, captured } = makeHost('/api/v1/auth/login', 'req-3');

    filter.catch(new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS), host);

    const { body } = captured();
    expect(body.errorCode).toBe(ErrorCode.RATE_LIMITED);
    expect(body.error).toBe('Too Many Requests');
  });

  it('expands class-validator BadRequest message arrays into details with VALIDATION_ERROR', () => {
    const { host, captured } = makeHost('/api/v1/auth/register', 'req-4');

    filter.catch(
      new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: ['email must be an email', 'password is too short'],
      }),
      host,
    );

    const { status, body } = captured();
    expect(status).toBe(400);
    expect(body.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.message).toBe('Validation failed');
    expect(body.details).toEqual([
      { field: 'email', message: 'email must be an email' },
      { field: 'password', message: 'password is too short' },
    ]);
  });

  it('maps an unknown (non-HttpException) error to a 500 INTERNAL_ERROR envelope', () => {
    const { host, captured } = makeHost('/api/v1/boom', 'req-5');

    filter.catch(new Error('kaboom'), host);

    const { status, body } = captured();
    expect(status).toBe(500);
    expect(body.error).toBe('Internal Server Error');
    expect(body.errorCode).toBe(ErrorCode.INTERNAL_ERROR);
    expect(body.message).toBe('Internal server error');
  });

  it('honors a default InternalServerErrorException as INTERNAL_ERROR', () => {
    const { host, captured } = makeHost('/api/v1/boom', 'req-6');

    filter.catch(new InternalServerErrorException(), host);

    const { body } = captured();
    expect(body.errorCode).toBe(ErrorCode.INTERNAL_ERROR);
  });
  describe('database constraint violations', () => {
    // A read-then-write existence check loses races; the loser used to get a
    // 500 instead of the 409 the contract documents.
    it('maps a unique-email violation to 409 EMAIL_ALREADY_EXISTS', () => {
      const { host, captured } = makeHost('/api/v1/users', 'req-7');

      filter.catch(
        Object.assign(new Error('duplicate key value'), {
          code: '23505',
          constraint: 'uq_users_email',
        }),
        host,
      );

      const { status, body } = captured();
      expect(status).toBe(409);
      expect(body.errorCode).toBe(ErrorCode.EMAIL_ALREADY_EXISTS);
      expect(body.message).toBe('An account with this email already exists.');
    });

    it('maps a non-email unique violation to a generic 409', () => {
      const { host, captured } = makeHost('/api/v1/coaches', 'req-8');

      filter.catch(
        Object.assign(new Error('duplicate key value'), {
          code: '23505',
          constraint: 'uq_coach_profiles_user_id',
        }),
        host,
      );

      const { status, body } = captured();
      expect(status).toBe(409);
      expect(body.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it.each([
      ['22P02', 400, 'malformed value'],
      ['23503', 400, 'missing foreign key'],
      ['23514', 400, 'check constraint'],
    ])('maps pg %s to %i', (code: string, expected: number) => {
      const { host, captured } = makeHost('/api/v1/x', 'req-9');

      filter.catch(Object.assign(new Error('driver'), { code }), host);

      const { status, body } = captured();
      expect(status).toBe(expected);
      expect(body.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('still reports an unrecognised driver error as 500', () => {
      // An unexpected database failure IS a server fault and must not be
      // laundered into a 4xx.
      const { host, captured } = makeHost('/api/v1/x', 'req-10');

      filter.catch(Object.assign(new Error('connection reset'), { code: '08006' }), host);

      const { status, body } = captured();
      expect(status).toBe(500);
      expect(body.errorCode).toBe(ErrorCode.INTERNAL_ERROR);
    });

    it('does not rewrite an HttpException that happens to carry a code', () => {
      const { host, captured } = makeHost('/api/v1/x', 'req-11');

      filter.catch(Object.assign(new InternalServerErrorException(), { code: '23505' }), host);

      expect(captured().status).toBe(500);
    });
  });
});
