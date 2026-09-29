import { beforeAll, describe, expect, it } from 'vitest';

import { ApiClient, apiIsUp, ensureTestUser } from './client.js';

/**
 * `POST /auth/register` must not become a way to ask whether an address has an
 * account.
 *
 * auth.service.spec.ts proves the service never looks the address up before
 * refusing. This proves the same thing about what actually leaves the process:
 * the status, the code the shell branches on, the message, and the headers —
 * through the real exception filter, in the configuration CI and Render run.
 *
 * Both halves are needed. The unit test would pass on code that leaked the
 * answer in a header the service never sees; this one would pass on code that
 * looked the address up and then carefully said nothing, which still answers by
 * how long it takes.
 */

const REGISTERED = 'e2e-register-taken@bud.local';
const PASSWORD = 'e2e-register-password-123';
/** Nothing has ever registered this, and nothing in the suite creates it. */
const UNREGISTERED = 'e2e-register-free-nobody@bud.local';

const up = await apiIsUp();

/**
 * The parts of a refusal a caller can see, minus the clock. `timestamp` differs
 * between any two responses and says nothing about either address; everything
 * else in the envelope — statusCode, error, code, message, path — must match, as
 * must whether a cookie came back.
 */
function answerOf(response: { status: number; body: unknown; headers: Headers }) {
  const { timestamp: _clock, ...body } = (response.body ?? {}) as Record<string, unknown>;

  return {
    status: response.status,
    body,
    setCookie: response.headers.has('set-cookie'),
  };
}

describe.skipIf(!up)('register cannot be asked whether an address is taken', () => {
  const api = new ApiClient();

  beforeAll(async () => {
    // One address that definitely has an account, to compare against one that
    // definitely does not.
    await ensureTestUser(REGISTERED, PASSWORD);
  });

  it('is running invite-only, or the rest of this file proves nothing', async () => {
    // A box configured with SIGNUP_MODE=open would pass every assertion below
    // vacuously, because register would then answer 201/409 instead of 403.
    const response = await api.get<{ signupMode: string }>('/auth/providers');

    expect(response.status).toBe(200);
    expect(response.body.signupMode).toBe('invite_only');
  });

  it.each([
    ['with no invite token', undefined],
    ['with an invite token nobody issued', 'not-a-real-invite-token'],
    ['with an empty-looking token', '~~~~~~~~'],
  ])('answers identically %s', async (_case, inviteToken) => {
    const [taken, free] = await Promise.all(
      [REGISTERED, UNREGISTERED].map((email) =>
        api.post('/auth/register', {
          email,
          password: 'a-password-of-some-length',
          name: 'Somebody',
          ...(inviteToken === undefined ? {} : { inviteToken }),
        }),
      ),
    );

    expect(answerOf(taken)).toEqual(answerOf(free));
    expect(taken.status).toBe(403);
    // Not the generic `forbidden`: the shell needs to tell "you need an invite"
    // from "you are not allowed", and the code is what it branches on.
    expect(taken.body).toMatchObject({ code: 'invite_invalid' });
  });

  it('leaves no trace of the attempt, so a retry answers the same way', async () => {
    // The refusal happens before the transaction, so nothing was written — and
    // an attacker cannot learn anything by asking twice either.
    const first = await api.post('/auth/register', {
      email: REGISTERED,
      password: 'a-password-of-some-length',
      name: 'Somebody',
    });
    const second = await api.post('/auth/register', {
      email: REGISTERED,
      password: 'a-password-of-some-length',
      name: 'Somebody',
    });

    expect(answerOf(first)).toEqual(answerOf(second));
  });

  it('still tells a caller their request was malformed', async () => {
    // The point is not to make register uninformative. A bad body is the
    // caller's own business, and saying so reveals nothing about anyone else.
    const response = await api.post('/auth/register', { email: 'not-an-email', password: 'short' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'validation_failed' });
  });
});
