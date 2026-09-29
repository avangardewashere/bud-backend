import { describe, expect, it } from 'vitest';

import { readEmailArgument } from './email-argument.js';

/**
 * The CLIs used to carry a looser email regex than the API validates with, so
 * `npm run invite` could mint a link its invitee could never redeem, and
 * `npm run admin:create` could create an admin who could never sign in. This is
 * the seam where that cannot happen again.
 */
describe('readEmailArgument', () => {
  it('normalises the address the same way the API does', () => {
    expect(readEmailArgument(' Someone@Example.COM ')).toEqual({
      ok: true,
      email: 'someone@example.com',
    });
  });

  it('asks for an address when there is none', () => {
    expect(readEmailArgument(undefined)).toMatchObject({ ok: false });
    expect(readEmailArgument('   ')).toMatchObject({
      ok: false,
      problem: expect.stringContaining('required'),
    });
  });

  it.each([
    // Every one of these passed the CLIs' own /^[^@\s]+@[^@\s]+\.[^@\s]+$/ and
    // is refused by the schema the API validates with.
    ['a non-ASCII local part', 'josé@example.com'],
    ['a non-ASCII domain', 'bob@exämple.com'],
    ['a doubled dot', 'bob..x@example.com'],
    ['a single-character TLD', 'bob@example.c'],
    ['a bracketed IP literal', 'bob@[127.0.0.1]'],
    ['a trailing dot', 'bob@example.com.'],
    // U+200B is not whitespace to String.trim or to \s, so it survived both.
    ['an invisible character', 'bob​@example.com'],
    ['an address longer than the column', `${'a'.repeat(330)}@example.com`],
  ])('refuses %s, rather than writing a row nobody can use', (_case, input) => {
    const outcome = readEmailArgument(input);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // The message quotes the address back and says whose opinion it is, so an
      // operator is not left guessing which of two validators disagreed.
      expect(outcome.problem).toContain('the API would accept');
    }
  });
});
