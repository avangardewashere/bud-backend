import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * argon2id, per the security checklist in Tech-Information.md section 11.
 *
 * Parameters follow the OWASP baseline (19 MiB memory, 2 iterations, 1 lane).
 * They are recorded inside the hash string, so raising them later does not
 * invalidate existing hashes — `needsRehash` spots the stale ones on login.
 */
@Injectable()
export class PasswordService {
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
   */
  private dummyHashPromise?: Promise<string>;

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
    this.dummyHashPromise ??= this.hash(`dummy:${Math.random()}:${Date.now()}`);
    await this.verify(await this.dummyHashPromise, password);
    return false;
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
