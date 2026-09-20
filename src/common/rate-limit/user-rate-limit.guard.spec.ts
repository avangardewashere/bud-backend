import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RATE_LIMIT_KEY,
  UserRateLimitGuard,
  type RateLimitOptions,
} from './user-rate-limit.guard.js';

/** Minimal ExecutionContext: the guard only reads the request, reply and class. */
interface TestContext extends ExecutionContext {
  reply: { header: ReturnType<typeof vi.fn> };
}

function makeContext(userId?: string, className = 'ProgressController'): TestContext {
  const reply = { header: vi.fn() };

  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: userId ? { id: userId } : undefined }),
      getResponse: () => reply,
    }),
    getHandler: () => () => undefined,
    getClass: () => ({ name: className }),
    reply,
  } as unknown as TestContext;
}

function guardWith(options: RateLimitOptions | undefined): UserRateLimitGuard {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
    key === RATE_LIMIT_KEY ? options : undefined,
  );
  return new UserRateLimitGuard(reflector);
}

describe('UserRateLimitGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lets everything through on routes with no limit', () => {
    const guard = guardWith(undefined);

    for (let i = 0; i < 1000; i += 1) {
      expect(guard.canActivate(makeContext('user-1'))).toBe(true);
    }
  });

  it('allows a burst, then refuses', () => {
    const guard = guardWith({ perMinute: 60, burst: 5 });

    for (let i = 0; i < 5; i += 1) {
      expect(guard.canActivate(makeContext('user-1'))).toBe(true);
    }

    expect(() => guard.canActivate(makeContext('user-1'))).toThrowError(/too quickly/i);
  });

  it('refills continuously rather than on a window boundary', () => {
    // Typing is bursty; a fixed window would refuse the tail of a burst that
    // happened to straddle a boundary, and the learner would see "not saved".
    const guard = guardWith({ perMinute: 60, burst: 2 });

    guard.canActivate(makeContext('user-1'));
    guard.canActivate(makeContext('user-1'));
    expect(() => guard.canActivate(makeContext('user-1'))).toThrow();

    // One token per second at 60/min.
    vi.advanceTimersByTime(1_100);
    expect(guard.canActivate(makeContext('user-1'))).toBe(true);
  });

  it('never refills past the burst ceiling', () => {
    const guard = guardWith({ perMinute: 600, burst: 3 });

    guard.canActivate(makeContext('user-1'));
    vi.advanceTimersByTime(60_000);

    for (let i = 0; i < 3; i += 1) {
      expect(guard.canActivate(makeContext('user-1'))).toBe(true);
    }
    expect(() => guard.canActivate(makeContext('user-1'))).toThrow();
  });

  it('buckets each user separately', () => {
    const guard = guardWith({ perMinute: 60, burst: 1 });

    expect(guard.canActivate(makeContext('user-1'))).toBe(true);
    expect(() => guard.canActivate(makeContext('user-1'))).toThrow();

    // One learner typing must not throttle another.
    expect(guard.canActivate(makeContext('user-2'))).toBe(true);
  });

  it('sets Retry-After so the player can back off honestly', () => {
    const guard = guardWith({ perMinute: 60, burst: 1 });
    const context = makeContext('user-1');

    guard.canActivate(context);
    expect(() => guard.canActivate(context)).toThrow();

    expect(context.reply.header).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('carries the rate_limited code, not just a status', () => {
    const guard = guardWith({ perMinute: 60, burst: 1 });
    guard.canActivate(makeContext('user-1'));

    try {
      guard.canActivate(makeContext('user-1'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { code: string }).code).toBe('rate_limited');
      expect((error as { getStatus(): number }).getStatus()).toBe(429);
    }
  });

  it('does not bucket unauthenticated callers together', () => {
    const guard = guardWith({ perMinute: 60, burst: 1 });

    // The session guard runs first, so this should not happen — but bucketing
    // everyone under "undefined" would be worse than letting them through.
    expect(guard.canActivate(makeContext(undefined))).toBe(true);
    expect(guard.canActivate(makeContext(undefined))).toBe(true);
  });
});
