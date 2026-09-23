import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  type ActivityDay,
  buildCalendar,
  computeStreaks,
  isValidTimeZone,
  type Streak,
  todayIn,
} from './activity.calendar.js';

export interface Activity {
  /** The learner's timezone, which decides where one day ends and the next begins. */
  timezone: string;
  /** Today, there. The last entry in `days`. */
  today: string;
  streak: Streak;
  /** One entry per day, oldest first, quiet days included and zeroed. */
  days: ActivityDay[];
  totals: {
    /** Within the returned window. */
    activeDays: number;
    events: number;
    sessionsCompleted: number;
  };
}

/**
 * Events that mean the learner *studied*, as opposed to merely showed up.
 *
 * Signing in is not activity: a streak that a login keeps alive measures
 * loyalty to the tab, not learning. Opening a session is the smallest honest
 * unit of work (Overall Plan §5.4).
 */
const STUDY_EVENTS = [
  'session.opened',
  'session.completed',
  'course.completed',
  'deliverable.submitted',
];

/** Beyond this, history stops earning its keep in a heatmap. */
const HISTORY_YEARS = 2;

/**
 * Streaks and the activity heatmap, from the append-only progress_events log
 * (Tech-Information.md §5 — the table exists for exactly this).
 *
 * One grouped query per call, and none of it per course: on free hosting every
 * query wakes a database that is asleep most of the day, so the dashboard must
 * not pay per enrolment.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  /** `weeks` of heatmap, and streaks measured over the whole history. */
  async forUser(userId: string, weeks = 12, now = new Date()): Promise<Activity> {
    const timezone = await this.timezoneOf(userId);
    const today = todayIn(timezone, now);
    const active = await this.activeDays(userId, timezone);

    const days = buildCalendar(active, today, weeks * 7);

    return {
      timezone,
      today,
      // Over everything, not just the window: a 40-day streak should not read
      // as 12 weeks' worth because that is all the heatmap shows.
      streak: computeStreaks(
        active.map((day) => day.date),
        today,
      ),
      days,
      totals: {
        activeDays: days.filter((day) => day.events > 0).length,
        events: days.reduce((sum, day) => sum + day.events, 0),
        sessionsCompleted: days.reduce((sum, day) => sum + day.sessionsCompleted, 0),
      },
    };
  }

  /** Just the streak, for the dashboard, which does not draw a heatmap. */
  async streakFor(userId: string, now = new Date()): Promise<Streak> {
    const timezone = await this.timezoneOf(userId);
    const active = await this.activeDays(userId, timezone);

    return computeStreaks(
      active.map((day) => day.date),
      todayIn(timezone, now),
    );
  }

  /**
   * A stored timezone the runtime does not recognise would fail the query at
   * the database instead of here, so an unknown one falls back to UTC.
   */
  private async timezoneOf(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });

    const timezone = user?.timezone ?? 'UTC';
    return isValidTimeZone(timezone) ? timezone : 'UTC';
  }

  /**
   * Active days, grouped in the learner's timezone by the database, which is
   * the only place that knows how to do it for a whole history at once.
   */
  private async activeDays(userId: string, timezone: string): Promise<ActivityDay[]> {
    const rows = await this.prisma.$queryRaw<
      { date: string; events: number; sessions_completed: number }[]
    >(Prisma.sql`
      SELECT to_char((at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS date,
             count(*)::int AS events,
             count(*) FILTER (WHERE type = 'session.completed')::int AS sessions_completed
        FROM progress_events
       WHERE user_id = ${userId}::uuid
         AND type IN (${Prisma.join(STUDY_EVENTS)})
         AND at >= now() - ${`${HISTORY_YEARS} years`}::interval
    GROUP BY 1
    ORDER BY 1
    `);

    return rows.map((row) => ({
      date: row.date,
      events: row.events,
      sessionsCompleted: row.sessions_completed,
    }));
  }
}
