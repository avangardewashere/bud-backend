import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * argon2id, per the security checklist in Tech-Information.md section 11.
 *
 * Parameters follow the OWASP baseline (19 MiB memory, 2 iterations, 1 lane).
 * They are recorded inside the hash string, so raising them later does not
 * invalidate existing hashes — `needsRehash` spots the stale ones on login.
 */
@Injectable()
export class PasswordService implements OnModuleInit {
  private static readonly OPTIONS = {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const;

  /**
   * A hash of a value nobody knows, computed once at startup. Login verifies
   * against this when the email does not exist, so a missing account costs the
   * same time as a wrong password and the endpoint cannot be used to enumerate
   * users.
   *
   * "At startup" is what `onModuleInit` is for. Computed on first use instead,
   * that first request paid a hash *and* a verify — roughly twice an existing
   * account's login — so the one request whose timing this field exists to
   * flatten was the one request it did not. The skew ran the safe way (a miss
   * was slower, not faster) and lasted one request, but a Render free instance
   * sleeps, so "once per process" recurs on every cold start.
   */
  private dummyHashPromise?: Promise<string>;

  /**
   * Nest awaits this before the app starts listening, so the first login of a
   * process finds the dummy already there. Bootstrap is the right place to spend
   * ~45ms of argon2; a request is not.
   */
  async onModuleInit(): Promise<void> {
    await this.dummyHash();
  }

  async hash(password: string): Promise<string> {
    return hash(password, PasswordService.OPTIONS);
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password, PasswordService.OPTIONS);
    } catch {
      // A malformed hash in the database is a verification failure, not a 500.
      return false;
    }
  }

  /** Burns the same CPU a real verify would, then fails. */
  async verifyDummy(password: string): Promise<false> {
    await this.verify(await this.dummyHash(), password);
    return false;
  }

  /**
   * The `??=` still guards it: `onModuleInit` is the normal path, and a unit
   * test that news the service up without Nest still gets one hash rather than
   * one per call.
   */
  private async dummyHash(): Promise<string> {
    this.dummyHashPromise ??= this.hash(`dummy:${Math.random()}:${Date.now()}`);
    return this.dummyHashPromise;
  }

  /** True when a stored hash was made with weaker parameters than we now use. */
  needsRehash(storedHash: string): boolean {
    const memory = /m=(\d+)/.exec(storedHash);
    const time = /t=(\d+)/.exec(storedHash);

    if (!memory || !time) {
      return true;
    }

    return (
      Number(memory[1]) < PasswordService.OPTIONS.memoryCost ||
      Number(time[1]) < PasswordService.OPTIONS.timeCost
    );
  }
}
