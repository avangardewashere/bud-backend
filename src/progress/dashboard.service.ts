import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

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

/** The slice of a course the dashboard queries load. */
interface EnrolledCourse {
  slug: string;
  title: string;
  accentColor: string | null;
  currentVersion: {
    sessions: {
      key: string;
      title: string;
      order: number;
      weight: string | null;
      deliverable: string | null;
    }[];
  } | null;
}

export interface RecentNote {
  slug: string;
  courseTitle: string;
  sessionKey: string;
  sessionTitle: string | null;
  /** First line or so, for a dashboard card — not the whole note. */
  excerpt: string;
  updatedAt: string;
}

export interface UpcomingDeliverable {
  slug: string;
  courseTitle: string;
  sessionKey: string;
  sessionTitle: string;
  /** What the manifest asks for. */
  asked: string;
  /** True once the learner has finished the session it belongs to. */
  sessionComplete: boolean;
}

export interface Dashboard {
  /** Null on a first visit, which is mockup 1j's empty state rather than an error. */
  continueCard: ContinueCard | null;
  courses: DashboardCourse[];
  /** Most recently edited first. Phase 2 §5.5. */
  recentNotes: RecentNote[];
  /**
   * Sessions that ask for a deliverable the learner has not submitted yet.
   * Ordered so the ones they have already finished come first: those are the
   * ones with nothing left to do but hand in.
   */
  upcomingDeliverables: UpcomingDeliverable[];
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

    // Which sessions are complete, not merely how many: the continue card has
    // to skip past the finished ones, and a count cannot tell it which those are.
    const completedRows = await this.prisma.sessionProgress.findMany({
      where: { userId, status: 'complete' },
      select: { courseId: true, sessionKey: true },
    });

    const completedByCourse = new Map<string, Set<string>>();
    for (const row of completedRows) {
      const keys = completedByCourse.get(row.courseId) ?? new Set<string>();
      keys.add(row.sessionKey);
      completedByCourse.set(row.courseId, keys);
    }

    const courses: DashboardCourse[] = enrollments.map((enrollment) => {
      const total = enrollment.course.currentVersion?.sessions.length ?? 0;
      const done = completedByCourse.get(enrollment.courseId)?.size ?? 0;

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
      recentNotes: await this.recentNotes(userId, enrollments),
      upcomingDeliverables: await this.upcomingDeliverables(userId, enrollments, completedByCourse),
      totals: {
        enrolledCourses: courses.length,
        completedCourses: courses.filter((c) => c.completedAt !== null).length,
        completedSessions: courses.reduce((sum, c) => sum + c.completedSessions, 0),
        totalSessions: courses.reduce((sum, c) => sum + c.totalSessions, 0),
      },
    };
  }

  /**
   * The notes touched most recently, across every enrolled course.
   *
   * Excerpted rather than returned whole: this feeds a dashboard card, and
   * shipping a 200 KB note to render three lines of it would make the first
   * screen after sign-in as slow as the longest thing anyone has written.
   */
  private async recentNotes(
    userId: string,
    enrollments: { courseId: string; course: EnrolledCourse }[],
  ): Promise<RecentNote[]> {
    if (enrollments.length === 0) {
      return [];
    }

    const byCourseId = new Map(enrollments.map((e) => [e.courseId, e.course]));

    const notes = await this.prisma.note.findMany({
      where: { userId, courseId: { in: [...byCourseId.keys()] } },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    });

    return notes.flatMap((note) => {
      const course = byCourseId.get(note.courseId);
      if (!course) {
        return [];
      }

      const session = course.currentVersion?.sessions.find((s) => s.key === note.sessionKey);

      return [
        {
          slug: course.slug,
          courseTitle: course.title,
          sessionKey: note.sessionKey,
          sessionTitle: session?.title ?? null,
          excerpt: excerpt(note.bodyMd),
          updatedAt: note.updatedAt.toISOString(),
        },
      ];
    });
  }

  /**
   * Sessions whose manifest asks for a deliverable the learner has not handed
   * in. Finished sessions come first: those are the ones where the work is
   * done and only the handing in is outstanding, which is the nudge worth
   * showing.
   */
  private async upcomingDeliverables(
    userId: string,
    enrollments: { courseId: string; course: EnrolledCourse }[],
    completedByCourse: Map<string, Set<string>>,
  ): Promise<UpcomingDeliverable[]> {
    if (enrollments.length === 0) {
      return [];
    }

    const submitted = new Set(
      (
        await this.prisma.deliverable.findMany({
          where: { userId, submittedAt: { not: null } },
          select: { courseId: true, sessionKey: true },
        })
      ).map((d) => `${d.courseId}:${d.sessionKey}`),
    );

    const rows: UpcomingDeliverable[] = [];

    for (const { courseId, course } of enrollments) {
      const complete = completedByCourse.get(courseId) ?? new Set<string>();

      for (const session of course.currentVersion?.sessions ?? []) {
        // Only sessions that actually ask for something.
        if (!session.deliverable || submitted.has(`${courseId}:${session.key}`)) {
          continue;
        }

        rows.push({
          slug: course.slug,
          courseTitle: course.title,
          sessionKey: session.key,
          sessionTitle: session.title,
          asked: session.deliverable,
          sessionComplete: complete.has(session.key),
        });
      }
    }

    return rows.sort((a, b) => Number(b.sessionComplete) - Number(a.sessionComplete)).slice(0, 10);
  }

  /**
   * "Continue where you left off" — which means the next thing to *do*, not the
   * last thing finished.
   *
   * The last session opened is the obvious candidate and the wrong one: finish
   * session 1 and it would keep offering session 1, sending the learner back
   * into something they have already ticked off. Mockup 1b shows "Session 4"
   * against 3 of 10 complete, and 1c labels the same panel "UP NEXT". So:
   * resume the last opened session if it is unfinished, otherwise the first
   * session that is not complete.
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
    completedByCourse: Map<string, Set<string>>,
  ): ContinueCard | null {
    const candidate = enrollments.find(
      (e) => e.completedAt === null && (e.course.currentVersion?.sessions.length ?? 0) > 0,
    );

    if (!candidate?.course.currentVersion) {
      return null;
    }

    const sessions = candidate.course.currentVersion.sessions;
    const complete = completedByCourse.get(candidate.courseId) ?? new Set<string>();

    const lastOpened = sessions.find((s) => s.key === candidate.lastSessionKey);
    const resumable = lastOpened && !complete.has(lastOpened.key) ? lastOpened : undefined;

    // Falls back to the first unfinished session; and if somehow every session
    // is complete while the course is not, the last one rather than nothing.
    const session =
      resumable ?? sessions.find((s) => !complete.has(s.key)) ?? sessions[sessions.length - 1];

    // "Resuming" means picking up something already started, which is only true
    // when the card points at the session they were last in.
    const resuming = resumable !== undefined;
    const done = complete.size;

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

/**
 * A few lines of a note, for a card. Takes whole lines rather than cutting at a
 * character count, so an excerpt never ends mid-word or mid-syntax.
 */
function excerpt(bodyMd: string, maxChars = 200): string {
  const text = bodyMd.trim();

  if (text.length <= maxChars) {
    return text;
  }

  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));

  return `${cut.slice(0, lastBreak > 0 ? lastBreak : maxChars).trimEnd()}…`;
}
