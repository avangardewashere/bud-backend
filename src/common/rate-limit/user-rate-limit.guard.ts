import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply } from 'fastify';

import type { AuthenticatedRequest } from '../../auth/auth.types.js';
import { AppException } from '../errors/app-exception.js';

export interface RateLimitOptions {
  /** Sustained rate. Tokens are refilled continuously, not on a fixed boundary. */
  perMinute: number;
  /** How many requests may arrive at once before the sustained rate applies. */
  burst?: number;
}

export const RATE_LIMIT_KEY = 'bud:rateLimit';

/** Per-user allowance for a route, on top of the global per-IP limit. */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Per-user rate limiting for the endpoints the course bridge hammers.
 *
 * The global limiter keys on IP, which is wrong for these two reasons: every
 * learner behind one NAT shares a bucket, and in development every browser tab
 * shares 127.0.0.1. The worksheets debounce at 400 ms and save on nearly every
 * keystroke, so a learner taking notes generates a sustained couple of writes a
 * second — enough to trip a limit sized for ordinary API traffic.
 *
 * A token bucket rather than a fixed window, because typing is bursty: a fixed
 * window rejects the second half of a burst that arrives just before a
 * boundary, which would surface to the learner as "not saved" for no reason.
 *
 * In-memory and therefore per-instance, exactly like the login throttle. At the
 * Small tier there is one instance, so it is exact; when a second replica
 * appears this moves to Redis with sessions. The failure mode of being wrong is
 * a learner getting N times the allowance, which is not a threat.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(UserRateLimitGuard.name);
  private readonly buckets = new Map<string, Bucket>();

  /** Bounded so a flood of distinct users cannot grow the map without limit. */
  private static readonly MAX_TRACKED = 10_000;

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!options) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.id;

    // Unauthenticated requests never reach a rate-limited route — the session
    // guard runs first — but if that ever changes, fall through rather than
    // bucketing everyone together under "undefined".
    if (!userId) {
      return true;
    }

    const burst = options.burst ?? options.perMinute;
    const key = `${userId}:${context.getClass().name}`;
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: burst, lastRefill: now };

    const refill = ((now - bucket.lastRefill) / 60_000) * options.perMinute;
    bucket.tokens = Math.min(burst, bucket.tokens + refill);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const secondsToNextToken = Math.ceil((1 - bucket.tokens) / (options.perMinute / 60));
      const reply = context.switchToHttp().getResponse<FastifyReply>();
      reply.header('Retry-After', String(secondsToNextToken));

      this.buckets.set(key, bucket);
      this.logger.warn(`Rate limited ${context.getClass().name} for user ${userId}`);

      throw new AppException(
        'rate_limited',
        'Saving too quickly. Your work will be saved in a moment.',
        HttpStatus.TOO_MANY_REQUESTS,
        `Retry after ${secondsToNextToken}s.`,
      );
    }

    bucket.tokens -= 1;
    this.evictIfFull();
    this.buckets.set(key, bucket);

    return true;
  }

  private evictIfFull(): void {
    if (this.buckets.size < UserRateLimitGuard.MAX_TRACKED) {
      return;
    }

    // A full bucket is an idle user; drop the ones that have recovered.
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens >= 1) {
        this.buckets.delete(key);
      }
    }

    if (this.buckets.size >= UserRateLimitGuard.MAX_TRACKED) {
      const oldest = this.buckets.keys().next();
      if (!oldest.done) {
        this.buckets.delete(oldest.value);
      }
    }
  }
}
