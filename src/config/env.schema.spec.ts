import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema.js';

/**
 * These rules are the reason boot fails loudly instead of serving a
 * misconfigured API, so they are worth pinning down.
 */

const baseEnv = {
  APP_ORIGIN: 'http://localhost:3000',
  COURSES_ORIGIN: 'http://localhost:3002',
  API_ORIGIN: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://bud:bud@localhost:5432/bud',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'bud-courses',
  S3_ACCESS_KEY_ID: 'minioadmin',
  S3_SECRET_ACCESS_KEY: 'minioadmin',
};

describe('validateEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = validateEnv({ ...baseEnv });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3102);
    expect(env.SIGNUP_MODE).toBe('invite_only');
    expect(env.SESSION_COOKIE_NAME).toBe('bud_session');
  });

  it('coerces numeric strings, because env vars are always strings', () => {
    const env = validateEnv({ ...baseEnv, PORT: '8080', SESSION_ABSOLUTE_TTL_DAYS: '7' });

    expect(env.PORT).toBe(8080);
    expect(env.SESSION_ABSOLUTE_TTL_DAYS).toBe(7);
  });

  it('turns "true"/"false" strings into booleans', () => {
    expect(validateEnv({ ...baseEnv, COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
    expect(validateEnv({ ...baseEnv }).COOKIE_SECURE).toBe(false);
  });

  it('treats an empty optional variable as absent', () => {
    const env = validateEnv({ ...baseEnv, COOKIE_DOMAIN: '', SENTRY_DSN: '' });

    expect(env.COOKIE_DOMAIN).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it('treats an empty COURSES_PORT as unset rather than as zero', () => {
    // .env files and compose spell "unset" as `COURSES_PORT=`, and z.coerce
    // turns "" into 0 — which failed the range check and refused to boot. The
    // documented default in .env.example is exactly this case.
    const env = validateEnv({ ...baseEnv, COURSES_PORT: '' });

    expect(env.COURSES_PORT).toBeUndefined();
  });

  it('still reads a COURSES_PORT that is set', () => {
    expect(validateEnv({ ...baseEnv, COURSES_PORT: '3101' }).COURSES_PORT).toBe(3101);
  });

  it('rejects a nonsense COURSES_PORT rather than silently ignoring it', () => {
    expect(() => validateEnv({ ...baseEnv, COURSES_PORT: '0' })).toThrowError(/COURSES_PORT/);
    expect(() => validateEnv({ ...baseEnv, COURSES_PORT: 'banana' })).toThrowError(/COURSES_PORT/);
  });

  it('defaults the sign-in path to the route the shell actually serves', () => {
    // Hardcoded as /sign-in once, while the shell serves /login — so every
    // OAuth failure redirected to a 404.
    expect(validateEnv({ ...baseEnv }).APP_SIGN_IN_PATH).toBe('/login');
  });

  it('insists the sign-in path is a path, not a URL', () => {
    // An absolute URL here would let a misconfiguration redirect users off-site.
    expect(() =>
      validateEnv({ ...baseEnv, APP_SIGN_IN_PATH: 'https://evil.example/login' }),
    ).toThrowError(/APP_SIGN_IN_PATH/);
  });

  it('rejects a courses origin that matches the app origin', () => {
    // The sandbox only isolates course JavaScript if the origins actually differ.
    expect(() => validateEnv({ ...baseEnv, COURSES_ORIGIN: baseEnv.APP_ORIGIN })).toThrowError(
      /COURSES_ORIGIN must differ/,
    );
  });

  it('rejects an insecure cookie in production', () => {
    expect(() =>
      validateEnv({ ...baseEnv, NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
    ).toThrowError(/COOKIE_SECURE must be true in production/);
  });

  it('rejects a seed password in production', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        SEED_ADMIN_PASSWORD: 'anything',
      }),
    ).toThrowError(/SEED_ADMIN_PASSWORD must not be set in production/);
  });

  it('rejects half-configured GitHub OAuth', () => {
    expect(() => validateEnv({ ...baseEnv, GITHUB_CLIENT_ID: 'id' })).toThrowError(
      /must be set together/,
    );

    expect(() =>
      validateEnv({ ...baseEnv, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }),
    ).not.toThrow();
  });

  it('reports every problem at once, not just the first', () => {
    let message = '';
    try {
      validateEnv({ APP_ORIGIN: 'not-a-url' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('APP_ORIGIN');
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('S3_BUCKET');
  });
});

describe('STORAGE_DRIVER', () => {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, ...withoutS3 } = baseEnv;
  void [S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY];

  it('defaults to s3, and then requires every S3 setting', () => {
    let message = '';
    try {
      validateEnv({ ...withoutS3 });
    } catch (error) {
      message = (error as Error).message;
    }

    for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      expect(message).toContain(`${key} is required when STORAGE_DRIVER is s3`);
    }
  });

  it('needs no S3 settings at all when files live in Postgres', () => {
    const env = validateEnv({ ...withoutS3, STORAGE_DRIVER: 'postgres' });

    expect(env.STORAGE_DRIVER).toBe('postgres');
    expect(env.S3_BUCKET).toBeUndefined();
  });

  it('treats an empty S3 variable as missing, not as a value', () => {
    expect(() => validateEnv({ ...baseEnv, S3_BUCKET: '' })).toThrowError(/S3_BUCKET is required/);
  });

  it('rejects a driver it does not know', () => {
    expect(() => validateEnv({ ...baseEnv, STORAGE_DRIVER: 'gcs' })).toThrowError(/STORAGE_DRIVER/);
  });
});

/**
 * On Render, the service's own address is only known once it exists — a taken
 * name gets a suffix — so the origins that are that address default to it.
 */
describe('origins from RENDER_EXTERNAL_URL', () => {
  const { API_ORIGIN, COURSES_ORIGIN, ...withoutOrigins } = baseEnv;
  void [API_ORIGIN, COURSES_ORIGIN];
  const render = 'https://bud-api-x7k2.onrender.com';

  it('fills both origins when course content shares the port', () => {
    const env = validateEnv({
      ...withoutOrigins,
      RENDER_EXTERNAL_URL: render,
      PORT: '10000',
      COURSES_PORT: '10000',
    });

    expect(env.API_ORIGIN).toBe(render);
    expect(env.COURSES_ORIGIN).toBe(render);
  });

  it('fills only the API origin when courses have their own listener', () => {
    // A separate listener is a separate address, which this variable does not
    // describe — so COURSES_ORIGIN is still required.
    expect(() =>
      validateEnv({
        ...withoutOrigins,
        RENDER_EXTERNAL_URL: render,
        PORT: '10000',
        COURSES_PORT: '10001',
      }),
    ).toThrowError(/COURSES_ORIGIN/);
  });

  it('compares against the default port when PORT is unset', () => {
    const env = validateEnv({
      ...withoutOrigins,
      RENDER_EXTERNAL_URL: render,
      COURSES_PORT: '3102',
    });

    expect(env.COURSES_ORIGIN).toBe(render);
  });

  it('never overrides a value that was set explicitly', () => {
    const env = validateEnv({
      ...baseEnv,
      RENDER_EXTERNAL_URL: render,
      PORT: '10000',
      COURSES_PORT: '10000',
    });

    expect(env.API_ORIGIN).toBe(baseEnv.API_ORIGIN);
    expect(env.COURSES_ORIGIN).toBe(baseEnv.COURSES_ORIGIN);
  });

  it('derives nothing off Render', () => {
    expect(() =>
      validateEnv({ ...withoutOrigins, PORT: '10000', COURSES_PORT: '10000' }),
    ).toThrowError(/API_ORIGIN/);
  });

  it('still refuses a courses origin equal to the app origin', () => {
    // The fallback must not be a way around the isolation rule.
    expect(() =>
      validateEnv({
        ...withoutOrigins,
        APP_ORIGIN: render,
        RENDER_EXTERNAL_URL: render,
        PORT: '10000',
        COURSES_PORT: '10000',
      }),
    ).toThrowError(/COURSES_ORIGIN must differ from APP_ORIGIN/);
  });
});

describe('GitHub sign-in and the course origin', () => {
  const oauth = { GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' };

  it('refuses GitHub sign-in when its callback host also serves course content', () => {
    // The callback sets the session cookie on API_ORIGIN's host — here the
    // host that serves author-controlled course HTML.
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...oauth,
        API_ORIGIN: 'https://bud-api.onrender.com',
        COURSES_ORIGIN: 'https://bud-api.onrender.com',
      }),
    ).toThrowError(/GitHub sign-in would set the session cookie on the host that serves course/);
  });

  it('allows it when the two are different hosts', () => {
    expect(() => validateEnv({ ...baseEnv, ...oauth })).not.toThrow();
  });

  it('does not care where course content is served when GitHub sign-in is off', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        API_ORIGIN: 'https://bud-api.onrender.com',
        COURSES_ORIGIN: 'https://bud-api.onrender.com',
      }),
    ).not.toThrow();
  });
});

/**
 * Neon Object Storage (and the AWS SDK's own convention) name S3 settings
 * AWS_ENDPOINT_URL_S3 / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION.
 */
describe('S3 settings under the AWS standard names', () => {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, ...withoutS3 } = baseEnv;
  void [S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY];
  const aws = {
    AWS_ENDPOINT_URL_S3: 'https://br-x.storage.c-6.us-east-2.aws.neon.tech',
    AWS_ACCESS_KEY_ID: 'neon-key',
    AWS_SECRET_ACCESS_KEY: 'neon-secret',
    AWS_REGION: 'us-east-2',
  };

  it('takes the full AWS set when no S3_* connection setting is given', () => {
    const env = validateEnv({ ...withoutS3, S3_BUCKET, ...aws });

    expect(env.S3_ENDPOINT).toBe(aws.AWS_ENDPOINT_URL_S3);
    expect(env.S3_ACCESS_KEY_ID).toBe('neon-key');
    expect(env.S3_SECRET_ACCESS_KEY).toBe('neon-secret');
    expect(env.S3_REGION).toBe('us-east-2');
  });

  it('never mixes: any S3_* connection setting means the AWS set is ignored', () => {
    // A local MinIO endpoint must not end up paired with production keys.
    expect(() =>
      validateEnv({ ...withoutS3, S3_BUCKET, S3_ENDPOINT: 'http://localhost:9000', ...aws }),
    ).toThrowError(/S3_ACCESS_KEY_ID is required/);
  });

  it('ignores an incomplete AWS set rather than half-using it', () => {
    const { AWS_SECRET_ACCESS_KEY, ...partial } = aws;
    void AWS_SECRET_ACCESS_KEY;

    expect(() => validateEnv({ ...withoutS3, S3_BUCKET, ...partial })).toThrowError(
      /S3_ENDPOINT is required/,
    );
  });

  it('keeps an explicit S3_REGION over AWS_REGION', () => {
    const env = validateEnv({ ...withoutS3, S3_BUCKET, S3_REGION: 'auto', ...aws });

    expect(env.S3_REGION).toBe('auto');
  });

  it('still needs the bucket named explicitly — there is no standard name for it', () => {
    expect(() => validateEnv({ ...withoutS3, ...aws })).toThrowError(/S3_BUCKET is required/);
  });
});

/**
 * TRUST_PROXY is parsed elsewhere (config/trust-proxy.ts), because the Fastify
 * adapter needs it before this module exists. It still has to travel through
 * here: ConfigModule writes *only what this validator returns* back into
 * process.env, so a variable this schema does not declare is stripped on the way
 * through and the setting silently reverts to its default — which is the exact
 * failure the setting was added to prevent.
 */
describe('TRUST_PROXY', () => {
  it('survives validation so the value in .env reaches the adapter', () => {
    const env = validateEnv({ ...baseEnv, TRUST_PROXY: '10.1.2.3' });

    expect(env.TRUST_PROXY).toBe('10.1.2.3');
  });

  it('is absent when nothing set it, rather than an empty string', () => {
    expect(validateEnv({ ...baseEnv }).TRUST_PROXY).toBeUndefined();
    expect(validateEnv({ ...baseEnv, TRUST_PROXY: '' }).TRUST_PROXY).toBeUndefined();
  });

  it('is passed through unvalidated, so a bad value fails where it is parsed', () => {
    // A hop count must still reach parseTrustProxy, which is what refuses it.
    expect(validateEnv({ ...baseEnv, TRUST_PROXY: '1' }).TRUST_PROXY).toBe('1');
  });
});
