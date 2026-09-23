import { Injectable, NotFoundException } from '@nestjs/common';
import type { Course, CourseVersion, Enrollment } from '@prisma/client';

import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { courseCoverUrl } from '../storage/course-keys.js';
import { StorageService } from '../storage/storage.service.js';
import type {
  CourseDetail,
  CourseSummary,
  ListQuery,
  ProgressSummary,
} from './dto/course.schemas.js';

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
  ) {}

  // ── catalog ───────────────────────────────────────────────────────────────

  /**
   * Published courses, with the caller's progress folded in where they are
   * enrolled. Cursor-based from the start: paginating later is a breaking
   * change to the shell, paginating now costs nothing.
   */
  async list(
    userId: string,
    query: ListQuery,
  ): Promise<{ courses: CourseSummary[]; nextCursor: string | null }> {
    const rows = await this.prisma.course.findMany({
      where: { status: 'published', deletedAt: null },
      include: { currentVersion: { include: { sessions: { select: { id: true } } } } },
      // UUIDv7 keys are time-ordered, so the id doubles as a stable cursor.
      orderBy: { id: 'asc' },
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit ? page[page.length - 1].id : null;

    const enrollments = await this.enrollmentsFor(
      userId,
      page.map((c) => c.id),
    );

    const courses = await Promise.all(
      page.map((course) =>
        this.toSummary(userId, course, course.currentVersion?.sessions.length ?? 0, enrollments),
      ),
    );

    return { courses, nextCursor };
  }

  async detail(userId: string, slug: string): Promise<CourseDetail> {
    const course = await this.prisma.course.findFirst({
      where: { slug, status: 'published', deletedAt: null },
      include: {
        currentVersion: { include: { sessions: { orderBy: { order: 'asc' } } } },
      },
    });

    if (!course?.currentVersion) {
      // A draft course and a course that never existed look identical to a
      // learner on purpose: the catalog should not leak unpublished work.
      throw new NotFoundException(`No published course "${slug}".`);
    }

    const sessions = course.currentVersion.sessions;
    const enrollments = await this.enrollmentsFor(userId, [course.id]);
    const summary = await this.toSummary(userId, course, sessions.length, enrollments);

    const progressByKey = new Map(
      (
        await this.prisma.sessionProgress.findMany({
          where: { userId, courseId: course.id },
        })
      ).map((p) => [p.sessionKey, p.status]),
    );

    return {
      ...summary,
      outlineMarkdown: await this.readOutline(course.currentVersion),
      sessions: sessions.map((session) => ({
        key: session.key,
        order: session.order,
        title: session.title,
        weight: (session.weight as 'light' | 'medium' | 'heavy' | null) ?? null,
        deliverable: session.deliverable,
        entryPath: session.entryPath,
        status: progressByKey.get(session.key) ?? 'not_started',
      })),
    };
  }

  /** The outline is markdown inside the package; the shell renders it. */
  private async readOutline(version: CourseVersion): Promise<string | null> {
    const manifest = version.manifest as { outline?: string | null };
    if (!manifest.outline) {
      return null;
    }

    try {
      return await this.storage.getText(`${version.storagePrefix}/${manifest.outline}`);
    } catch {
      // A missing outline is a degraded page, not a broken one.
      return null;
    }
  }

  // ── enrollment ────────────────────────────────────────────────────────────

  async enroll(userId: string, slug: string): Promise<ProgressSummary> {
    const course = await this.prisma.course.findFirst({
      where: { slug, status: 'published', deletedAt: null },
      include: { currentVersion: { include: { sessions: { select: { id: true } } } } },
    });

    if (!course?.currentVersionId || !course.currentVersion) {
      throw new NotFoundException(`No published course "${slug}".`);
    }

    const enrollment = await this.prisma.enrollment.upsert({
      where: { userId_courseId: { userId, courseId: course.id } },
      create: {
        userId,
        courseId: course.id,
        courseVersionId: course.currentVersionId,
      },
      // Re-enrolling after unenrolling resumes rather than resets: the
      // progress rows were never deleted, so wiping them here would be a
      // surprise the learner did not ask for.
      update: { unenrolledAt: null },
    });

    await this.prisma.progressEvent.create({
      data: { userId, courseId: course.id, type: 'course.enrolled' },
    });

    return this.progressFor(userId, course.id, enrollment, course.currentVersion.sessions.length);
  }

  /**
   * Unenrolling is reversible and keeps progress. Deleting it would make
   * "leave the course" an irreversible data loss behind a single click.
   */
  async unenroll(userId: string, slug: string): Promise<void> {
    const course = await this.prisma.course.findFirst({ where: { slug, deletedAt: null } });

    if (!course) {
      throw new NotFoundException(`No course "${slug}".`);
    }

    const { count } = await this.prisma.enrollment.updateMany({
      where: { userId, courseId: course.id, unenrolledAt: null },
      data: { unenrolledAt: new Date() },
    });

    if (count > 0) {
      await this.prisma.progressEvent.create({
        data: { userId, courseId: course.id, type: 'course.unenrolled' },
      });
    }
  }

  // ── shared ────────────────────────────────────────────────────────────────

  private async enrollmentsFor(
    userId: string,
    courseIds: string[],
  ): Promise<Map<string, Enrollment>> {
    if (courseIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.enrollment.findMany({
      where: { userId, courseId: { in: courseIds }, unenrolledAt: null },
    });

    return new Map(rows.map((e) => [e.courseId, e]));
  }

  private async progressFor(
    userId: string,
    courseId: string,
    enrollment: Enrollment,
    totalSessions: number,
  ): Promise<ProgressSummary> {
    const completedSessions = await this.prisma.sessionProgress.count({
      where: { userId, courseId, status: 'complete' },
    });

    return {
      completedSessions,
      totalSessions,
      percent: totalSessions === 0 ? 0 : Math.round((completedSessions / totalSessions) * 100),
      lastSessionKey: enrollment.lastSessionKey,
      lastOpenedAt: enrollment.lastOpenedAt?.toISOString() ?? null,
      startedAt: enrollment.startedAt.toISOString(),
      completedAt: enrollment.completedAt?.toISOString() ?? null,
    };
  }

  private async toSummary(
    userId: string,
    course: Course & { currentVersion: CourseVersion | null },
    sessionCount: number,
    enrollments: Map<string, Enrollment>,
  ): Promise<CourseSummary> {
    const enrollment = enrollments.get(course.id);

    return {
      slug: course.slug,
      title: course.title,
      summary: course.summary,
      level: course.level,
      estimatedHours: course.estimatedHours,
      tags: course.tags,
      accentColor: course.accentColor,
      coverUrl: courseCoverUrl(this.config.get('COURSES_ORIGIN'), course.currentVersion),
      sessionCount,
      version: course.currentVersion?.version ?? '',
      enrollment: enrollment
        ? await this.progressFor(userId, course.id, enrollment, sessionCount)
        : null,
    };
  }
}
