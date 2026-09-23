import { describe, expect, it } from 'vitest';

import { estimatedHours, sumEstimatedHours, type WeightedSession } from './estimated-hours.js';

const sessions = (...weights: (string | null)[]): WeightedSession[] =>
  weights.map((weight, i) => ({ key: `s${i + 1}`, weight }));

describe('estimatedHours', () => {
  it('splits the course estimate by weight, not by session count', () => {
    // light + heavy = 1 + 3 units. Finishing the heavy one is three quarters
    // of the work, not half of it.
    const done = estimatedHours(sessions('light', 'heavy'), new Set(['s2']), 8);

    expect(done).toEqual({ total: 8, completed: 6 });
  });

  it('treats a session with no weight as medium', () => {
    const done = estimatedHours(sessions(null, 'medium'), new Set(['s1']), 10);

    expect(done).toEqual({ total: 10, completed: 5 });
  });

  it('is zero at the start and the full estimate at the end', () => {
    const all = sessions('light', 'medium', 'heavy');

    expect(estimatedHours(all, new Set(), 12).completed).toBe(0);
    expect(estimatedHours(all, new Set(['s1', 's2', 's3']), 12).completed).toBe(12);
  });

  it('says nothing when the author estimated nothing', () => {
    expect(estimatedHours(sessions('light'), new Set(['s1']), null)).toEqual({
      total: null,
      completed: null,
    });
  });

  it('survives a course with no sessions yet', () => {
    expect(estimatedHours([], new Set(), 5)).toEqual({ total: 5, completed: 0 });
  });

  it('ignores an unknown weight rather than dropping the session', () => {
    // A future vocabulary word must not make a session weigh nothing.
    const done = estimatedHours(sessions('colossal', 'medium'), new Set(['s1']), 4);

    expect(done.completed).toBe(2);
  });

  it('rounds to a tenth, because it is an estimate', () => {
    const done = estimatedHours(sessions('light', 'light', 'light'), new Set(['s1']), 10);

    expect(done.completed).toBe(3.3);
  });
});

describe('sumEstimatedHours', () => {
  it('adds courses up and skips the ones with no estimate', () => {
    expect(
      sumEstimatedHours([
        { total: 30, completed: 7.5 },
        { total: null, completed: null },
        { total: 4, completed: 4 },
      ]),
    ).toEqual({ total: 34, completed: 11.5 });
  });

  it('is zero for a learner with no courses', () => {
    expect(sumEstimatedHours([])).toEqual({ total: 0, completed: 0 });
  });
});
