import { describe, expect, it } from 'vitest';

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

  it('flags hashes made with weaker parameters for rehash', async () => {
    const current = await passwords.hash('password-to-check');
    expect(passwords.needsRehash(current)).toBe(false);

    // An old hash from before the parameters were raised.
    expect(passwords.needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(passwords.needsRehash('garbage')).toBe(true);
  });
});
