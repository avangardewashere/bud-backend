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

export const dashboardSchema = z.object({
  /** Null on a first visit — the empty state, not an error. */
  continueCard: continueCardSchema.nullable(),
  courses: z.array(dashboardCourseSchema),
  /** Most recently edited first, at most five. */
  recentNotes: z.array(recentNoteSchema),
  /** Finished sessions first: those need only handing in. At most ten. */
  upcomingDeliverables: z.array(upcomingDeliverableSchema),
  totals: z.object({
    enrolledCourses: z.int().nonnegative(),
    completedCourses: z.int().nonnegative(),
    completedSessions: z.int().nonnegative(),
    totalSessions: z.int().nonnegative(),
  }),
});
