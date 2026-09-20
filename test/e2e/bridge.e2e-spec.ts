import { beforeAll, describe, expect, it } from 'vitest';

import { ApiClient, apiIsUp, ensureTestUser } from './client.js';

/**
 * The storage bridge and the progress endpoints, over real HTTP against a real
 * Postgres.
 *
 * These are the endpoints the course player hammers, and the ones whose
 * failure modes cost a learner their work rather than showing an error page, so
 * they are worth exercising end to end rather than only in unit tests.
 *
 * Skips rather than fails when the API is not running, so `npm test` stays
 * useful on a laptop with nothing booted.
 */

const EMAIL = 'e2e-player@bud.local';
const PASSWORD = 'e2e-player-password-123';
const SLUG = 'docker-fundamentals';
const state = (key: string) => `/me/courses/${SLUG}/state/${encodeURIComponent(key)}`;
const session = (key: string) => `/me/courses/${SLUG}/sessions/${key}`;

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  detail?: string;
}

const up = await apiIsUp();

describe.skipIf(!up)('the storage bridge', () => {
  const api = new ApiClient();
  let enrolled = false;

  beforeAll(async () => {
    await ensureTestUser(EMAIL, PASSWORD);
    await api.login(EMAIL, PASSWORD);

    const response = await api.post(`/courses/${SLUG}/enroll`);
    enrolled = response.status === 200;
  });

  it('is reachable only by someone enrolled', async () => {
    const stranger = new ApiClient();
    await ensureTestUser('e2e-stranger@bud.local', PASSWORD);
    await stranger.login('e2e-stranger@bud.local', PASSWORD);

    const response = await stranger.get<ErrorBody>(state('anything'));

    // Distinct from not_found on purpose: the player can act on this by enrolling.
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('not_enrolled');
  });

  describe('round trip', () => {
    it('returns null for a key that was never written', async () => {
      expect(enrolled).toBe(true);

      const response = await api.get<{ value: string | null }>(state('e2e:never-written'));

      // Null rather than 404: that is the shape the existing worksheets handle.
      expect(response.status).toBe(200);
      expect(response.body.value).toBeNull();
    });

    it('stores a value and reads back exactly what went in', async () => {
      // A realistic worksheet blob: JSON, with the quoting that trips naive
      // string handling.
      const value = JSON.stringify({
        t1: true,
        note: 'Worked on my machine — "quoted", \\escaped\\, and multi\nline.',
      });

      const write = await api.put(state('docker-course:state'), { value });
      expect(write.status).toBe(204);

      const read = await api.get<{ value: string | null }>(state('docker-course:state'));
      expect(read.body.value).toBe(value);
    });

    it('overwrites rather than merging, because writes are whole-value', async () => {
      await api.put(state('e2e:whole'), { value: '{"a":1,"b":2}' });
      await api.put(state('e2e:whole'), { value: '{"a":9}' });

      const read = await api.get<{ value: string | null }>(state('e2e:whole'));

      // Last write wins, with nothing merged in from the first.
      expect(read.body.value).toBe('{"a":9}');
    });

    it('round-trips multi-byte content without mangling it', async () => {
      const value = '日本語 · emoji 😀 · accents éàü';

      await api.put(state('e2e:unicode'), { value });
      const read = await api.get<{ value: string | null }>(state('e2e:unicode'));

      expect(read.body.value).toBe(value);
    });

    it('deletes, which is what every worksheet’s "Clear saved work" calls', async () => {
      await api.put(state('e2e:doomed'), { value: 'x' });

      const removed = await api.delete(state('e2e:doomed'));
      expect(removed.status).toBe(204);

      const read = await api.get<{ value: string | null }>(state('e2e:doomed'));
      expect(read.body.value).toBeNull();
    });

    it('treats deleting a key that never existed as success', async () => {
      const response = await api.delete(state('e2e:was-never-here'));

      // The caller wanted it gone. It is gone.
      expect(response.status).toBe(204);
    });

    it('accepts a key the manifest never declared', async () => {
      // The decisive case. Rejecting would punish the learner for the author's
      // typo: the worksheet catches it and shows a small "not saved" flash.
      const response = await api.put(state('docker-course:sesion-3'), { value: 'typo key' });

      expect(response.status).toBe(204);
      const read = await api.get<{ value: string | null }>(state('docker-course:sesion-3'));
      expect(read.body.value).toBe('typo key');
    });
  });

  describe('limits', () => {
    it('refuses a value over the per-value cap, in bytes', async () => {
      const response = await api.put<ErrorBody>(state('e2e:too-big'), {
        value: 'x'.repeat(1024 * 1024 + 1),
      });

      expect(response.status).toBe(413);
      expect(response.body.code).toBe('storage_value_too_large');
    });

    it('measures the cap in bytes rather than characters', async () => {
      // 300k emoji is 600k UTF-16 characters but ~1.2 MB — comfortably under a
      // character-based cap and comfortably over a byte-based one. A character
      // check here would accept it and disagree with the service.
      const response = await api.put<ErrorBody>(state('e2e:emoji-bomb'), {
        value: '😀'.repeat(300_000),
      });

      expect(response.status).toBe(413);
      expect(response.body.code).toBe('storage_value_too_large');
    });

    it('accepts a value just under the cap', async () => {
      // The limit must be reachable: a cap the framework intercepts first would
      // make the app-level error unreachable and its code unreadable.
      const response = await api.put(state('e2e:just-under'), {
        value: 'x'.repeat(1024 * 1024 - 1024),
      });

      expect(response.status).toBe(204);
      await api.delete(state('e2e:just-under'));
    });

    it('explains the limit rather than only refusing', async () => {
      const response = await api.put<ErrorBody>(state('e2e:explain'), {
        value: 'x'.repeat(1024 * 1024 + 1),
      });

      expect(response.body.detail).toMatch(/exceeds/i);
      expect(response.body.message).toBeTruthy();
    });
  });

  describe('the error envelope', () => {
    it('carries a stable code on every error, not just storage ones', async () => {
      const unknownCourse = await api.get<ErrorBody>('/me/courses/no-such-course/state/k');
      expect(unknownCourse.body.code).toBe('not_found');

      const unauthenticated = await new ApiClient().get<ErrorBody>('/me/dashboard');
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.body.code).toBe('unauthorized');
    });
  });
});

describe.skipIf(!up)('progress', () => {
  const api = new ApiClient();

  beforeAll(async () => {
    await ensureTestUser(EMAIL, PASSWORD);
    await api.login(EMAIL, PASSWORD);
    await api.post(`/courses/${SLUG}/enroll`);
  });

  interface Progress {
    sessionKey: string;
    status: string;
    fraction: number | null;
    completedAt: string | null;
  }

  it('refuses a session key the course does not have', async () => {
    const response = await api.post<ErrorBody>(session('s99') + '/complete');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('unknown_session');
  });

  it('marks a session in progress when opened', async () => {
    const response = await api.post<Progress>(session('s1') + '/open');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('in_progress');
  });

  it('never moves a reported fraction backwards', async () => {
    await api.post(session('s2') + '/open');
    await api.post(session('s2') + '/progress', { fraction: 0.6 });

    const response = await api.post<Progress>(session('s2') + '/progress', { fraction: 0.1 });

    // A progress bar that goes down reads as data loss.
    expect(response.body.fraction).toBe(0.6);
  });

  it('completes a session', async () => {
    const response = await api.post<Progress>(session('s1') + '/complete');

    expect(response.body.status).toBe('complete');
    expect(response.body.completedAt).not.toBeNull();
  });

  it('does not un-complete a session when it is reopened', async () => {
    const response = await api.post<Progress>(session('s1') + '/open');

    // Revisiting something you finished must not undo finishing it.
    expect(response.body.status).toBe('complete');
  });

  it('reopens a session that was completed by mistake', async () => {
    await api.post(session('s3') + '/complete');
    const response = await api.delete<Progress>(session('s3') + '/complete');

    expect(response.body.status).toBe('in_progress');
    expect(response.body.completedAt).toBeNull();
  });

  it('reflects completion in the dashboard', async () => {
    const response = await api.get<{
      continueCard: { slug: string; resuming: boolean } | null;
      totals: { completedSessions: number; totalSessions: number };
    }>('/me/dashboard');

    expect(response.status).toBe(200);
    expect(response.body.totals.totalSessions).toBe(10);
    expect(response.body.totals.completedSessions).toBeGreaterThanOrEqual(1);
    expect(response.body.continueCard?.slug).toBe(SLUG);
    // They have opened something, so the card is a resume rather than a start.
    expect(response.body.continueCard?.resuming).toBe(true);
  });

  it('reports per-session progress for the rail', async () => {
    const response = await api.get<{ sessionKey: string; status: string }[]>(
      `/me/courses/${SLUG}/progress`,
    );

    expect(response.status).toBe(200);
    expect(response.body.find((s) => s.sessionKey === 's1')?.status).toBe('complete');
  });
});
