import { z } from 'zod';

/**
 * `bud.manifest.json`, spec `bud-course/1`.
 *
 * Modelled on the real hand-written manifest the shell already ships
 * (`Bud - frontend/courses/docker-fundamentals/1.0.0/bud.manifest.json`) rather
 * than on the illustrative snippet in the planning docs — the real one is the
 * thing that has to validate.
 *
 * This schema is published at `GET /course-spec/schema` as JSON Schema so the
 * admin panel can show which fields are required without re-implementing any
 * checking.
 */

/** No leading slash, no `..`, no backslashes, no drive letters. */
const relativePath = z
  .string()
  .min(1)
  .max(255)
  .refine((p) => !p.startsWith('/') && !p.startsWith('\\'), {
    message: 'Must be a relative path',
  })
  .refine((p) => !/^[a-zA-Z]:/.test(p), { message: 'Must not be an absolute Windows path' })
  .refine((p) => !p.split(/[/\\]/).includes('..'), {
    message: 'Must not contain ".." path segments',
  });

/**
 * The manifest `id` doubles as the catalog URL slug, so it is restricted to
 * what is safe in a path segment.
 */
export const courseIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Must be lowercase letters, digits and single hyphens (e.g. docker-fundamentals)',
  );

/** Semver-ish. Re-uploading the same id with a higher version creates a new version. */
export const courseVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Must be a semantic version, e.g. 1.0.0');

/**
 * Session weights are load-bearing for the UI, not decorative: the rail and the
 * session lists render them, so the vocabulary is closed.
 */
export const sessionWeightSchema = z.enum(['light', 'medium', 'heavy']);

export const manifestSessionSchema = z
  .object({
    /** Stable key that progress is recorded against. Must survive re-uploads. */
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, 'Must be letters, digits, hyphens or underscores'),
    order: z.int().positive().describe('Position in the course. Must be unique.'),
    title: z.string().min(1).max(200),
    /**
     * Path inside the zip to this session's HTML entry point.
     *
     * HTML specifically, and enforced: Bud serves a session as a document in a
     * sandboxed frame and never parses or restyles it. A `.md` entry used to
     * validate clean and then reach the learner as raw text — a course that is
     * broken for everyone, reported as publishable. The first thing a prose
     * author tries, too.
     */
    entry: relativePath.refine((p) => /\.html?$/i.test(p), {
      message:
        'Must be an .html file. Bud serves a session as a document and does not render ' +
        'Markdown or anything else — write the page, and put Markdown in the outline.',
    }),
    weight: sessionWeightSchema.optional(),
    deliverable: z
      .string()
      .max(500)
      .optional()
      .describe('Prompt for what the learner hands in at the end of this session.'),
  })
  .strict();

const manifestObject = z
  .object({
    spec: z.literal('bud-course/1'),
    id: courseIdSchema,
    title: z.string().min(1).max(200),
    version: courseVersionSchema,
    summary: z.string().min(1).max(1000),
    level: z
      .string()
      .max(60)
      .optional()
      .describe('Free text, shown as-is. Unlike a session weight, the vocabulary is open.'),
    estimatedHours: z
      .number()
      .positive()
      .max(1000)
      .optional()
      .describe('Hours for the whole course. The catalog shows it beside the title.'),
    tags: z.array(z.string().min(1).max(40)).max(20).default([]).describe('Free text, up to 20.'),
    /** Markdown outline rendered on the course detail page. */
    outline: relativePath
      .optional()
      .describe('Markdown file rendered on the course page. This is where Markdown belongs.'),
    /** Explicitly nullable: the real manifest sets it to null when there is none. */
    cover: relativePath
      .nullable()
      .optional()
      .describe('Image path relative to this manifest. Rendered at 16:9; 1200x675 suits it.'),
    theme: z
      .object({
        accent: z
          .string()
          .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a hex colour, e.g. #1E6FA8')
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * Every key the course will pass to `storage.get/set/delete`. Declared so
     * the platform can show and export a learner's data per course. The Docker
     * course uses ten, not one — anything assuming a single blob is wrong.
     *
     * **Declaring is not enforcement.** A `set` to an undeclared key succeeds
     * (see state.service.ts), so an omission does not lose a learner's work — it
     * loses the key from their export and from the admin view. The validator
     * cross-checks this list against the keys it can see in the session files
     * and warns in both directions, because the mismatch is invisible by eye
     * across four files and every author who has tried this got it wrong.
     */
    storageKeys: z
      .array(z.string().min(1).max(200))
      .max(100)
      .default([])
      .describe(
        'Every key the sessions pass to storage.get/set/delete. Keys are per course, not ' +
          'per session, so one session can read what another wrote. An undeclared key still ' +
          'saves, but is missing from the learner exports built from this list.',
      ),
    sessions: z.array(manifestSessionSchema).min(1).max(200),
  })
  .strict();

/**
 * The field names each level accepts, derived rather than restated so they cannot
 * drift. Used to suggest a correction when an author writes a neighbouring name
 * — `description` for `summary`, `file` for `entry` — which the validator used to
 * report as two unrelated problems: one unrecognised key and one missing field.
 */
export const MANIFEST_FIELDS = Object.keys(manifestObject.shape);
export const SESSION_FIELDS = Object.keys(manifestSessionSchema.shape);

export const manifestSchema = manifestObject.superRefine((manifest, ctx) => {
  const seenIds = new Set<string>();
  const seenOrders = new Set<number>();

  for (const [index, session] of manifest.sessions.entries()) {
    if (seenIds.has(session.id)) {
      // Progress is keyed by session id; duplicates would merge two sessions
      // into one row and silently corrupt it.
      ctx.addIssue({
        code: 'custom',
        path: ['sessions', index, 'id'],
        message: `Duplicate session id "${session.id}". Session ids must be unique.`,
      });
    }
    seenIds.add(session.id);

    if (seenOrders.has(session.order)) {
      ctx.addIssue({
        code: 'custom',
        path: ['sessions', index, 'order'],
        message: `Duplicate order ${session.order}. Session order must be unique.`,
      });
    }
    seenOrders.add(session.order);
  }
});

export type CourseManifest = z.infer<typeof manifestSchema>;
export type ManifestSession = z.infer<typeof manifestSessionSchema>;

/** The file a course package must contain at its root. */
export const MANIFEST_FILENAME = 'bud.manifest.json';
