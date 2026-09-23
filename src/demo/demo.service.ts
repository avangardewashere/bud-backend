import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { User } from '@prisma/client';

import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { demoPlan } from './demo.sample.js';

/**
 * The public demo: one throwaway account that resets itself.
 *
 * Bud is invite-only, so a visitor with a link would otherwise meet a sign-in
 * form and leave. This hands them a learner who is already part-way through a
 * course — with a streak, notes and something handed in — and puts it back the
 * way it was for the next visitor.
 *
 * Off unless DEMO_MODE is set, so a self-hosted Bud never grows a public door
 * by accident.
 *
 * It is a *reset*, not a sandbox: whoever is using the demo when the next
 * visitor arrives after an idle gap loses what they were doing. That is the
 * trade this design accepts. Nothing the demo learner can do reaches another
 * account: everything written is owned by the demo user and deleted with it.
 */
@Injectable()
export class DemoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DemoService.name);

  /**
   * How many demo sign-ins may be live at once.
   *
   * One of the things an unauthenticated stranger can make this database grow
   * by — not the only one, which is what pruneEvents below is for. The free
   * tier's ceiling is 0.5 GB shared with everything else, so a loop over this
   * route would fill it and take the instance down, learner data and all.
   * Expired sessions are pruned, but a session lasts weeks, so that is no bound
   * at all. Keep the newest few and delete the rest: this is one shared account,
   * so more live sessions than this is not an audience.
   *
   * The cost is that the oldest visitor is signed out once this many newer ones
   * have arrived — the same trade the reset already makes, and gentler. A second
   * click or a refresh does not spend one, because the route hands back the
   * session the caller already has.
   */
  private static readonly MAX_SESSIONS = 20;

  /**
   * How much history the demo learner keeps.
   *
   * progress_events is append-only and nothing else prunes it. A visitor is a
   * fully signed-in learner, so anyone can open a session six hundred times a
   * minute and write a row each time — and because those same requests keep the
   * account looking busy, the reset that would have cleared them never runs.
   * That is ~200 MB a day against a 0.5 GB database.
   *
   * Far more than the sample progress writes and more than the heatmap reads,
   * so a real visit never notices.
   */
  private static readonly MAX_EVENTS = 500;

  /**
   * Often enough that a flood cannot get far between sweeps — a few thousand
   * rows at the per-user ceiling.
   *
   * It costs the free tier nothing, which is worth saying because a timer that
   * touches the database looks like it would: the host stops the container after
   * fifteen minutes without a request, so this only ticks while something is
   * already keeping both it and the database awake.
   */
  private static readonly PRUNE_INTERVAL_MS = 10 * 60 * 1000;

  /**
   * A claim should never wait on the one before it for longer than this, nor
   * hold a socket open for longer. It covers a Neon cold resume with room to
   * spare; past it, something is wrong and queueing behind it helps nobody.
   */
  private static readonly CLAIM_TIMEOUT_MS = 10_000;

  /**
   * How many visitors may be waiting their turn before the rest are turned away.
   * Small on purpose: the free instance has 512 MB, and a parked request holds a
   * socket and a promise. A fast 503 is a better answer than a slow one.
   */
  private static readonly MAX_WAITING = 8;

  private waiting = 0;
  private pruneTimer?: NodeJS.Timeout;

  /** Serialises claims; see claim(). */
  private queue: Promise<void> = Promise.resolve();

  /**
   * When this process last reset the demo. A reset makes the account fresh, so
   * it counts as activity — without it the next visitor arrives to an account
   * with no sessions at all, reads that as idle, and resets it again, signing
   * out the visitor who is mid-tour.
   *
   * In memory, and so per process and lost on restart, which is fine: being
   * wrong costs one unnecessary reset of a throwaway account.
   */
  private lastResetAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.get('DEMO_MODE');
  }

  /** The address the demo account answers to, for recognising its sessions. */
  get email(): string {
    return this.config.get('DEMO_EMAIL');
  }

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }

    this.pruneTimer = setInterval(() => {
      void this.pruneEvents().catch((error: unknown) =>
        // Housekeeping failing must never take the process with it.
        this.logger.warn({ err: error }, 'Demo event prune failed'),
      );
    }, DemoService.PRUNE_INTERVAL_MS);

    // Must not keep the process alive: a container that will not exit on
    // SIGTERM gets killed instead, and in tests it would hang the run.
    this.pruneTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.pruneTimer);
  }

  /**
   * Keeps the demo learner's history to a fixed size.
   *
   * On a timer rather than on the sign-in path, because the requests that write
   * these rows are not sign-ins: a visitor signs in once and can then write for
   * as long as they like, and claim() never runs again. Modelled on the session
   * prune in SessionService, for the same reason and with the same cautions.
   */
  async pruneEvents(): Promise<number> {
    const user = await this.existing();
    if (!user) {
      return 0;
    }

    const newest = await this.prisma.progressEvent.findMany({
      where: { userId: user.id },
      orderBy: { at: 'desc' },
      take: DemoService.MAX_EVENTS,
      select: { at: true },
    });

    if (newest.length < DemoService.MAX_EVENTS) {
      return 0;
    }

    // Cut by time rather than by a list of ids: the index is on (userId, at),
    // and events sharing the oldest kept timestamp are few and harmless.
    const cutoff = newest[newest.length - 1].at;
    const { count } = await this.prisma.progressEvent.deleteMany({
      where: { userId: user.id, at: { lt: cutoff } },
    });

    if (count > 0) {
      this.logger.log(`Pruned ${count} demo progress event${count === 1 ? '' : 's'}`);
    }

    return count;
  }

  /** The demo account as it stands: no creating, no resetting, no writes. */
  async existing(): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email: this.email } });
  }

  /**
   * The demo account, freshly reset when nobody has been using it. A visitor
   * mid-tour is not interrupted: a reset while they read would rewind the page
   * under them, which looks like a bug rather than a demo.
   *
   * One at a time. Two visitors arriving together would both find the demo idle
   * and both reset it, and the second transaction would lose a race for the
   * enrollment's unique key — a 500 on the very first thing a visitor touches.
   * Per process, like the login brake: this deploy runs one, and a second would
   * need the lock in the database.
   *
   * Taking turns needs a bound at both ends, or it is just a queue with no exit:
   * callers past MAX_WAITING are turned away rather than parked, and a turn is
   * handed on after CLAIM_TIMEOUT_MS however it ends.
   */
  async claim(): Promise<User> {
    if (this.waiting >= DemoService.MAX_WAITING) {
      throw new ServiceUnavailableException('The demo is busy. Try again in a moment.');
    }

    this.waiting += 1;
    try {
      const turn = this.queue;
      let done!: () => void;
      this.queue = new Promise<void>((resolve) => {
        done = resolve;
      });

      await turn;

      // Hand the turn on after the deadline whatever happens below. Without
      // this, one query that never settles — a dead connection to a database
      // that went to sleep, which has no timeout anywhere on this path — would
      // wedge the route for everyone, for as long as the process lived.
      const handover = setTimeout(done, DemoService.CLAIM_TIMEOUT_MS);
      handover.unref();

      try {
        return await this.claimOnce();
      } finally {
        clearTimeout(handover);
        done();
      }
    } finally {
      this.waiting -= 1;
    }
  }

  private async claimOnce(): Promise<User> {
    const user = await this.account();

    if (await this.isIdle(user.id)) {
      await this.reset(user.id);
    } else {
      await this.capSessions(user.id);
    }

    return user;
  }

  /**
   * Drops the oldest demo sign-ins so their rows cannot pile up. Runs on the
   * path that does *not* reset, because a reset deletes them all anyway.
   */
  private async capSessions(userId: string): Promise<void> {
    // One short of the cap: the caller is about to create the session that
    // fills it.
    const keeping = DemoService.MAX_SESSIONS - 1;
    const newest = await this.prisma.authSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: keeping,
      select: { id: true },
    });

    if (newest.length < keeping) {
      return;
    }

    const { count } = await this.prisma.authSession.deleteMany({
      where: { userId, id: { notIn: newest.map((session) => session.id) } },
    });

    if (count > 0) {
      this.logger.log(`Dropped ${count} old demo session${count === 1 ? '' : 's'}`);
    }
  }

  /** Creates the account on first use. No password: it cannot be signed into. */
  private async account(): Promise<User> {
    const email = this.config.get('DEMO_EMAIL');

    return this.prisma.user.upsert({
      where: { email },
      update: { isDemo: true, deletedAt: null },
      create: {
        email,
        name: this.config.get('DEMO_NAME'),
        // Password sign-in checks a hash; null means no password can match, so
        // the only way in is the demo route itself — and changing the password
        // fails for the same reason, which is what stops one visitor locking
        // the next one out.
        passwordHash: null,
        role: 'learner',
        isDemo: true,
      },
    });
  }

  /** Nobody has touched the demo for a while, so resetting disturbs no one. */
  private async isIdle(userId: string): Promise<boolean> {
    const idleMs = this.config.get('DEMO_RESET_IDLE_MINUTES') * 60_000;

    // A reset is itself the freshest possible activity, and it leaves no session
    // behind to say so.
    if (Date.now() - this.lastResetAt < idleMs) {
      return false;
    }

    const latest = await this.prisma.authSession.findFirst({
      where: { userId, revokedAt: null },
      orderBy: { lastUsedAt: 'desc' },
      select: { lastUsedAt: true },
    });

    if (!latest) {
      return true;
    }

    return Date.now() - latest.lastUsedAt.getTime() > idleMs;
  }

  /**
   * Back to the sample progress: everything the demo learner owns is deleted
   * and written again. Scoped to their own id throughout — a reset must never
   * be able to touch a real learner's work.
   */
  async reset(userId: string): Promise<void> {
    const course = await this.publishedCourse();

    await this.prisma.$transaction(async (tx) => {
      const owned = { where: { userId } };
      await tx.note.deleteMany(owned);
      await tx.deliverable.deleteMany(owned);
      await tx.courseState.deleteMany(owned);
      await tx.sessionProgress.deleteMany(owned);
      await tx.progressEvent.deleteMany(owned);
      await tx.enrollment.deleteMany(owned);
      // The previous visitor's session goes too, so the account is not shared
      // across a reset it cannot see.
      await tx.authSession.deleteMany(owned);

      if (!course?.currentVersion) {
        return;
      }

      const sessions = course.currentVersion.sessions;
      const plan = demoPlan(sessions.length);
      const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
      const keyOf = (index: number) => sessions[index]?.key;

      await tx.enrollment.create({
        data: {
          userId,
          courseId: course.id,
          courseVersionId: course.currentVersion.id,
          startedAt: at(plan.enrolledDaysAgo),
          lastOpenedAt: at(0),
          lastSessionKey: keyOf(plan.inProgress?.sessionIndex ?? plan.completed.at(-1) ?? 0),
        },
      });

      await tx.sessionProgress.createMany({
        data: [
          ...plan.completed.map((index, position) => ({
            userId,
            courseId: course.id,
            sessionKey: keyOf(index),
            status: 'complete' as const,
            startedAt: at(plan.enrolledDaysAgo - position),
            completedAt: at(plan.enrolledDaysAgo - position - 1),
          })),
          ...(plan.inProgress
            ? [
                {
                  userId,
                  courseId: course.id,
                  sessionKey: keyOf(plan.inProgress.sessionIndex),
                  status: 'in_progress' as const,
                  fraction: plan.inProgress.fraction,
                  startedAt: at(2),
                },
              ]
            : []),
        ],
      });

      await tx.note.createMany({
        data: plan.notes.map((note, position) => ({
          userId,
          courseId: course.id,
          sessionKey: keyOf(note.sessionIndex),
          bodyMd: note.bodyMd,
          createdAt: at(plan.enrolledDaysAgo - position),
          updatedAt: at(position + 1),
        })),
      });

      if (plan.deliverable) {
        await tx.deliverable.create({
          data: {
            userId,
            courseId: course.id,
            sessionKey: keyOf(plan.deliverable.sessionIndex),
            url: plan.deliverable.url,
            comment: plan.deliverable.comment,
            submittedAt: at(3),
          },
        });
      }

      await tx.progressEvent.createMany({
        data: plan.events.map((event) => ({
          userId,
          courseId: course.id,
          sessionKey: keyOf(event.sessionIndex),
          type: event.type,
          at: at(event.daysAgo),
        })),
      });
    });

    // After the transaction, not before: a reset that failed should be retried
    // by the next visitor rather than suppressed for the idle window.
    this.lastResetAt = Date.now();
    this.logger.log('Demo account reset to its sample progress');
  }

  /**
   * The course the demo shows: the fullest one that is published.
   *
   * It used to be the first by name, which quietly handed the demo to whatever
   * happened to sort early — a one-session fixture, a course beginning with "a".
   * A demo is a showcase, so the course with the most to show wins, and the name
   * only breaks ties.
   */
  private async publishedCourse() {
    const published = await this.prisma.course.findMany({
      where: { status: 'published', deletedAt: null, currentVersionId: { not: null } },
      orderBy: { slug: 'asc' },
      include: { currentVersion: { include: { sessions: { orderBy: { order: 'asc' } } } } },
    });

    // Counted in memory: sessions hang off the version, not the course, so there
    // is no relation to order by — and a deployment has a handful of courses.
    return published.reduce<(typeof published)[number] | null>((best, course) => {
      const sessions = course.currentVersion?.sessions.length ?? 0;
      const bestSessions = best?.currentVersion?.sessions.length ?? -1;
      return sessions > bestSessions ? course : best;
    }, null);
  }
}
