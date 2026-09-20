import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/index.js';
import { PrismaService } from '../prisma/index.js';

export interface ContinueCard {
  slug: string;
  title: string;
  accentColor: string | null;
  /** The session to resume, or the first one when they have not opened any. */
  sessionKey: string;
  sessionTitle: string;
  sessionOrder: number;
  weight: string | null;
  percent: number;
  /** False when this is a fresh start rather than a resume. */
  resuming: boolean;
}

export interface DashboardCourse {
  slug: string;
  title: string;
  accentColor: string | null;
  coverUrl: string | null;
  completedSessions: number;
  totalSessions: number;
  percent: number;
  lastOpenedAt: string | null;
  completedAt: string | null;
}

export interface Dashboard {
  /** Null on a first visit, which is mockup 1j's empty state rather than an error. */
  continueCard: ContinueCard | null;
  courses: DashboardCourse[];
  totals: {
    enrolledCourses: number;
    completedCourses: number;
    completedSessions: number;
    totalSessions: number;
  };
}

/**
 * The learner's own view of everything they are doing.
 *
 * Deliberately one round trip: the dashboard is the first screen after sign-in,
 * and assembling it from three endpoints would make the slowest one decide how
 * the app feels.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async forUser(userId: string): Promise<Dashboard> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { userId, unenrolledAt: null, course: { deletedAt: null } },
      include: {
        course: {
          include: { currentVersion: { include: { sessions: { orderBy: { order: 'asc' } } } } },
        },
      },
      // Most recently touched first: the dashboard is about what you are doing
      // now, not what you enrolled in first.
      orderBy: [{ lastOpenedAt: 'desc' }, { startedAt: 'desc' }],
    });

    const completedByCourse = new Map(
      (
        await this.prisma.sessionProgress.groupBy({
          by: ['courseId'],
          where: { userId, status: 'complete' },
          _count: { _all: true },
        })
      ).map((row) => [row.courseId, row._count._all]),
    );

    const courses: DashboardCourse[] = enrollments.map((enrollment) => {
      const total = enrollment.course.currentVersion?.sessions.length ?? 0;
      const done = completedByCourse.get(enrollment.courseId) ?? 0;

      return {
        slug: enrollment.course.slug,
        title: enrollment.course.title,
        accentColor: enrollment.course.accentColor,
        coverUrl: enrollment.course.coverKey
          ? `${this.config.get('COURSES_ORIGIN')}/${enrollment.course.coverKey}`
          : null,
        completedSessions: done,
        totalSessions: total,
        percent: total === 0 ? 0 : Math.round((done / total) * 100),
        lastOpenedAt: enrollment.lastOpenedAt?.toISOString() ?? null,
        completedAt: enrollment.completedAt?.toISOString() ?? null,
      };
    });

    return {
      continueCard: this.buildContinueCard(enrollments, completedByCourse),
      courses,
      totals: {
        enrolledCourses: courses.length,
        completedCourses: courses.filter((c) => c.completedAt !== null).length,
        completedSessions: courses.reduce((sum, c) => sum + c.completedSessions, 0),
        totalSessions: courses.reduce((sum, c) => sum + c.totalSessions, 0),
      },
    };
  }

  /**
   * "Continue where you left off". Picks the most recently opened unfinished
   * course; failing that, the most recent enrolment that still has work left.
   */
  private buildContinueCard(
    enrollments: {
      courseId: string;
      lastSessionKey: string | null;
      completedAt: Date | null;
      course: {
        slug: string;
        title: string;
        accentColor: string | null;
        currentVersion: {
          sessions: { key: string; title: string; order: number; weight: string | null }[];
        } | null;
      };
    }[],
    completedByCourse: Map<string, number>,
  ): ContinueCard | null {
    const candidate = enrollments.find(
      (e) => e.completedAt === null && (e.course.currentVersion?.sessions.length ?? 0) > 0,
    );

    if (!candidate?.course.currentVersion) {
      return null;
    }

    const sessions = candidate.course.currentVersion.sessions;
    const resuming = candidate.lastSessionKey !== null;
    const session = sessions.find((s) => s.key === candidate.lastSessionKey) ?? sessions[0];

    const done = completedByCourse.get(candidate.courseId) ?? 0;

    return {
      slug: candidate.course.slug,
      title: candidate.course.title,
      accentColor: candidate.course.accentColor,
      sessionKey: session.key,
      sessionTitle: session.title,
      sessionOrder: session.order,
      weight: session.weight,
      percent: sessions.length === 0 ? 0 : Math.round((done / sessions.length) * 100),
      resuming,
    };
  }
}
