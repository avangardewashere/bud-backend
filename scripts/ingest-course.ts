/**
 * Ingest a course package from a directory on disk.
 *
 *   npm run course:ingest -- "../Bud - frontend/courses/docker-fundamentals/1.0.0"
 *
 * Zips the directory in memory and runs it through exactly the same path an
 * admin upload takes — same validator, same storage, same rows — so this is a
 * convenience, not a second ingestion route that could drift from the real one.
 *
 * Development only. In production a course arrives through POST /admin/courses.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';

import { formatReport } from '../src/cli/report.js';
import { AppConfigService } from '../src/config/app-config.service.js';
import { validateEnv, type Env } from '../src/config/env.schema.js';
import { CourseSpecService } from '../src/course-spec/course-spec.service.js';
import { packCourseDirectory } from '../src/course-spec/pack.js';
import { IngestService } from '../src/courses/ingest.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StorageService } from '../src/storage/storage.service.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

async function main(): Promise<void> {
  const [dirArg, ...rest] = process.argv.slice(2);
  const publish = rest.includes('--publish');

  if (!dirArg) {
    throw new Error('Usage: npm run course:ingest -- <course directory> [--publish]');
  }

  const dir = resolve(dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }

  // Wired by hand rather than through Nest's container: this script runs under
  // tsx, whose esbuild transform cannot emit decorator metadata, so the DI
  // container would inject undefined for every constructor parameter. These are
  // ordinary classes, and TypeScript still checks the wiring.
  const config = new AppConfigService(new ConfigService<Env, true>(validateEnv(process.env)));
  const prisma = new PrismaService(config);
  const storage = new StorageService(config, prisma);
  const ingest = new IngestService(prisma, new CourseSpecService(), storage);

  try {
    await prisma.$connect();

    const admin = await prisma.user.findFirst({ where: { role: 'admin' } });
    if (!admin) {
      throw new Error('No admin user. Run `npm run db:seed` first.');
    }

    console.log(`Packaging ${dir}`);
    // The same packer `bud-course validate` uses, so what this ingests is what
    // an author was told would be accepted.
    const { archive, skipped } = await packCourseDirectory(dir);
    console.log(`  ${(archive.byteLength / 1024).toFixed(1)} KB\n`);
    for (const name of skipped) {
      console.log(`  · left out: ${name}`);
    }

    const result = await ingest.ingest(archive, admin.id);

    for (const line of formatReport(result.report)) {
      console.log(line);
    }

    console.log();

    if (!result.report.ok || !result.course) {
      console.error('Package rejected. Nothing was stored.');
      process.exitCode = 1;
      return;
    }

    console.log(
      `Ingested ${result.course.slug}@${result.version?.version} ` +
        `(${result.filesStored} files) as a ${result.course.status}.`,
    );

    if (publish) {
      await prisma.course.update({
        where: { id: result.course.id },
        data: { status: 'published', currentVersionId: result.version!.id },
      });
      await prisma.courseVersion.update({
        where: { id: result.version!.id },
        data: { publishedAt: new Date() },
      });
      console.log(`Published. It is now in the catalog at /courses/${result.course.slug}.`);
    } else {
      console.log('Still a draft. Re-run with --publish, or PATCH /admin/courses/:id.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('\nIngest failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
