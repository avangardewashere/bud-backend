import { describe, expect, it } from 'vitest';

import { SHELL_SIGN_IN_ERRORS } from './github-oauth.controller.js';

/**
 * The GitHub sign-in failure reasons are a cross-repo contract that travels in a
 * URL rather than a JSON envelope, which is why it needs a test of its own.
 *
 * The shell maps each value to a sentence on its sign-in screen. Renaming one
 * breaks no type here and no type there — it just shows someone an unexplained
 * failure. The union type makes *adding* an unlisted value a compile error; this
 * pins the spelling, which is the part a compiler cannot see.
 *
 * If a value has to change: change it in the shell first, ship that, then here.
 */
describe('the sign-in error values the shell renders', () => {
  it('is exactly this list', () => {
    expect([...SHELL_SIGN_IN_ERRORS]).toEqual([
      'github_declined',
      'github_state_mismatch',
      'github_no_code',
      'signup_closed',
      'github_failed',
    ]);
  });

  it('has no duplicates, so no two reasons collapse into one sentence', () => {
    expect(new Set(SHELL_SIGN_IN_ERRORS).size).toBe(SHELL_SIGN_IN_ERRORS.length);
  });
});
