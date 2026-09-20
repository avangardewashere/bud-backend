import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginThrottleService } from './login-throttle.service.js';

describe('LoginThrottleService', () => {
  let throttle: LoginThrottleService;
  const key = LoginThrottleService.key('learner@bud.local', '203.0.113.10');

  beforeEach(() => {
    throttle = new LoginThrottleService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keys on email and IP together', () => {
    const sameEmailOtherIp = LoginThrottleService.key('learner@bud.local', '198.51.100.7');

    expect(key).not.toBe(sameEmailOtherIp);
  });

  it('allows attempts below the threshold', () => {
    for (let i = 0; i < 9; i += 1) {
      throttle.recordFailure(key);
    }

    expect(throttle.isBlocked(key)).toBe(false);
  });

  it('blocks once the threshold is reached', () => {
    for (let i = 0; i < 10; i += 1) {
      throttle.recordFailure(key);
    }

    expect(throttle.isBlocked(key)).toBe(true);
    expect(throttle.retryAfterSeconds(key)).toBeGreaterThan(0);
  });

  it('does not block a different identifier', () => {
    for (let i = 0; i < 10; i += 1) {
      throttle.recordFailure(key);
    }

    expect(throttle.isBlocked(LoginThrottleService.key('other@bud.local', '203.0.113.10'))).toBe(
      false,
    );
  });

  it('clears the counter on a successful sign-in', () => {
    for (let i = 0; i < 9; i += 1) {
      throttle.recordFailure(key);
    }
    throttle.recordSuccess(key);
    throttle.recordFailure(key);

    expect(throttle.isBlocked(key)).toBe(false);
  });

  it('forgets failures once the window has passed', () => {
    for (let i = 0; i < 10; i += 1) {
      throttle.recordFailure(key);
    }
    expect(throttle.isBlocked(key)).toBe(true);

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);

    expect(throttle.isBlocked(key)).toBe(false);
  });
});
