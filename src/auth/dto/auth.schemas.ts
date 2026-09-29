import { z } from 'zod';

/**
 * Request shapes for the auth endpoints. These schemas are the contract:
 * they validate at runtime and generate the OpenAPI body schemas, so the
 * published spec and the accepted input cannot drift apart.
 */

/**
 * Emails are compared case-insensitively, so normalise once at the edge.
 *
 * Normalise *then* validate, in that order. Written the obvious way round —
 * `z.email().trim().toLowerCase()` — the format check belongs to the base schema
 * and runs first, so the transforms never saw a padded address:
 * `" Bob@Example.com "` was rejected as malformed rather than cleaned up, and
 * the `.trim()` was dead code. Lower-casing happened to work, which is why it
 * went unnoticed. It matters beyond a stray space: an invite is matched by
 * comparing this address to the stored one (auth.service.ts), and a learner who
 * pastes their address with a trailing newline should sign in, not see a
 * validation error.
 *
 * `preprocess` rather than `.pipe()` because of what each publishes. The shell
 * generates its client from the OpenAPI body schemas, and Zod derives the
 * *input* side of a pipe from its left-hand schema — a bare `type: string`,
 * losing `format: email`, `maxLength` and the pattern. Through `preprocess` the
 * emitted schema is unchanged in both directions, so the contract stays put
 * while the runtime becomes forgiving about whitespace and case.
 */
export const emailSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.email({ message: 'Must be a valid email address' }).max(320),
);

/**
 * Length is the only rule worth enforcing. Composition rules push people
 * toward predictable substitutions; the upper bound is there because argon2
 * will happily burn CPU on a megabyte of input.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256, 'Password must be at most 256 characters');

export const nameSchema = z.string().trim().min(1, 'Name is required').max(120);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema,
  /** Required while SIGNUP_MODE is invite_only. */
  inviteToken: z.string().trim().min(1).max(256).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(256),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ── responses ───────────────────────────────────────────────────────────────
//
// The shell generates its typed client straight from /docs/openapi.json, so a
// response without a schema becomes `unknown` on the other side. These describe
// the JSON on the wire — dates are ISO strings here, not Date objects.

/** One user shape for the whole API. /me and the auth endpoints agree. */
export const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: z.enum(['learner', 'admin']),
  avatarUrl: z.string().nullable(),
  timezone: z.string(),
  createdAt: z.iso.datetime(),
});

export const userEnvelopeSchema = z.object({ user: publicUserSchema });

export const changePasswordResultSchema = z.object({
  /** How many other sessions were signed out. */
  revokedSessions: z.int().nonnegative(),
});

export const errorSchema = z.object({
  statusCode: z.int(),
  error: z.string(),
  /**
   * Stable machine-readable identifier, present on every error. Branch on this,
   * never on `message` — messages are free to be reworded, codes are not.
   */
  code: z.string(),
  message: z.string(),
  /** Extra context for one error; newline-separated when it has several lines. */
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string(), code: z.string() })).optional(),
  path: z.string(),
  timestamp: z.iso.datetime(),
});

/** What the sign-in screen needs to know before it renders. */
export const authProvidersSchema = z.object({
  password: z.boolean(),
  github: z.boolean(),
  /** A public demo account anyone can try, without credentials. */
  demo: z.boolean(),
  signupMode: z.enum(['invite_only', 'open', 'closed']),
});
