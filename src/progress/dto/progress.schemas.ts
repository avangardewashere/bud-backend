import { z } from 'zod';

/** Response shapes for the player and the dashboard. */

export const stateValueSchema = z.object({
  /** Null when the key was never written. Opaque to the platform. */
  value: z.string().nullable(),
});

export const sessionProgressSchema = z.object({
  sessionKey: z.string(),
  status: z.enum(['not_started', 'in_progress', 'complete']),
  /** 0–1, optional fine-grained progress. Null unless the course reports it. */
  fraction: z.number().min(0).max(1).nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});

export const sessionProgressListSchema = z.array(sessionProgressSchema);

export const continueCardSchema = z.object({
  slug: z.string(),
  title: z.string(),
  accentColor: z.string().nullable(),
  sessionKey: z.string(),
  sessionTitle: z.string(),
  sessionOrder: z.int(),
  weight: z.string().nullable(),
  percent: z.int().min(0).max(100),
  /** False when this is a fresh start rather than a resume. */
  resuming: z.boolean(),
});

export const estimatedHoursSchema = z.object({
  /** What the course author estimated, or null when they gave no figure. */
  total: z.number().nullable(),
  /** The share of it behind the learner, split by session weight, to a tenth. */
  completed: z.number().nullable(),
});

export const dashboardCourseSchema = z.object({
  slug: z.string(),
  title: z.string(),
  accentColor: z.string().nullable(),
  coverUrl: z.string().nullable(),
  completedSessions: z.int().nonnegative(),
  totalSessions: z.int().nonnegative(),
  percent: z.int().min(0).max(100),
  lastOpenedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  estimatedHours: estimatedHoursSchema,
});

export const recentNoteSchema = z.object({
  slug: z.string(),
  courseTitle: z.string(),
  sessionKey: z.string(),
  sessionTitle: z.string().nullable(),
  /** A few lines, for a card — not the whole note. */
  excerpt: z.string(),
  updatedAt: z.iso.datetime(),
});

export const upcomingDeliverableSchema = z.object({
  slug: z.string(),
  courseTitle: z.string(),
  sessionKey: z.string(),
  sessionTitle: z.string(),
  /** What the manifest asks for. */
  asked: z.string(),
  /** True when the session is finished and only the handing in is left. */
  sessionComplete: z.boolean(),
});

export const streakSchema = z.object({
  /** Days in a row up to today. Yesterday still counts: today is not over. */
  current: z.int().nonnegative(),
  longest: z.int().nonnegative(),
  /** `YYYY-MM-DD` in the learner's timezone, or null when nothing has happened. */
  lastActiveDate: z.string().nullable(),
});

export const activityDaySchema = z.object({
  date: z.string(),
  /** Sessions opened or completed, courses finished, deliverables handed in. */
  events: z.int().nonnegative(),
  sessionsCompleted: z.int().nonnegative(),
});

export const activitySchema = z.object({
  /** The zone the days are cut in — the learner's, not the server's. */
  timezone: z.string(),
  today: z.string(),
  streak: streakSchema,
  /** Oldest first, one entry per day including the quiet ones. */
  days: z.array(activityDaySchema),
  /** Over the returned window, not all time. */
  totals: z.object({
    activeDays: z.int().nonnegative(),
    events: z.int().nonnegative(),
    sessionsCompleted: z.int().nonnegative(),
  }),
});

export const activityQuerySchema = z.object({
  /** Weeks of heatmap. Twelve is a quarter, which is what the dashboard draws. */
  weeks: z.coerce.number().int().min(1).max(53).default(12),
});

export const dashboardSchema = z.object({
  /** Null on a first visit — the empty state, not an error. */
  continueCard: continueCardSchema.nullable(),
  courses: z.array(dashboardCourseSchema),
  /** Most recently edited first, at most five. */
  recentNotes: z.array(recentNoteSchema),
  /** Finished sessions first: those need only handing in. At most ten. */
  upcomingDeliverables: z.array(upcomingDeliverableSchema),
  /** Days in a row, for the Bud's mood and the header (Overall Plan §5.5). */
  streak: streakSchema,
  totals: z.object({
    enrolledCourses: z.int().nonnegative(),
    completedCourses: z.int().nonnegative(),
    completedSessions: z.int().nonnegative(),
    totalSessions: z.int().nonnegative(),
    /** Across every enrolled course; courses without an estimate contribute 0. */
    estimatedHours: z.object({
      total: z.number().nonnegative(),
      completed: z.number().nonnegative(),
    }),
  }),
});
