import { beforeAll, describe, expect, it } from 'vitest';

import { ApiClient, apiIsUp, ensureTestUser } from './client.js';

/**
 * Streaks and the heatmap, against a real database.
 *
 * The grouping that decides which day an event belongs to happens in Postgres,
 * in the learner's timezone — so it has to be exercised there rather than only
 * in the calendar's unit tests.
 */

const EMAIL = 'e2e-activity@bud.local';
const PASSWORD = 'e2e-activity-password-123';
const SLUG = 'docker-fundamentals';

interface Activity {
  timezone: string;
  today: string;
  streak: { current: number; longest: number; lastActiveDate: string | null };
  days: { date: string; events: number; sessionsCompleted: number }[];
  totals: { activeDays: number; events: number; sessionsCompleted: number };
}

const up = await apiIsUp();

describe.skipIf(!up)('activity', () => {
  const api = new ApiClient();
  let sessionKey: string;

  beforeAll(async () => {
    await ensureTestUser(EMAIL, PASSWORD);
    await api.login(EMAIL, PASSWORD);
    await api.post(`/courses/${SLUG}/enroll`);

    const detail = await api.get<{ sessions: { key: string }[] }>(`/courses/${SLUG}`);
    sessionKey = detail.body.sessions[0].key;
  });

  it('counts studying, and dates it in the learner’s timezone', async () => {
    const before = await api.get<Activity>('/me/activity');
    const openedBefore = before.body.days.at(-1)?.events ?? 0;

    await api.post(`/me/courses/${SLUG}/sessions/${sessionKey}/open`);

    const after = await api.get<Activity>('/me/activity');
    const today = after.body.days.at(-1);

    expect(after.status).toBe(200);
    // The window ends today, and today is where the new event landed.
    expect(today?.date).toBe(after.body.today);
    expect(today?.events).toBe(openedBefore + 1);
    expect(after.body.streak.current).toBeGreaterThanOrEqual(1);
    expect(after.body.streak.lastActiveDate).toBe(after.body.today);
    expect(after.body.timezone).toBe('UTC');
  });

  it('counts a completion as a completion, not just an event', async () => {
    const before = await api.get<Activity>('/me/activity');
    const completedBefore = before.body.days.at(-1)?.sessionsCompleted ?? 0;

    await api.post(`/me/courses/${SLUG}/sessions/${sessionKey}/complete`);

    const after = await api.get<Activity>('/me/activity');

    expect(after.body.days.at(-1)?.sessionsCompleted).toBe(completedBefore + 1);
  });

  it('does not count signing in', async () => {
    // A streak kept alive by opening the tab measures loyalty, not learning.
    const before = await api.get<Activity>('/me/activity');

    const other = new ApiClient();
    await other.login(EMAIL, PASSWORD);

    const after = await api.get<Activity>('/me/activity');

    expect(after.body.totals.events).toBe(before.body.totals.events);
  });

  it('returns the whole window, quiet days included, oldest first', async () => {
    const response = await api.get<Activity>('/me/activity?weeks=2');
    const { days, today } = response.body;

    expect(days).toHaveLength(14);
    expect(days.at(-1)?.date).toBe(today);
    expect([...days].sort((a, b) => a.date.localeCompare(b.date))).toEqual(days);
    // Yesterday and earlier are present, whether or not anything happened.
    expect(days.filter((d) => d.events === 0).length).toBeGreaterThan(0);
  });

  it('defaults to a quarter and refuses a window it will not serve', async () => {
    expect((await api.get<Activity>('/me/activity')).body.days).toHaveLength(84);
    expect((await api.get('/me/activity?weeks=0')).status).toBe(400);
    expect((await api.get('/me/activity?weeks=99')).status).toBe(400);
    expect((await api.get('/me/activity?weeks=not-a-number')).status).toBe(400);
  });

  it('refuses to report on anyone without a session', async () => {
    expect((await new ApiClient().get('/me/activity')).status).toBe(401);
  });

  it('estimates hours from the course manifest, split by session weight', async () => {
    // The Docker course says 30 hours across ten sessions of mixed weight, and
    // this learner completed one of them above.
    const dashboard = await api.get<{
      courses: {
        slug: string;
        estimatedHours: { total: number | null; completed: number | null };
      }[];
      totals: { estimatedHours: { total: number; completed: number } };
    }>('/me/dashboard');

    const course = dashboard.body.courses.find((c) => c.slug === SLUG);

    expect(course?.estimatedHours.total).toBe(30);
    expect(course?.estimatedHours.completed).toBeGreaterThan(0);
    expect(course?.estimatedHours.completed).toBeLessThan(30);
    expect(dashboard.body.totals.estimatedHours.total).toBeGreaterThanOrEqual(30);
  });

  it('gives the dashboard the same streak', async () => {
    const [dashboard, activity] = await Promise.all([
      api.get<{ streak: Activity['streak'] }>('/me/dashboard'),
      api.get<Activity>('/me/activity'),
    ]);

    expect(dashboard.body.streak).toEqual(activity.body.streak);
  });
});
