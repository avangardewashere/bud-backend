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

/**
 * An optional number that treats an empty variable as absent.
 *
 * `z.coerce.number()` turns "" into 0, so a variable written as `FOO=` — which
 * is how .env files and compose spell "unset" — becomes a zero that fails every
 * range check. `.optional()` does not help: the key is present, its value is
 * just empty.
 */
const optionalPort = z.preprocess(
  (v) => (v === '' || v === undefined ? undefined : v),
  z.coerce.number().int().min(1).max(65535).optional(),
);

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
    /**
     * Where to send a browser when a sign-in redirect fails — the shell's own
     * sign-in route, which the API cannot know. Hardcoding it once meant every
     * OAuth failure landed on a 404, which is a worse experience than the
     * failure being reported.
     */
    APP_SIGN_IN_PATH: z.string().startsWith('/').default('/login'),
    COURSES_ORIGIN: z.url(),
    API_ORIGIN: z.url(),
    /**
     * Port for course content. Course files must be served from a different
     * *host* to the shell, not merely a different port, because cookies ignore
     * ports.
     *
     * - A port other than PORT: a second listener, on its own hostname. The
     *   normal arrangement.
     * - Equal to PORT: served by the API's own listener, routed by path. For
     *   hosts that expose one port per service; see main.ts for why that stays
     *   isolated from the shell.
     * - Unset: this process serves no courses, which is what you want in
     *   development while the shell runs its own.
     */
    COURSES_PORT: optionalPort,

    // database
    DATABASE_URL: z.string().min(1),

    // sessions
    SESSION_COOKIE_NAME: z.string().min(1).default('bud_session'),
    SESSION_ABSOLUTE_TTL_DAYS: z.coerce.number().int().positive().default(30),
    SESSION_IDLE_TTL_HOURS: z.coerce.number().int().positive().default(336),
    COOKIE_DOMAIN: optionalString,
    COOKIE_SECURE: boolEnv('false'),

    // public demo
    /**
     * A throwaway account anyone can sign into, reset to sample progress
     * between visitors. Off by default: Bud is invite-only, and a self-hosted
     * instance must never grow a public door without asking for one.
     */
    DEMO_MODE: boolEnv('false'),
    DEMO_EMAIL: z.email().default('demo@bud.local'),
    DEMO_NAME: z.string().min(1).default('Demo Learner'),
    /** How long the demo must be untouched before the next visitor resets it. */
    DEMO_RESET_IDLE_MINUTES: z.coerce.number().int().positive().max(1440).default(15),

    // signup
    SIGNUP_MODE: z.enum(['invite_only', 'open', 'closed']).default('invite_only'),

    // github oauth
    GITHUB_CLIENT_ID: optionalString,
    GITHUB_CLIENT_SECRET: optionalString,

    // object storage
    /**
     * Where course package files live.
     *
     * - `s3` (default): any S3-compatible store — MinIO locally, Neon Object
     *   Storage, R2 or S3 in production. The S3_* variables below are then
     *   required, or the AWS SDK's standard names as a set (see
     *   withPlatformDefaults).
     * - `postgres`: a table in the main database. For free hosting with no
     *   object store: a whole course is a few hundred KB, and this saves an
     *   account, a card on file and a download cap. See storage/.
     */
    STORAGE_DRIVER: z.enum(['s3', 'postgres']).default('s3'),
    S3_ENDPOINT: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
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

    // GitHub's callback sets the session cookie on API_ORIGIN's host. Where
    // that host also serves course content (course content sharing the API's
    // port), a live session would sit on the course origin. Refuse until the
    // callback goes through the shell instead.
    if (env.GITHUB_CLIENT_ID && new URL(env.API_ORIGIN).host === new URL(env.COURSES_ORIGIN).host) {
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_CLIENT_ID'],
        message:
          'GitHub sign-in would set the session cookie on the host that serves course content ' +
          '(API_ORIGIN and COURSES_ORIGIN share a host). Point API_ORIGIN at the shell’s /api proxy.',
      });
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
  const env = withPlatformDefaults(raw);
  const result = envSchema.safeParse(env);

  // Checked beside the schema rather than in its superRefine: Zod skips
  // refinements once any field has failed, so a missing DATABASE_URL would
  // hide missing S3 settings until the next boot. Every problem, at once.
  const lines = [
    ...(result.success
      ? []
      : result.error.issues.map(
          (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
        )),
    ...missingS3Settings(env).map(
      (key) => `  - ${key}: ${key} is required when STORAGE_DRIVER is s3 (the default).`,
    ),
  ];

  if (!result.success || lines.length > 0) {
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  return result.data;
}

/** What an s3 driver needs and was not given. An empty variable counts as unset. */
function missingS3Settings(env: Record<string, unknown>): string[] {
  const driver = env.STORAGE_DRIVER;
  if (driver !== undefined && driver !== '' && driver !== 's3') {
    return [];
  }

  return ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((key) => {
    const value = env[key];
    return value === undefined || (typeof value === 'string' && value.trim() === '');
  });
}

/**
 * Values a host or a standard provides, used only where nothing was set
 * explicitly: S3 settings under the AWS SDK's standard names, and the origins
 * Render tells a service about.
 *
 * Render gives every web service RENDER_EXTERNAL_URL (https://<name>.onrender.com)
 * at runtime. The service's own address is exactly what API_ORIGIN is, and —
 * when course content shares its port — what COURSES_ORIGIN is too. Without
 * this, both would have to be typed in before the first deploy, when the
 * address is not yet known: Render appends a suffix when a name is taken.
 *
 * An explicit value always wins, and nothing is derived off Render.
 */
function withPlatformDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const isUnset = (key: string) => raw[key] === undefined || raw[key] === '';
  const env = { ...raw };

  // S3 settings under the AWS SDK's standard names — the names Neon Object
  // Storage hands out (`neon env pull`), and most other S3-compatible stores.
  // Taken only as a complete set, and only when no S3_* connection setting is
  // present: mixing one source's endpoint with another's keys (a local MinIO
  // endpoint with production credentials) must be impossible. S3_BUCKET has
  // no standard name, so it is always set explicitly.
  const s3Connection = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  const awsConnection = ['AWS_ENDPOINT_URL_S3', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
  if (s3Connection.every(isUnset) && awsConnection.every((key) => !isUnset(key))) {
    env.S3_ENDPOINT = raw.AWS_ENDPOINT_URL_S3;
    env.S3_ACCESS_KEY_ID = raw.AWS_ACCESS_KEY_ID;
    env.S3_SECRET_ACCESS_KEY = raw.AWS_SECRET_ACCESS_KEY;
    if (isUnset('S3_REGION') && !isUnset('AWS_REGION')) {
      env.S3_REGION = raw.AWS_REGION;
    }
  }

  const external = raw.RENDER_EXTERNAL_URL;
  if (typeof external !== 'string' || external === '') {
    return env;
  }

  if (isUnset('API_ORIGIN')) {
    env.API_ORIGIN = external;
  }
  // Only when courses share the API's listener; a separate listener would be
  // on a different address, which this variable does not describe.
  const asText = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
  const sharesPort =
    !isUnset('COURSES_PORT') && asText(raw.COURSES_PORT) === (asText(raw.PORT) ?? '3102');
  if (isUnset('COURSES_ORIGIN') && sharesPort) {
    env.COURSES_ORIGIN = external;
  }

  return env;
}
