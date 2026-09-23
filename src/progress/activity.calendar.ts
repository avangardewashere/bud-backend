/**
 * Turning a list of activity events into days, streaks and a heatmap.
 *
 * Kept free of Prisma and of the clock so every rule here is testable: which
 * day an event belongs to, when a streak survives, and what an empty history
 * looks like.
 *
 * Days are plain `YYYY-MM-DD` strings in the *learner's* timezone. That is the
 * whole point of the timezone column: a session finished at 11pm in Manila is
 * Tuesday's work, and a streak that breaks at midnight UTC would break in the
 * middle of their evening (Overall Plan §5.4, §10).
 */

/** One day's activity. `date` is `YYYY-MM-DD` in the learner's timezone. */
export interface ActivityDay {
  date: string;
  /** Study events that day: sessions opened or completed, courses finished, deliverables handed in. */
  events: number;
  sessionsCompleted: number;
}

export interface Streak {
  /** Days in a row up to today, or 0. Yesterday still counts — today is not over. */
  current: number;
  /** The longest run ever, including the current one. */
  longest: number;
  /** The most recent day with any activity, or null. */
  lastActiveDate: string | null;
}

/** Whether the runtime knows this IANA zone, so a bad value cannot reach SQL. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The date it is *there*, right now — `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now: Date): string {
  // en-CA formats as YYYY-MM-DD, which is what the rest of this file speaks.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * `date` shifted by whole days. Anchored at noon UTC so a daylight-saving
 * shift of an hour either way cannot land on the previous or next date.
 */
export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
function daysBetween(from: string, to: string): number {
  const ms = new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * The window the heatmap draws: exactly `days` entries ending on `endDate`,
 * with the quiet days present and zeroed. The UI should not have to guess
 * which dates are missing, and a gap is as meaningful as a streak.
 */
export function buildCalendar(
  active: readonly ActivityDay[],
  endDate: string,
  days: number,
): ActivityDay[] {
  const byDate = new Map(active.map((day) => [day.date, day]));
  const calendar: ActivityDay[] = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDays(endDate, -offset);
    calendar.push(byDate.get(date) ?? { date, events: 0, sessionsCompleted: 0 });
  }

  return calendar;
}

/**
 * Current and longest run of consecutive active days.
 *
 * The current streak counts back from today, or from yesterday when nothing
 * has happened yet today: a streak should not appear broken all morning just
 * because the learner has not sat down yet. Two days of silence ends it.
 */
export function computeStreaks(activeDates: readonly string[], today: string): Streak {
  const dates = [...new Set(activeDates)].sort();
  if (dates.length === 0) {
    return { current: 0, longest: 0, lastActiveDate: null };
  }

  let longest = 1;
  let run = 1;
  for (let i = 1; i < dates.length; i += 1) {
    run = daysBetween(dates[i - 1], dates[i]) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  const lastActiveDate = dates[dates.length - 1];
  const sinceLast = daysBetween(lastActiveDate, today);
  // A future date (the clock moved, or a timezone change) is not a live streak.
  const current = sinceLast === 0 || sinceLast === 1 ? trailingRun(dates) : 0;

  return { current, longest, lastActiveDate };
}

/** Length of the consecutive run ending at the last date. */
function trailingRun(sortedDates: readonly string[]): number {
  let run = 1;
  for (let i = sortedDates.length - 1; i > 0; i -= 1) {
    if (daysBetween(sortedDates[i - 1], sortedDates[i]) !== 1) {
      break;
    }
    run += 1;
  }
  return run;
}
