import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Course, CourseVersion, Enrollment } from '@prisma/client';

import { AppException } from '../common/errors/app-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface SessionProgressView {
  sessionKey: string;
  status: 'not_started' | 'in_progress' | 'complete';
  fraction: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CourseProgressView {
  slug: string;
  title: string;
  accentColor: string | null;
  coverUrl: string | null;
  completedSessions: number;
  totalSessions: number;
  percent: number;
  lastSessionKey: string | null;
  lastOpenedAt: string | null;
  startedAt: string;
  completedAt: string | null;
}

/**
 * Progress is the platform's, not the course's.
 *
 * A course may *suggest* completion through `bud.complete`, and the shell
 * records it — but the shell is the source of truth and never syncs its state
 * back into the course's blob (Overall Plan §8.4). The two can disagree; ours
 * is the one that counts.
 *
 * Everything here is keyed by course + manifest session key, never by course
 * version, so re-uploading a course leaves progress intact.
 */
@Injectable()
export class ProgressService {
  constructor(private readonly prisma: PrismaService) {}

  private async enrolled(
    userId: string,
    slug: string,
  ): Promise<{
    course: Course & { currentVersion: (CourseVersion & { sessions: { key: string }[] }) | null };
    enrollment: Enrollment;
  }> {
    const course = await this.prisma.course.findFirst({
      where: { slug, deletedAt: null },
      include: { currentVersion: { include: { sessions: { select: { key: true } } } } },
    });

    if (!course) {
      throw new NotFoundException(`No course "${slug}".`);
    }

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId: course.id } },
    });

    if (!enrollment || enrollment.unenrolledAt) {
      throw new AppException(
        'not_enrolled',
        'You are not enrolled in this course.',
        HttpStatus.FORBIDDEN,
      );
    }

    return { course, enrollment };
  }

  /**
   * Session keys are checked against the version the learner is on. A course
   * reporting a key nobody has heard of is a bug worth surfacing rather than a
   * row worth writing.
   */
  private assertKnownSession(
    course: { slug: string; currentVersion: { sessions: { key: string }[] } | null },
    sessionKey: string,
  ): void {
    const known = course.currentVersion?.sessions.some((s) => s.key === sessionKey);

    if (!known) {
      throw new AppException(
        'unknown_session',
        `"${sessionKey}" is not a session of this course.`,
        HttpStatus.NOT_FOUND,
      );
    }
  }

  /** The learner opened a session. Drives "continue where you left off". */
  async open(userId: string, slug: string, sessionKey: string): Promise<SessionProgressView> {
    const { course } = await this.enrolled(userId, slug);
    this.assertKnownSession(course, sessionKey);

    const now = new Date();

    const [, progress] = await this.prisma.$transaction([
      this.prisma.enrollment.update({
        where: { userId_courseId: { userId, courseId: course.id } },
        data: { lastSessionKey: sessionKey, lastOpenedAt: now },
      }),
      this.prisma.sessionProgress.upsert({
        where: { userId_courseId_sessionKey: { userId, courseId: course.id, sessionKey } },
        // Opening starts a session but never un-completes one: revisiting
        // something you finished must not undo finishing it.
        create: { userId, courseId: course.id, sessionKey, status: 'in_progress', startedAt: now },
        update: {},
      }),
    ]);

    await this.prisma.progressEvent.create({
      data: { userId, courseId: course.id, sessionKey, type: 'session.opened' },
    });

    return toSessionView(progress);
  }

  /** Optional fine-grained progress for the growth meter. */
  async setFraction(
    userId: string,
    slug: string,
    sessionKey: string,
    fraction: number,
  ): Promise<SessionProgressView> {
    const { course } = await this.enrolled(userId, slug);
    this.assertKnownSession(course, sessionKey);

    const existing = await this.prisma.sessionProgress.findUnique({
      where: { userId_courseId_sessionKey: { userId, courseId: course.id, sessionKey } },
    });

    // A fraction never downgrades a completed session, and never moves
    // backwards: progress bars that go down read as data loss.
    if (existing?.status === 'complete') {
      return toSessionView(existing);
    }

    const next = Math.max(fraction, existing?.fraction ? Number(existing.fraction) : 0);

    const progress = await this.prisma.sessionProgress.upsert({
      where: { userId_courseId_sessionKey: { userId, courseId: course.id, sessionKey } },
      create: {
        userId,
        courseId: course.id,
        sessionKey,
        status: 'in_progress',
        fraction: next,
        startedAt: new Date(),
      },
      update: { status: 'in_progress', fraction: next },
    });

    return toSessionView(progress);
  }

  /** The shell records completion; the course only suggests it. */
  async complete(userId: string, slug: string, sessionKey: string): Promise<SessionProgressView> {
    const { course } = await this.enrolled(userId, slug);
    this.assertKnownSession(course, sessionKey);

    const now = new Date();

    const progress = await this.prisma.sessionProgress.upsert({
      where: { userId_courseId_sessionKey: { userId, courseId: course.id, sessionKey } },
      create: {
        userId,
        courseId: course.id,
        sessionKey,
        status: 'complete',
        fraction: 1,
        startedAt: now,
        completedAt: now,
      },
      // Completing twice keeps the first timestamp: the second click is not a
      // new achievement.
      update: { status: 'complete', fraction: 1, completedAt: now },
    });

    await this.prisma.progressEvent.create({
      data: { userId, courseId: course.id, sessionKey, type: 'session.completed' },
    });

    await this.refreshCourseCompletion(userId, course);

    return toSessionView(progress);
  }

  /** Reopening a session the learner marked complete by mistake. */
  async uncomplete(userId: string, slug: string, sessionKey: string): Promise<SessionProgressView> {
    const { course } = await this.enrolled(userId, slug);
    this.assertKnownSession(course, sessionKey);

    const progress = await this.prisma.sessionProgress.upsert({
      where: { userId_courseId_sessionKey: { userId, courseId: course.id, sessionKey } },
      create: { userId, courseId: course.id, sessionKey, status: 'in_progress' },
      update: { status: 'in_progress', completedAt: null },
    });

    await this.refreshCourseCompletion(userId, course);

    return toSessionView(progress);
  }

  /**
   * A course is complete when every session of the learner's version is. Kept
   * in sync here rather than computed on read, so the dashboard and the
   * completion screen cannot disagree about when to celebrate.
   */
  private async refreshCourseCompletion(
    userId: string,
    course: Course & { currentVersion: { sessions: { key: string }[] } | null },
  ): Promise<void> {
    const total = course.currentVersion?.sessions.length ?? 0;
    if (total === 0) {
      return;
    }

    const done = await this.prisma.sessionProgress.count({
      where: { userId, courseId: course.id, status: 'complete' },
    });

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId: course.id } },
      select: { completedAt: true },
    });

    const finished = done >= total;

    if (finished && !enrollment?.completedAt) {
      await this.prisma.enrollment.update({
        where: { userId_courseId: { userId, courseId: course.id } },
        data: { completedAt: new Date() },
      });
      await this.prisma.progressEvent.create({
        data: { userId, courseId: course.id, type: 'course.completed' },
      });
    } else if (!finished && enrollment?.completedAt) {
      await this.prisma.enrollment.update({
        where: { userId_courseId: { userId, courseId: course.id } },
        data: { completedAt: null },
      });
    }
  }

  async sessionsFor(userId: string, slug: string): Promise<SessionProgressView[]> {
    const { course } = await this.enrolled(userId, slug);

    const rows = await this.prisma.sessionProgress.findMany({
      where: { userId, courseId: course.id },
      orderBy: { sessionKey: 'asc' },
    });

    return rows.map(toSessionView);
  }
}

function toSessionView(row: {
  sessionKey: string;
  status: string;
  fraction: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
}): SessionProgressView {
  return {
    sessionKey: row.sessionKey,
    status: row.status as SessionProgressView['status'],
    fraction: row.fraction === null ? null : Number(row.fraction),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}
