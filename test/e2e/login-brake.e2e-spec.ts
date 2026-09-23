import { beforeAll, describe, expect, it } from 'vitest';

import { ApiClient, apiIsUp, ensureTestUser } from './client.js';

/**
 * The brake on guessing passwords, and the thing it must never do.
 *
 * It counts failures per email *and* caller address. Behind the shell's /api
 * proxy every learner arrives as the proxy's own address, so that key is
 * effectively the email alone — and a brake keyed on an email is a way for a
 * stranger to lock its owner out of their own account, over and over, from
 * anywhere. So the password is checked first and the block applies only to an
 * attempt that also failed.
 *
 * Run against a live API; skips when there is none.
 */

const EMAIL = 'e2e-brake@bud.local';
const PASSWORD = 'e2e-brake-password-123';

const up = await apiIsUp();

describe.skipIf(!up)('the sign-in brake', () => {
  beforeAll(async () => {
    await ensureTestUser(EMAIL, PASSWORD);
  });

  it('starts refusing after enough wrong passwords', async () => {
    const api = new ApiClient();
    let lastStatus = 0;

    // Ten is the threshold; the eleventh is the first that cannot be a coincidence.
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await api.post('/auth/login', {
        email: EMAIL,
        password: `definitely-not-it-${attempt}`,
      });
      lastStatus = response.status;
    }

    expect(lastStatus).toBe(429);
  });

  it('still lets the owner in with the right password', async () => {
    // The whole point. The previous test left this email blocked.
    const api = new ApiClient();

    const response = await api.post<{ user: { email: string } }>('/auth/login', {
      email: EMAIL,
      password: PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe(EMAIL);
  });

  it('and a success clears the count behind it', async () => {
    const api = new ApiClient();

    const response = await api.post('/auth/login', {
      email: EMAIL,
      password: 'wrong-again',
    });

    // 401 rather than 429: the successful sign-in reset the brake.
    expect(response.status).toBe(401);
  });
});
