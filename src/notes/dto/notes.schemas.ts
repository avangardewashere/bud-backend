import { z } from 'zod';

/** Response shapes for notes and deliverables. */

export const noteSchema = z
  .object({
    sessionKey: z.string(),
    sessionTitle: z.string().nullable(),
    sessionOrder: z.int().nullable(),
    bodyMd: z.string(),
    updatedAt: z.iso.datetime(),
  })
  .nullable();

export const noteListSchema = z.array(
  z.object({
    sessionKey: z.string(),
    sessionTitle: z.string().nullable(),
    sessionOrder: z.int().nullable(),
    bodyMd: z.string(),
    updatedAt: z.iso.datetime(),
  }),
);

export const deliverableSchema = z.object({
  sessionKey: z.string(),
  sessionTitle: z.string().nullable(),
  /** What the manifest asked for, so the UI can show the ask beside the answer. */
  asked: z.string().nullable(),
  url: z.string(),
  comment: z.string().nullable(),
  /** Null when retracted. There is no grading; this is the learner's own claim. */
  submittedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export const deliverableListSchema = z.array(deliverableSchema);
