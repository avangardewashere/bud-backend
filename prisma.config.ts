import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the migration connection URL out of schema.prisma and into
 * this file. The schema no longer knows how to reach a database; the CLI reads
 * it from here, and the application reads it from AppConfigService.
 *
 * Prisma 7 also stopped loading .env automatically. Node can do it itself.
 */
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // Migrations need a direct connection. Behind a transaction-mode pooler
    // (Neon's `-pooler` host, PgBouncer) they fail with 'prepared statement
    // "s0" already exists', so where the app's DATABASE_URL is pooled, set
    // DATABASE_URL_UNPOOLED to the direct one. Unset, both are the same.
    url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
