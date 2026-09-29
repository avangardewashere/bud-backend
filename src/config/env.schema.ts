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

/**
 * Comparing two origin settings, the way a browser would.
 *
 * Parsed rather than compared as strings, because the spelling is not the
 * origin: a trailing slash, an upper-case host and an explicitly written
 * default port all describe the same origin as their plain twin.
 *
 * Returns false when either side cannot be parsed, which happens more often
 * than it looks: these refinements run even when a field has already failed its
 * own `z.url()` check — the docblock in validateEnv used to say otherwise — so
 * `new URL(…)` here on a malformed value threw a bare `TypeError: Invalid URL`
 * out of boot, replacing the list of every problem with a stack trace naming no
 * variable at all. The field's own error is the one worth reporting; a
 * comparison against a value that is not a URL has nothing to say.
 */
function compareUrls(a: string, b: string, part: (url: URL) => string): boolean {
  try {
    return part(new URL(a)) === part(new URL(b));
  } catch {
    return false;
  }
}

const sameOrigin = (a: string, b: string) => compareUrls(a, b, (url) => url.origin);
const sameHost = (a: string, b: string) => compareUrls(a, b, (url) => url.host);

/**
 * An origin setting, canonicalised on the way in.
 *
 * Every one of these is joined onto something else downstream — a CORS check
 * against the browser's `Origin` header, a `redirect_uri` for GitHub, the path a
 * cookie is scoped to — and a value that merely *parses* is not enough for any
 * of them. `https://bud.example/api/` built a `redirect_uri` of
 * `https://bud.example/api//auth/github/callback`, which no OAuth app matches,
 * and `https://APP.example` never equals the `Origin` a browser sends. Both were
 * a trailing slash and a capital away from working, on settings a person types
 * once into a dashboard.
 *
 * So the value is normalised here rather than defended against in each consumer:
 * lower-cased host, no default port, no trailing slash, path kept (the shell's
 * `/api` proxy needs it). Found by a test asserting the state cookie's path is
 * one the callback URL matches.
 */
const originSetting = z.url().transform((value) => {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
});

export const envSchema = z
  .object({
    // runtime
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3102),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /**
     * Declared but not validated here: config/trust-proxy.ts owns the parsing
     * and the refusal of a hop count, because the Fastify adapter needs the
     * value before this module has been instantiated.
     *
     * It has to be declared all the same. ConfigModule assigns *only what this
     * validator returns* back into process.env, and a Zod object strips what it
     * does not declare — so without this line a TRUST_PROXY set in .env reached
     * nothing, the documented override did nothing, and a hop count no longer
     * failed boot. Silently, which is the whole failure this setting exists to
     * prevent.
     */
    TRUST_PROXY: optionalString,

    // origins
    APP_ORIGIN: originSetting,
    /**
     * Where to send a browser when a sign-in redirect fails — the shell's own
     * sign-in route, which the API cannot know. Hardcoding it once meant every
     * OAuth failure landed on a 404, which is a worse experience than the
     * failure being reported.
     */
    APP_SIGN_IN_PATH: z.string().startsWith('/').default('/login'),
    COURSES_ORIGIN: originSetting,
    API_ORIGIN: originSetting,
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
    /**
     * Required to boot with `SIGNUP_MODE=open`, and named after what it admits.
     *
     * Open signup cannot be made enumeration-proof here. `POST /auth/register`
     * signs the new account in as it creates it, so the answer differs — 201
     * with a cookie, or 409 — and that difference *is* the account-existence
     * oracle. Hiding it means not answering until the address is proven, which
     * means mail, which does not exist (nothing reads SMTP_* below). See the
     * refusal in the superRefine, and README's security-review table.
     *
     * So the choice is deliberate rather than blocked: an operator who wants a
     * public front door can have one, having typed the reason it is a trade-off.
     */
    SIGNUP_OPEN_ACK_ENUMERATION: boolEnv('false'),

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
    /**
     * Declared, read by nothing: there is no mail flow yet (Phase 2).
     *
     * Optional rather than defaulted, and an empty value counts as unset — the
     * way `.env` files and compose spell it. `.default()` fires only on
     * `undefined`, so `SMTP_HOST=` in a copied `.env.prod.example` used to fail
     * `min(1)` and abort boot over a setting nothing reads. And when the mail
     * flow does land it must be able to tell "not configured" from "configured
     * as localhost", or a production instance would post mail into the void
     * instead of refusing to start.
     */
    SMTP_HOST: optionalString,
    SMTP_PORT: optionalPort,
    SMTP_FROM: optionalString,

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
    //
    // Compared as origins, not as strings. A browser does not care how a URL was
    // typed: `http://localhost:3000/`, `http://LOCALHOST:3000` and
    // `http://localhost:80` beside `http://localhost` are each the same origin
    // as their plainly-spelled twin, and each one used to boot past this guard
    // with the sandbox quietly gone. Verified by running the four spellings
    // through validateEnv.
    if (sameOrigin(env.APP_ORIGIN, env.COURSES_ORIGIN)) {
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
    if (env.GITHUB_CLIENT_ID && sameHost(env.API_ORIGIN, env.COURSES_ORIGIN)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_CLIENT_ID'],
        message:
          'GitHub sign-in would set the session cookie on the host that serves course content ' +
          '(API_ORIGIN and COURSES_ORIGIN share a host). Point API_ORIGIN at the shell’s /api proxy.',
      });
    }

    // Open signup leaks which addresses have accounts, and cannot stop doing so
    // without a way to reach the address. One-directional on purpose: a stray
    // acknowledgement next to invite_only or closed is accepted and ignored, so
    // turning the front door back off never fails boot.
    if (env.SIGNUP_MODE === 'open' && !env.SIGNUP_OPEN_ACK_ENUMERATION) {
      ctx.addIssue({
        code: 'custom',
        path: ['SIGNUP_MODE'],
        message:
          'SIGNUP_MODE=open lets anyone test whether an address has an account: register ' +
          'answers 409 for a taken address and 201 for a free one. Answering identically ' +
          'instead needs a mail flow to prove the address, and Bud has none yet. To accept ' +
          'that trade-off, set SIGNUP_OPEN_ACK_ENUMERATION=true. To avoid it, leave ' +
          'SIGNUP_MODE at invite_only and hand out invites with `npm run invite`.',
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

  // Checked beside the schema rather than in its superRefine: Zod skips a
  // refinement when a key it reads is absent, so a missing DATABASE_URL would
  // hide missing S3 settings until the next boot. Every problem, at once.
  //
  // It does *not* skip refinements for a key that is present and invalid — they
  // run on the parsed-so-far value, which is why the origin comparisons above
  // have to tolerate a value that is not a URL rather than assume `z.url()`
  // already rejected it.
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
