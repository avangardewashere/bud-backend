import { describe, expect, it } from 'vitest';

import { demoPlan } from './demo.sample.js';

describe('demoPlan', () => {
  it('lands a visitor part-way through a real course', () => {
    const plan = demoPlan(10);

    // Enough done to show progress, plenty left to click through.
    expect(plan.completed.length).toBeGreaterThan(0);
    expect(plan.completed.length).toBeLessThan(10);
    expect(plan.inProgress?.sessionIndex).toBe(plan.completed.length);
    expect(plan.notes.length).toBeGreaterThan(0);
    expect(plan.deliverable).not.toBeNull();
  });

  it('gives the heatmap a live streak and an older, longer one', () => {
    const days = [...new Set(demoPlan(10).events.map((e) => e.daysAgo))].sort((a, b) => a - b);

    // Today, yesterday and the day before: a streak the dashboard can show.
    expect(days.slice(0, 3)).toEqual([0, 1, 2]);
    // And gaps, so it does not look like a solid block of activity.
    expect(days.some((d, i) => i > 0 && d - days[i - 1] > 1)).toBe(true);
    expect(days.length).toBeGreaterThan(5);
  });

  it('never points at a session the course does not have', () => {
    for (const sessionCount of [1, 2, 3, 5, 10, 40]) {
      const plan = demoPlan(sessionCount);
      const indices = [
        ...plan.completed,
        ...(plan.inProgress ? [plan.inProgress.sessionIndex] : []),
        ...plan.notes.map((n) => n.sessionIndex),
        ...(plan.deliverable ? [plan.deliverable.sessionIndex] : []),
        ...plan.events.map((e) => e.sessionIndex),
      ];

      for (const index of indices) {
        expect(index, `course of ${sessionCount}`).toBeGreaterThanOrEqual(0);
        expect(index, `course of ${sessionCount}`).toBeLessThan(sessionCount);
      }
    }
  });

  it('does not claim a one-session course is finished and in progress at once', () => {
    const plan = demoPlan(1);

    expect(plan.completed).toEqual([0]);
    expect(plan.inProgress).toBeNull();
  });

  it('degrades to nothing for a course with no sessions', () => {
    expect(demoPlan(0)).toEqual({
      completed: [],
      inProgress: null,
      enrolledDaysAgo: 0,
      notes: [],
      deliverable: null,
      events: [],
    });
  });

  it('writes notes that read like a learner wrote them', () => {
    // They appear on the dashboard's recent notes, so they are part of the
    // demo's first impression rather than filler.
    for (const note of demoPlan(10).notes) {
      expect(note.bodyMd.length).toBeGreaterThan(40);
      expect(note.bodyMd).not.toMatch(/lorem|ipsum|TODO|placeholder/i);
    }
  });
});
