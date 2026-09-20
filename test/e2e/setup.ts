import { existsSync } from 'node:fs';

/**
 * Runs inside each worker before its test file.
 *
 * The e2e fixtures talk to Postgres directly, so they need DATABASE_URL — and
 * unlike the application, a test runner has no config module to validate and
 * load it. Loading it here rather than in the vitest config because config runs
 * in the main process and the tests run in workers.
 */
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
