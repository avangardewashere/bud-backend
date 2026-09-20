import { Injectable, Logger } from '@nestjs/common';

/**
 * Per-identifier brute-force brake on the login endpoint, on top of the global
 * request rate limit.
 *
 * Deliberately in-memory and therefore per-instance. Rule 1 in
 * Tech-Information.md section 10 says no in-memory state that *matters* — this
 * is best-effort defence in depth, not a correctness guarantee. At the Small
 * tier there is exactly one API instance, so it is exact; when a second replica
 * appears, move the counter to Redis alongside sessions. The failure mode of
 * being wrong is "an attacker gets N attempts per replica instead of N", which
 * is acceptable at this scale and documented rather than hidden.
 */
@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);

  private static readonly MAX_FAILURES = 10;
  private static readonly WINDOW_MS = 15 * 60 * 1000;
  /** Cap the map so a flood of unique identifiers cannot grow it without bound. */
  private static readonly MAX_TRACKED = 10_000;

  private readonly failures = new Map<string, { count: number; firstAt: number }>();

  /** Identifier is email + client IP: neither alone should lock the other out. */
  static key(email: string, ip: string | undefined): string {
    return `${email}|${ip ?? 'unknown'}`;
  }

  isBlocked(key: string): boolean {
    const entry = this.failures.get(key);
    if (!entry) {
      return false;
    }

    if (Date.now() - entry.firstAt > LoginThrottleService.WINDOW_MS) {
      this.failures.delete(key);
      return false;
    }

    return entry.count >= LoginThrottleService.MAX_FAILURES;
  }

  /** Seconds until the window resets, for the Retry-After header. */
  retryAfterSeconds(key: string): number {
    const entry = this.failures.get(key);
    if (!entry) {
      return 0;
    }
    const elapsed = Date.now() - entry.firstAt;
    return Math.max(1, Math.ceil((LoginThrottleService.WINDOW_MS - elapsed) / 1000));
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const entry = this.failures.get(key);

    if (!entry || now - entry.firstAt > LoginThrottleService.WINDOW_MS) {
      this.evictIfFull();
      this.failures.set(key, { count: 1, firstAt: now });
      return;
    }

    entry.count += 1;

    if (entry.count === LoginThrottleService.MAX_FAILURES) {
      // Log the fact, never the credential.
      this.logger.warn(`Login throttled after ${entry.count} failures for ${key}`);
    }
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  private evictIfFull(): void {
    if (this.failures.size < LoginThrottleService.MAX_TRACKED) {
      return;
    }

    const cutoff = Date.now() - LoginThrottleService.WINDOW_MS;
    for (const [key, entry] of this.failures) {
      if (entry.firstAt < cutoff) {
        this.failures.delete(key);
      }
    }

    // Still full of live entries: drop the oldest insertion to stay bounded.
    if (this.failures.size >= LoginThrottleService.MAX_TRACKED) {
      const oldest = this.failures.keys().next();
      if (!oldest.done) {
        this.failures.delete(oldest.value);
      }
    }
  }
}
