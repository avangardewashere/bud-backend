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
    url: process.env.DATABASE_URL,
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
