import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ErrorCode } from './error-codes';

interface ErrorDetail {
  field: string;
  message: string;
}

interface ErrorEnvelope {
  statusCode: number;
  error: string;
  errorCode: ErrorCode;
  message: string;
  details?: ErrorDetail[];
  timestamp: string;
  path: string;
  requestId: string;
}

interface HttpRequestLike {
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

interface HttpResponseLike {
  status(code: number): HttpResponseLike;
  json(body: ErrorEnvelope): HttpResponseLike;
}

interface ObjectExceptionResponse {
  errorCode?: ErrorCode;
  message?: string | string[];
  error?: string;
}

interface UniqueViolationResponse {
  errorCode: ErrorCode;
  message: string;
}

/**
 * The subset of a driver error we can rely on. TypeORM re-throws the pg error
 * with `code` intact on QueryFailedError.
 */
interface DriverErrorLike {
  code?: string;
  constraint?: string;
}

/**
 * Postgres errors that are a client mistake, not a server fault. A lost race on
 * a unique index is the 409 the contract promises, not a 500; a malformed uuid
 * reaching the driver is a 400.
 */
export const PG_UNIQUE_VIOLATION = '23505';
const PG_INVALID_TEXT_REPRESENTATION = '22P02';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private static readonly DEFAULT_CODE_BY_STATUS: Record<number, ErrorCode> = {
    [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_ERROR,
    [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.VALIDATION_ERROR,
    [HttpStatus.UNAUTHORIZED]: ErrorCode.INVALID_CREDENTIALS,
    [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
    [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
    [HttpStatus.CONFLICT]: ErrorCode.EMAIL_ALREADY_EXISTS,
    [HttpStatus.GONE]: ErrorCode.EXPIRED_TOKEN,
    [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
    [HttpStatus.INTERNAL_SERVER_ERROR]: ErrorCode.INTERNAL_ERROR,
  };

  /**
   * A lost race on a unique index has to answer with the same code the
   * application-level pre-check would have used. Keys are the real constraint /
   * index names from the migrations; anything unlisted gets the generic reply.
   */
  private static readonly UNIQUE_VIOLATION_BY_CONSTRAINT: Record<string, UniqueViolationResponse> =
    {
      uq_users_email: {
        errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
        message: 'An account with this email already exists.',
      },
      uq_trainer_player: {
        errorCode: ErrorCode.ALREADY_ASSOCIATED,
        message: 'You are already connected with this trainer.',
      },
      uq_coach_profiles_active_user_id: {
        errorCode: ErrorCode.COACH_ACTIVE_ELSEWHERE,
        message:
          'This coach is currently active with another trainer and must be off-boarded first.',
      },
      uq_player_profiles_child_user_id: {
        errorCode: ErrorCode.CHILD_LOGIN_EXISTS,
        message: 'This child already has a login.',
      },
      uq_share_links_code: {
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'Could not create the share link. Please try again.',
      },
      UQ_refresh_tokens_token_hash: {
        errorCode: ErrorCode.INVALID_TOKEN,
        message: 'Token conflict. Please request a new one.',
      },
      UQ_email_verification_tokens_token_hash: {
        errorCode: ErrorCode.INVALID_TOKEN,
        message: 'Token conflict. Please request a new one.',
      },
      UQ_password_reset_tokens_token_hash: {
        errorCode: ErrorCode.INVALID_TOKEN,
        message: 'Token conflict. Please request a new one.',
      },
      UQ_account_setup_tokens_token_hash: {
        errorCode: ErrorCode.INVALID_TOKEN,
        message: 'Token conflict. Please request a new one.',
      },
    };

  private static readonly GENERIC_UNIQUE_VIOLATION: UniqueViolationResponse = {
    errorCode: ErrorCode.VALIDATION_ERROR,
    message: 'That record already exists.',
  };

  private static readonly ERROR_TITLE_BY_STATUS: Record<number, string> = {
    [HttpStatus.BAD_REQUEST]: 'Bad Request',
    [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
    [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
    [HttpStatus.FORBIDDEN]: 'Forbidden',
    [HttpStatus.NOT_FOUND]: 'Not Found',
    [HttpStatus.CONFLICT]: 'Conflict',
    [HttpStatus.GONE]: 'Gone',
    [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
    [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
  };

  catch(rawException: unknown, host: ArgumentsHost): void {
    const httpCtx = host.switchToHttp();
    const response = httpCtx.getResponse<HttpResponseLike>();
    const request = httpCtx.getRequest<HttpRequestLike>();

    const exception = this.translateDriverError(rawException);
    const status = this.resolveStatus(exception);
    const objectResponse = this.extractObjectResponse(exception);

    const details = this.extractDetails(objectResponse, status);
    const errorCode = this.resolveErrorCode(objectResponse, status);
    const message = this.resolveMessage(objectResponse, status, details);

    const envelope: ErrorEnvelope = {
      statusCode: status,
      error: this.resolveErrorTitle(status),
      errorCode,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
      requestId: this.resolveRequestId(request),
    };

    if (details.length > 0) {
      envelope.details = details;
    }

    response.status(status).json(envelope);
  }

  /**
   * Map a database constraint violation onto the documented envelope. Anything
   * not recognised falls through unchanged and is still reported as a 500,
   * because an unexpected driver error IS a server fault.
   */
  private translateDriverError(exception: unknown): unknown {
    if (exception instanceof HttpException || exception === null || typeof exception !== 'object') {
      return exception;
    }
    const driver = exception as DriverErrorLike;
    switch (driver.code) {
      case PG_UNIQUE_VIOLATION:
        return new HttpException(
          this.uniqueViolationResponse(driver.constraint),
          HttpStatus.CONFLICT,
        );
      case PG_INVALID_TEXT_REPRESENTATION:
        return new HttpException(
          { errorCode: ErrorCode.VALIDATION_ERROR, message: 'Malformed value in request.' },
          HttpStatus.BAD_REQUEST,
        );
      case PG_FOREIGN_KEY_VIOLATION:
        return new HttpException(
          {
            errorCode: ErrorCode.VALIDATION_ERROR,
            message: 'Referenced record does not exist.',
          },
          HttpStatus.BAD_REQUEST,
        );
      case PG_CHECK_VIOLATION:
        return new HttpException(
          { errorCode: ErrorCode.VALIDATION_ERROR, message: 'Value failed a database constraint.' },
          HttpStatus.BAD_REQUEST,
        );
      default:
        return exception;
    }
  }

  private uniqueViolationResponse(constraint: string | undefined): UniqueViolationResponse {
    if (constraint === undefined) {
      return AllExceptionsFilter.GENERIC_UNIQUE_VIOLATION;
    }
    return (
      AllExceptionsFilter.UNIQUE_VIOLATION_BY_CONSTRAINT[constraint] ??
      AllExceptionsFilter.GENERIC_UNIQUE_VIOLATION
    );
  }

  private resolveStatus(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private extractObjectResponse(exception: unknown): ObjectExceptionResponse | null {
    if (!(exception instanceof HttpException)) {
      return null;
    }
    const raw: string | object = exception.getResponse();
    if (typeof raw === 'object' && raw !== null) {
      return raw as ObjectExceptionResponse;
    }
    return null;
  }

  private extractDetails(
    objectResponse: ObjectExceptionResponse | null,
    status: number,
  ): ErrorDetail[] {
    if (objectResponse === null) {
      return [];
    }
    const isValidationStatus =
      status === HttpStatus.BAD_REQUEST || status === HttpStatus.UNPROCESSABLE_ENTITY;
    if (!isValidationStatus || !Array.isArray(objectResponse.message)) {
      return [];
    }
    return objectResponse.message.map((entry: string): ErrorDetail => {
      const field = entry.split(' ')[0] ?? 'unknown';
      return { field, message: entry };
    });
  }

  private resolveErrorCode(
    objectResponse: ObjectExceptionResponse | null,
    status: number,
  ): ErrorCode {
    if (objectResponse !== null && objectResponse.errorCode !== undefined) {
      return objectResponse.errorCode;
    }
    return AllExceptionsFilter.DEFAULT_CODE_BY_STATUS[status] ?? ErrorCode.INTERNAL_ERROR;
  }

  private resolveMessage(
    objectResponse: ObjectExceptionResponse | null,
    status: number,
    details: ErrorDetail[],
  ): string {
    if (details.length > 0) {
      return 'Validation failed';
    }
    if (objectResponse !== null && typeof objectResponse.message === 'string') {
      return objectResponse.message;
    }
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      return 'Internal server error';
    }
    return this.resolveErrorTitle(status);
  }

  private resolveErrorTitle(status: number): string {
    return AllExceptionsFilter.ERROR_TITLE_BY_STATUS[status] ?? 'Internal Server Error';
  }

  private resolveRequestId(request: HttpRequestLike): string {
    const header = request.headers['x-request-id'];
    if (typeof header === 'string' && header.length > 0) {
      return header;
    }
    if (Array.isArray(header) && header.length > 0) {
      return header[0];
    }
    return randomUUID();
  }
}
