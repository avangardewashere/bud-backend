import { describe, expect, it } from 'vitest';

import {
  addDays,
  buildCalendar,
  computeStreaks,
  isValidTimeZone,
  todayIn,
} from './activity.calendar.js';

describe('todayIn', () => {
  it('uses the learner’s day, not the server’s', () => {
    // 00:30 on the 23rd in Manila is still the 22nd in London. A streak that
    // broke at UTC midnight would break in the middle of a Manila evening.
    const at = new Date('2026-09-22T16:30:00Z');

    expect(todayIn('Asia/Manila', at)).toBe('2026-09-23');
    expect(todayIn('UTC', at)).toBe('2026-09-22');
    expect(todayIn('America/Los_Angeles', at)).toBe('2026-09-22');
  });

  it('knows which zones exist, so a bad one cannot reach the database', () => {
    expect(isValidTimeZone('Asia/Manila')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone("'; drop table progress_events; --")).toBe(false);
  });
});

describe('addDays', () => {
  it('steps whole days across a daylight-saving change', () => {
    // US clocks go forward on 8 March 2026; a midnight anchor could land back
    // on the 7th.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', -1)).toBe('2026-03-07');
    // And across a month, a year, and a leap day.
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('buildCalendar', () => {
  const day = (date: string, events = 1) => ({ date, events, sessionsCompleted: 0 });

  it('returns every day in the window, quiet ones included', () => {
    const calendar = buildCalendar([day('2026-09-21')], '2026-09-23', 4);

    expect(calendar.map((d) => d.date)).toEqual([
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
    ]);
    expect(calendar.map((d) => d.events)).toEqual([0, 1, 0, 0]);
  });

  it('drops activity from outside the window rather than bending it in', () => {
    const calendar = buildCalendar([day('2026-01-01', 9), day('2026-09-23')], '2026-09-23', 2);

    expect(calendar).toEqual([
      { date: '2026-09-22', events: 0, sessionsCompleted: 0 },
      { date: '2026-09-23', events: 1, sessionsCompleted: 0 },
    ]);
  });

  it('is empty-safe', () => {
    expect(buildCalendar([], '2026-09-23', 1)).toEqual([
      { date: '2026-09-23', events: 0, sessionsCompleted: 0 },
    ]);
  });
});

describe('computeStreaks', () => {
  const TODAY = '2026-09-23';

  it('reports nothing for a learner who has never studied', () => {
    expect(computeStreaks([], TODAY)).toEqual({ current: 0, longest: 0, lastActiveDate: null });
  });

  it('counts a run that reaches today', () => {
    const dates = ['2026-09-21', '2026-09-22', '2026-09-23'];

    expect(computeStreaks(dates, TODAY)).toEqual({
      current: 3,
      longest: 3,
      lastActiveDate: '2026-09-23',
    });
  });

  it('keeps a streak alive on the morning after', () => {
    // Nothing today yet. The day is not over, so the streak still stands.
    const dates = ['2026-09-21', '2026-09-22'];

    expect(computeStreaks(dates, TODAY)).toMatchObject({ current: 2, longest: 2 });
  });

  it('breaks it after a full day of silence', () => {
    const dates = ['2026-09-20', '2026-09-21'];

    expect(computeStreaks(dates, TODAY)).toMatchObject({
      current: 0,
      longest: 2,
      lastActiveDate: '2026-09-21',
    });
  });

  it('remembers the longest run even after it ends', () => {
    const dates = [
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04', // four in a row, long over
      '2026-09-23', // and back today
    ];

    expect(computeStreaks(dates, TODAY)).toEqual({
      current: 1,
      longest: 4,
      lastActiveDate: '2026-09-23',
    });
  });

  it('counts a day once, however busy it was', () => {
    const dates = ['2026-09-22', '2026-09-22', '2026-09-23', '2026-09-23'];

    expect(computeStreaks(dates, TODAY)).toMatchObject({ current: 2, longest: 2 });
  });

  it('does not mind unsorted input', () => {
    const dates = ['2026-09-23', '2026-09-21', '2026-09-22'];

    expect(computeStreaks(dates, TODAY)).toMatchObject({ current: 3 });
  });

  it('treats a date in the future as no live streak', () => {
    // A timezone change or a corrected clock can leave activity "ahead" of
    // today. Counting it would show a streak the learner has not earned.
    expect(computeStreaks(['2026-09-25'], TODAY)).toMatchObject({
      current: 0,
      lastActiveDate: '2026-09-25',
    });
  });

  it('counts a run that spans a month and a year boundary', () => {
    const dates = ['2025-12-30', '2025-12-31', '2026-01-01'];

    expect(computeStreaks(dates, '2026-01-01')).toMatchObject({ current: 3, longest: 3 });
  });
});
