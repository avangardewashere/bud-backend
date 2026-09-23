import type { ReferenceObject, SchemaObject } from '@nestjs/swagger';

import {
  authProvidersSchema,
  changePasswordResultSchema,
  errorSchema,
  publicUserSchema,
} from '../auth/dto/auth.schemas.js';
import { validationResultSchema } from '../course-spec/validation.types.js';
import {
  adminCourseListSchema,
  adminCourseSchema,
  courseDetailSchema,
  courseListSchema,
  courseSessionSchema,
  courseStorageKeysSchema,
  courseSummarySchema,
  ingestResultSchema,
  progressSummarySchema,
} from '../courses/dto/course.schemas.js';
import {
  deliverableListSchema,
  deliverableSchema,
  noteListSchema,
  noteSchema,
} from '../notes/dto/notes.schemas.js';
import {
  activitySchema,
  dashboardSchema,
  sessionProgressListSchema,
  sessionProgressSchema,
  stateValueSchema,
} from '../progress/dto/progress.schemas.js';
import { openApiSchema } from '../common/validation/zod.pipe.js';

/**
 * Named schema components for the published OpenAPI document.
 *
 * Without these every response inlines its shape, and a generated client ends
 * up with the same structural object emitted separately under `login`,
 * `register` and `/me` — three anonymous types for one concept. Registering
 * them here gives the shell a real `PublicUser` type to import.
 *
 * Add a schema here the moment it is used by more than one route.
 */

/** A `$ref` at a named component. */
export const ref = (name: keyof typeof componentSchemas): ReferenceObject => ({
  $ref: `#/components/schemas/${name}`,
});

export const componentSchemas = {
  PublicUser: openApiSchema(publicUserSchema, 'output'),

  /** Every endpoint that returns a user returns it wrapped, so name the wrapper too. */
  UserEnvelope: {
    type: 'object',
    required: ['user'],
    properties: { user: { $ref: '#/components/schemas/PublicUser' } },
  } satisfies SchemaObject,

  ChangePasswordResult: openApiSchema(changePasswordResultSchema, 'output'),
  AuthProviders: openApiSchema(authProvidersSchema, 'output'),

  /** The one error shape the whole API uses. */
  ErrorResponse: openApiSchema(errorSchema, 'output'),

  // ── catalog ───────────────────────────────────────────────────────────────
  ProgressSummary: openApiSchema(progressSummarySchema, 'output'),
  CourseSummary: openApiSchema(courseSummarySchema, 'output'),
  CourseSession: openApiSchema(courseSessionSchema, 'output'),
  CourseDetail: openApiSchema(courseDetailSchema, 'output'),
  CourseList: openApiSchema(courseListSchema, 'output'),

  // ── admin ─────────────────────────────────────────────────────────────────
  AdminCourse: openApiSchema(adminCourseSchema, 'output'),
  AdminCourseList: openApiSchema(adminCourseListSchema, 'output'),
  /** One line of the validation checklist the admin panel renders. */
  ValidationResult: openApiSchema(validationResultSchema, 'output'),
  IngestResult: openApiSchema(ingestResultSchema, 'output'),
  CourseStorageKeys: openApiSchema(courseStorageKeysSchema, 'output'),

  // ── the player ────────────────────────────────────────────────────────────
  /** What storage.get returns; `value` is opaque to the platform. */
  StateValue: openApiSchema(stateValueSchema, 'output'),
  SessionProgress: openApiSchema(sessionProgressSchema, 'output'),
  SessionProgressList: openApiSchema(sessionProgressListSchema, 'output'),
  Dashboard: openApiSchema(dashboardSchema, 'output'),
  Activity: openApiSchema(activitySchema, 'output'),

  // ── notes and deliverables ────────────────────────────────────────────────
  Note: openApiSchema(noteSchema, 'output'),
  NoteList: openApiSchema(noteListSchema, 'output'),
  Deliverable: openApiSchema(deliverableSchema, 'output'),
  DeliverableList: openApiSchema(deliverableListSchema, 'output'),
} satisfies Record<string, SchemaObject>;

export type ComponentName = keyof typeof componentSchemas;
