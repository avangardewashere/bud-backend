import { z } from 'zod';

import { validationResultSchema } from '../../course-spec/validation.types.js';

/**
 * Response shapes for the catalog. Named components in the OpenAPI document,
 * so the shell's generated client gets `CourseSummary` and `CourseDetail`
 * rather than three anonymous copies.
 */

export const progressSummarySchema = z.object({
  /** Sessions marked complete, out of the version's total. */
  completedSessions: z.int().nonnegative(),
  totalSessions: z.int().nonnegative(),
  /** 0–100, rounded. What the growth meter fills to. */
  percent: z.int().min(0).max(100),
  /** Where "Continue" should take the learner. */
  lastSessionKey: z.string().nullable(),
  lastOpenedAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const courseSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  level: z.string().nullable(),
  estimatedHours: z.int().nullable(),
  tags: z.array(z.string()),
  accentColor: z.string().nullable(),
  coverUrl: z.string().nullable(),
  sessionCount: z.int().nonnegative(),
  /** The version a learner would get if they enrolled now. */
  version: z.string(),
  /** Null when the caller is not enrolled. */
  enrollment: progressSummarySchema.nullable(),
});

export const courseSessionSchema = z.object({
  /** The manifest session id. Progress is recorded against this. */
  key: z.string(),
  order: z.int(),
  title: z.string(),
  /** Load-bearing for the UI: the rail and session lists render it. */
  weight: z.enum(['light', 'medium', 'heavy']).nullable(),
  deliverable: z.string().nullable(),
  /** Path inside the course package; the player composes the URL. */
  entryPath: z.string(),
  status: z.enum(['not_started', 'in_progress', 'complete']),
});

export const courseDetailSchema = courseSummarySchema.extend({
  /** The course outline, rendered by the shell. Null when the package has none. */
  outlineMarkdown: z.string().nullable(),
  sessions: z.array(courseSessionSchema),
});

export const courseListSchema = z.object({
  courses: z.array(courseSummarySchema),
  /** Cursor-based even with three rows (Tech-Information §10, rule 5). */
  nextCursor: z.string().nullable(),
});

export const enrollmentResultSchema = z.object({
  slug: z.string(),
  enrolled: z.boolean(),
  progress: progressSummarySchema.nullable(),
});

/** What the admin list shows per course, including unpublished ones. */
export const adminCourseSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  status: z.enum(['draft', 'published', 'archived']),
  currentVersion: z.string().nullable(),
  versionCount: z.int().nonnegative(),
  enrollmentCount: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const adminCourseListSchema = z.object({
  courses: z.array(adminCourseSchema),
  nextCursor: z.string().nullable(),
});

/** Body for PATCH /admin/courses/:id. */
export const updateCourseSchema = z
  .object({
    status: z.enum(['draft', 'published', 'archived']).optional(),
    /** Point the course at one of its existing versions. */
    currentVersion: z.string().optional(),
  })
  .refine((body) => body.status !== undefined || body.currentVersion !== undefined, {
    message: 'Provide status, currentVersion, or both.',
  });

export const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** What POST /admin/courses returns: the checklist, plus the course when it passed. */
export const ingestResultSchema = z.object({
  ok: z.boolean(),
  results: z.array(validationResultSchema),
  course: z
    .object({
      id: z.uuid(),
      slug: z.string(),
      title: z.string(),
      status: z.enum(['draft', 'published', 'archived']),
      version: z.string().nullable(),
      filesStored: z.int().nonnegative(),
    })
    .nullable(),
});

export type ProgressSummary = z.infer<typeof progressSummarySchema>;
export type CourseSummary = z.infer<typeof courseSummarySchema>;
export type CourseDetail = z.infer<typeof courseDetailSchema>;
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;

/** Manifest-declared keys against the ones learners actually write. */
export const courseStorageKeysSchema = z.object({
  slug: z.string(),
  version: z.string().nullable(),
  declared: z.array(z.string()),
  /** Written by the course but not declared — usually a typo in the course. */
  undeclared: z.array(z.object({ key: z.string(), learners: z.int().nonnegative() })),
  /** Declared but never written. Harmless, often a leftover. */
  unused: z.array(z.string()),
});
