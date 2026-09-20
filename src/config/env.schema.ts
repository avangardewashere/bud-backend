import { z } from 'zod';

/**
 * Rule 2 from Tech-Information.md section 10: all config via environment
 * variables, validated on boot, fail fast. Nothing reads process.env outside
 * this file — inject AppConfigService instead.
 */

/**
 * Environment variables are always strings. Default *before* transform so the
 * default is an input value ('false'), not an output value — Zod 4 requires
 * `.default()` to match the output type of whatever it wraps.
 */
const boolEnv = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');

/** Treats an empty variable as absent, which is how shells and compose files write "unset". */
const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

export const envSchema = z
  .object({
    // runtime
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3102),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // origins
    APP_ORIGIN: z.url(),
    COURSES_ORIGIN: z.url(),
    API_ORIGIN: z.url(),
    /**
     * Port for the course-content listener. Course files must be served from a
     * different *host* to the shell, not merely a different port, because
     * cookies ignore ports — so this is a second listener rather than a route
     * on the API. Leave unset to not serve courses from this process at all,
     * which is what you want in development while the shell runs its own.
     */
    COURSES_PORT: z.coerce.number().int().min(1).max(65535).optional(),

    // database
    DATABASE_URL: z.string().min(1),

    // sessions
    SESSION_COOKIE_NAME: z.string().min(1).default('bud_session'),
    SESSION_ABSOLUTE_TTL_DAYS: z.coerce.number().int().positive().default(30),
    SESSION_IDLE_TTL_HOURS: z.coerce.number().int().positive().default(336),
    COOKIE_DOMAIN: optionalString,
    COOKIE_SECURE: boolEnv('false'),

    // signup
    SIGNUP_MODE: z.enum(['invite_only', 'open', 'closed']).default('invite_only'),

    // github oauth
    GITHUB_CLIENT_ID: optionalString,
    GITHUB_CLIENT_SECRET: optionalString,

    // object storage
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: boolEnv('true'),

    // mail
    SMTP_HOST: z.string().min(1).default('localhost'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_FROM: z.string().min(1).default('Bud <no-reply@bud.local>'),

    // rate limiting
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(2000),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

    // errors
    SENTRY_DSN: optionalString,

    // seed (development only)
    SEED_ADMIN_EMAIL: z.email().default('admin@bud.local'),
    SEED_ADMIN_PASSWORD: optionalString,
    SEED_ADMIN_NAME: z.string().default('Bud Admin'),
  })
  .superRefine((env, ctx) => {
    // The whole security model rests on course HTML living somewhere the shell's
    // cookies cannot reach. If these ever match, the isolation is gone.
    if (env.APP_ORIGIN === env.COURSES_ORIGIN) {
      ctx.addIssue({
        code: 'custom',
        path: ['COURSES_ORIGIN'],
        message:
          'COURSES_ORIGIN must differ from APP_ORIGIN. Course JavaScript is author-controlled ' +
          'and must not share an origin with the shell.',
      });
    }

    if (env.NODE_ENV === 'production') {
      if (!env.COOKIE_SECURE) {
        ctx.addIssue({
          code: 'custom',
          path: ['COOKIE_SECURE'],
          message: 'COOKIE_SECURE must be true in production.',
        });
      }
      if (env.SEED_ADMIN_PASSWORD) {
        ctx.addIssue({
          code: 'custom',
          path: ['SEED_ADMIN_PASSWORD'],
          message: 'SEED_ADMIN_PASSWORD must not be set in production.',
        });
      }
    }

    // Half-configured OAuth is worse than none: the route would exist and fail.
    if (Boolean(env.GITHUB_CLIENT_ID) !== Boolean(env.GITHUB_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_CLIENT_SECRET'],
        message:
          'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together, or both left empty.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Passed to ConfigModule.forRoot({ validate }). Throwing here aborts boot,
 * which is the point: a container that cannot be configured must not serve.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  return result.data;
}
