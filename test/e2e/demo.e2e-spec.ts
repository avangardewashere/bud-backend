import { beforeAll, describe, expect, it } from 'vitest';

import { ApiClient, apiIsUp } from './client.js';

/**
 * The public demo account.
 *
 * What matters here is what a portfolio visitor sees in the first few seconds:
 * a dashboard with a course underway, a streak, notes and something handed in.
 * An empty account would show none of the product.
 *
 * Skips unless the API under test has DEMO_MODE on; CI sets it.
 */

interface Dashboard {
  continueCard: { slug: string; sessionKey: string } | null;
  courses: {
    slug: string;
    completedSessions: number;
    totalSessions: number;
    estimatedHours: { total: number | null; completed: number | null };
  }[];
  recentNotes: { sessionKey: string; excerpt: string }[];
  upcomingDeliverables: unknown[];
  streak: { current: number; longest: number; lastActiveDate: string | null };
  totals: { enrolledCourses: number; completedSessions: number };
}

const up = await apiIsUp();
const demoEnabled = up && (await new ApiClient().post('/auth/demo')).status === 200;

describe.skipIf(!demoEnabled)('the public demo', () => {
  const api = new ApiClient();
  let dashboard: Dashboard;

  beforeAll(async () => {
    const response = await api.post<{ user: { email: string; role: string } }>('/auth/demo');
    expect(response.status).toBe(200);
    dashboard = (await api.get<Dashboard>('/me/dashboard')).body;
  });

  it('tells the sign-in screen that the demo exists', async () => {
    // Otherwise the shell has to guess, and a button that 404s is worse than
    // no button.
    const providers = await new ApiClient().get<{ demo: boolean }>('/auth/providers');

    expect(providers.body.demo).toBe(true);
  });

  it('signs a visitor in with no credentials at all', async () => {
    const me = await api.get<{ user: { email: string; role: string } }>('/me');

    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('learner');
  });

  it('lands on a dashboard that looks lived in', () => {
    expect(dashboard.totals.enrolledCourses).toBeGreaterThan(0);
    expect(dashboard.totals.completedSessions).toBeGreaterThan(0);
    // Part-way through: something done, something left.
    const course = dashboard.courses[0];
    expect(course.completedSessions).toBeGreaterThan(0);
    expect(course.completedSessions).toBeLessThan(course.totalSessions);
    expect(course.estimatedHours.completed).toBeGreaterThan(0);
    // And somewhere to carry on from.
    expect(dashboard.continueCard).not.toBeNull();
  });

  it('has a streak running, and notes and a deliverable behind it', () => {
    expect(dashboard.streak.current).toBeGreaterThanOrEqual(1);
    expect(dashboard.streak.longest).toBeGreaterThanOrEqual(dashboard.streak.current);
    expect(dashboard.recentNotes.length).toBeGreaterThan(0);
    expect(dashboard.recentNotes[0].excerpt.length).toBeGreaterThan(20);
  });

  it('fills the heatmap with a history, not one busy day', async () => {
    const activity = await api.get<{
      days: { date: string; events: number }[];
      totals: { activeDays: number };
      today: string;
    }>('/me/activity');

    expect(activity.body.totals.activeDays).toBeGreaterThan(4);
    expect(activity.body.days.at(-1)?.events).toBeGreaterThan(0);
    // Quiet days too, or it reads as a solid block.
    expect(activity.body.days.some((day) => day.events === 0)).toBe(true);
  });

  it('cannot change its own password, so no visitor can lock out the next', async () => {
    const response = await api.post('/auth/change-password', {
      currentPassword: 'whatever-it-might-be',
      newPassword: 'a-new-password-1234',
    });

    expect(response.status).toBe(400);
  });

  it('keeps what a visitor does while they are still using it', async () => {
    // Resetting under someone mid-tour would look like a bug, so it only
    // happens once the demo has been idle. This suite shares one account that
    // outlives a run, so it makes its own starting point rather than assuming
    // one: reopen a session, then finish it again.
    const slug = dashboard.courses[0].slug;
    const detail = await api.get<{ sessions: { key: string }[] }>(`/courses/${slug}`);
    const key = detail.body.sessions.at(-1)!.key;

    await api.delete(`/me/courses/${slug}/sessions/${key}/complete`);
    const before = (await api.get<Dashboard>('/me/dashboard')).body.courses[0].completedSessions;

    await api.post(`/me/courses/${slug}/sessions/${key}/complete`);
    await api.post('/auth/demo');

    const after = await api.get<Dashboard>('/me/dashboard');

    expect(after.body.courses[0].completedSessions).toBe(before + 1);
  });
});
