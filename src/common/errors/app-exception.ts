import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Stable, machine-readable error identifiers.
 *
 * The shell branches on `code`, never on `message`: matching on English couples
 * a test suite in one repo to prose in another, and makes rewording a sentence
 * a breaking change. Codes are frozen once published; messages are free.
 */
export const ERROR_CODES = [
  // generic, derived from the status when nothing more specific is thrown
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'rate_limited',
  'internal_error',

  // auth
  'invalid_credentials',
  'signup_closed',
  'invite_invalid',
  'email_taken',

  // course packages
  'course_version_exists',
  'course_has_no_versions',
  'unknown_course_version',

  // bridge storage (Overall Plan §3)
  'storage_key_limit_reached',
  'storage_value_too_large',
  'storage_quota_exceeded',
  'not_enrolled',
  'unknown_session',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * An HttpException that carries a `code`. The global filter copies it onto the
 * error envelope; anything thrown without one still gets a code derived from
 * its status, so the field is present on every error rather than only the ones
 * somebody remembered.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    readonly detail?: string,
  ) {
    super({ code, message, ...(detail ? { detail } : {}) }, status);
  }
}

/**
 * The code an error gets when it was not thrown with one.
 *
 * A lookup rather than a switch: the input is a plain number from
 * `exception.getStatus()`, and comparing it against enum members is either an
 * unsafe comparison or a pointless cast, depending on which rule you ask.
 */
const CODE_BY_STATUS: Record<number, ErrorCode> = {
  [HttpStatus.BAD_REQUEST]: 'validation_failed',
  [HttpStatus.UNAUTHORIZED]: 'unauthorized',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'payload_too_large',
  [HttpStatus.TOO_MANY_REQUESTS]: 'rate_limited',
};

export function defaultCodeForStatus(status: number): ErrorCode {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal_error' : 'validation_failed');
}
