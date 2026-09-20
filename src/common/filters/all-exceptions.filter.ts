import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  /** Field-level detail from the Zod pipe, when present. */
  errors?: unknown;
  path: string;
  timestamp: string;
}

/**
 * One error shape for the whole API, so the frontend has exactly one branch to
 * write. Unexpected errors are logged in full and reported as a bare 500 —
 * stack traces and database internals never cross the wire.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const body = this.toErrorBody(exception, request.url);

    if (body.statusCode >= 500) {
      this.logger.error(
        { err: exception, path: request.url, method: request.method },
        'Unhandled exception',
      );
    }

    void reply.status(body.statusCode).send(body);
  }

  private toErrorBody(exception: unknown, path: string): ErrorBody {
    const timestamp = new Date().toISOString();

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'string') {
        return {
          statusCode,
          error: exception.name,
          message: response,
          path,
          timestamp,
        };
      }

      const payload = response as { message?: unknown; error?: unknown; errors?: unknown };

      return {
        statusCode,
        error: typeof payload.error === 'string' ? payload.error : exception.name,
        message: AllExceptionsFilter.messageOf(payload.message, exception.message),
        ...(payload.errors ? { errors: payload.errors } : {}),
        path,
        timestamp,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrismaError(exception, path, timestamp);
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'InternalServerError',
      message: 'Something went wrong.',
      path,
      timestamp,
    };
  }

  /** Nest puts a string, a string[] (class-validator style) or nothing in `message`. */
  private static messageOf(message: unknown, fallback: string): string {
    if (typeof message === 'string') {
      return message;
    }
    if (Array.isArray(message) && message.every((m) => typeof m === 'string')) {
      return message.join('; ');
    }
    return fallback;
  }

  /**
   * Translates the handful of Prisma errors that are really client errors.
   * Everything else stays a 500 — an unexpected database error is our bug,
   * and its message may describe the schema.
   */
  private fromPrismaError(
    exception: Prisma.PrismaClientKnownRequestError,
    path: string,
    timestamp: string,
  ): ErrorBody {
    switch (exception.code) {
      case 'P2002':
        return {
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          message: 'That record already exists.',
          path,
          timestamp,
        };
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          error: 'NotFound',
          message: 'Not found.',
          path,
          timestamp,
        };
      case 'P2003':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'BadRequest',
          message: 'Referenced record does not exist.',
          path,
          timestamp,
        };
      default:
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'InternalServerError',
          message: 'Something went wrong.',
          path,
          timestamp,
        };
    }
  }
}
