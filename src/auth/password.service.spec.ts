import { describe, expect, it, vi } from 'vitest';

import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('produces an argon2id hash that verifies', async () => {
    const hash = await passwords.hash('correct horse battery staple');

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(passwords.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await passwords.hash('correct horse battery staple');

    await expect(passwords.verify(hash, 'Correct horse battery staple')).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([
      passwords.hash('same-password'),
      passwords.hash('same-password'),
    ]);

    expect(a).not.toBe(b);
  });

  it('treats a malformed stored hash as a failed verify, not a crash', async () => {
    await expect(passwords.verify('not-a-hash', 'whatever')).resolves.toBe(false);
  });

  it('always fails the dummy verify', async () => {
    await expect(passwords.verifyDummy('whatever')).resolves.toBe(false);
  });

  it('has the dummy hash ready before the first request, not after it', async () => {
    // The point of the dummy is that a login for an address with no account
    // costs what a wrong password costs. Built on first use instead, that first
    // login paid a hash *and* a verify — about double — so the one request the
    // dummy exists for was the one it did not cover. Nest awaits onModuleInit
    // before the app listens; a free instance that sleeps makes "the first
    // request of the process" a recurring event, not a one-off at deploy.
    //
    // Asserted by counting the hash, not by timing it: the invariant is "no
    // extra argon2 operation on the request path", and a stopwatch on a shared
    // CI runner measures the runner.
    const cold = new PasswordService();
    await cold.onModuleInit();

    const hashing = vi.spyOn(cold, 'hash');
    await cold.verifyDummy('whatever');

    expect(hashing).not.toHaveBeenCalled();
  });

  it('flags hashes made with weaker parameters for rehash', async () => {
    const current = await passwords.hash('password-to-check');
    expect(passwords.needsRehash(current)).toBe(false);

    // An old hash from before the parameters were raised.
    expect(passwords.needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(passwords.needsRehash('garbage')).toBe(true);
  });
});

describe('PasswordService without Nest', () => {
  it('still hashes the dummy only once when nothing called onModuleInit', async () => {
    // A CLI news the service up directly, so the lazy guard has to stay.
    const passwords = new PasswordService();
    const hashing = vi.spyOn(passwords, 'hash');

    await passwords.verifyDummy('whatever');
    await passwords.verifyDummy('whatever');

    expect(hashing).toHaveBeenCalledOnce();
  });
});
