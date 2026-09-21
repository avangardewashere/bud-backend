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
