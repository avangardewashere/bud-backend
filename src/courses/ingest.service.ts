import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { type Course, type CourseVersion, Prisma } from '@prisma/client';
import type { Buffer } from 'node:buffer';

import { extractFiles } from '../course-spec/archive.js';
import { CourseSpecService } from '../course-spec/course-spec.service.js';
import type { CourseManifest } from '../course-spec/manifest.schema.js';
import type { ValidationReport } from '../course-spec/validation.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { contentTypeFor, StorageService } from '../storage/storage.service.js';

export interface IngestResult {
  report: ValidationReport;
  /** Only present when the package validated and was stored. */
  course?: Course;
  version?: CourseVersion;
  filesStored?: number;
}

/**
 * Turns an uploaded package into a draft course version.
 *
 * Order matters: validate, then store the files, then write the database rows.
 * Files first means a failed database write leaves orphaned objects, which a
 * prefix delete cleans up; rows first would mean a course pointing at content
 * that does not exist, which nothing can clean up automatically.
 *
 * A new upload never overwrites an old one. Same course id with a new version
 * creates a new `course_versions` row at a new storage prefix, enrollments
 * carry over, and progress survives because it is keyed by session key rather
 * than by version (Tech-Information.md §5).
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courseSpec: CourseSpecService,
    private readonly storage: StorageService,
  ) {}

  async ingest(archive: Buffer, uploadedById: string): Promise<IngestResult> {
    const { report, manifest } = await this.courseSpec.validate(archive, {
      isCourseIdTaken: async (id) => {
        const existing = await this.prisma.course.findUnique({ where: { slug: id } });
        // Re-uploading the same course is not a clash — it is a new version.
        // Only a *different* course wanting the same id is.
        return existing !== null && existing.deletedAt !== null;
      },
    });

    if (!report.ok || !manifest) {
      return { report };
    }

    await this.assertVersionIsNew(manifest);

    const prefix = StorageService.prefixFor(manifest.id, manifest.version);
    const files = await extractFiles(archive);

    await this.storage.ensureBucket();

    let stored = 0;
    try {
      for (const [path, bytes] of files) {
        await this.storage.put(`${prefix}/${path}`, bytes, contentTypeFor(path));
        stored += 1;
      }

      const { course, version } = await this.writeRows(
        manifest,
        prefix,
        archive.byteLength,
        uploadedById,
      );

      this.logger.log(`Ingested ${manifest.id}@${manifest.version} — ${stored} files at ${prefix}`);

      return { report, course, version, filesStored: stored };
    } catch (cause) {
      // Another upload of this same version got there first — a double submit
      // passes assertVersionIsNew twice, and the loser fails on the unique
      // (course, version) row. Both wrote identical keys, so cleaning up here
      // would delete the winner's files out from under a published version.
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
        this.logger.warn(`Ingest of ${manifest.id}@${manifest.version} lost a race; keeping files`);
        throw cause;
      }

      // Never leave a half-written version behind. The trailing slash matters:
      // without it, cleaning up 1.0.0 would also match every key of 1.0.0-rc.1
      // or 1.0.01 — other versions, possibly the one being served.
      const removed = await this.storage.deletePrefix(`${prefix}/`).catch(() => 0);
      this.logger.error(
        { err: cause },
        `Ingest of ${manifest.id}@${manifest.version} failed; removed ${removed} stored objects`,
      );
      throw cause;
    }
  }

  /**
   * Re-uploading an identical version is refused rather than silently
   * overwriting: stored files are immutable, so the two would disagree.
   */
  private async assertVersionIsNew(manifest: CourseManifest): Promise<void> {
    const course = await this.prisma.course.findUnique({
      where: { slug: manifest.id },
      include: { versions: { where: { version: manifest.version }, take: 1 } },
    });

    if (course && course.versions.length > 0) {
      throw new BadRequestException(
        `Version ${manifest.version} of "${manifest.id}" already exists. ` +
          'Bump the version in the manifest to upload a change.',
      );
    }
  }

  private async writeRows(
    manifest: CourseManifest,
    storagePrefix: string,
    sizeBytes: number,
    createdById: string,
  ): Promise<{ course: Course; version: CourseVersion }> {
    return this.prisma.$transaction(async (tx) => {
      const course = await tx.course.upsert({
        where: { slug: manifest.id },
        create: {
          slug: manifest.id,
          title: manifest.title,
          summary: manifest.summary,
          level: manifest.level,
          estimatedHours: manifest.estimatedHours ? Math.round(manifest.estimatedHours) : null,
          tags: manifest.tags,
          accentColor: manifest.theme?.accent,
          coverKey: manifest.cover ? `${storagePrefix}/${manifest.cover}` : null,
          createdById,
        },
        // A new version refreshes the catalog metadata but never the status:
        // uploading to a published course must not unpublish it, and must not
        // publish a draft by surprise.
        update: {
          title: manifest.title,
          summary: manifest.summary,
          level: manifest.level,
          estimatedHours: manifest.estimatedHours ? Math.round(manifest.estimatedHours) : null,
          tags: manifest.tags,
          accentColor: manifest.theme?.accent,
          coverKey: manifest.cover ? `${storagePrefix}/${manifest.cover}` : null,
          deletedAt: null,
        },
      });

      const version = await tx.courseVersion.create({
        data: {
          courseId: course.id,
          version: manifest.version,
          manifest,
          storagePrefix,
          sizeBytes,
        },
      });

      // Denormalised from the manifest so the session rail and progress maths
      // are plain SQL rather than JSON digging on every request.
      await tx.courseSession.createMany({
        data: manifest.sessions.map((session) => ({
          courseVersionId: version.id,
          key: session.id,
          order: session.order,
          title: session.title,
          entryPath: session.entry,
          weight: session.weight,
          deliverable: session.deliverable,
        })),
      });

      return { course, version };
    });
  }
}
