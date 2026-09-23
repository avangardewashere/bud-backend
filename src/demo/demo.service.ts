import { Injectable, Logger } from '@nestjs/common';
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
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.get('DEMO_MODE');
  }

  /**
   * The demo account, freshly reset when nobody has been using it. A visitor
   * mid-tour is not interrupted: a reset while they read would rewind the page
   * under them, which looks like a bug rather than a demo.
   */
  async claim(): Promise<User> {
    const user = await this.account();

    if (await this.isIdle(user.id)) {
      await this.reset(user.id);
    }

    return user;
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
    const latest = await this.prisma.authSession.findFirst({
      where: { userId, revokedAt: null },
      orderBy: { lastUsedAt: 'desc' },
      select: { lastUsedAt: true },
    });

    if (!latest) {
      return true;
    }

    const idleMs = this.config.get('DEMO_RESET_IDLE_MINUTES') * 60_000;
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

    this.logger.log('Demo account reset to its sample progress');
  }

  /** The course the demo shows: whatever is published, the first one by name. */
  private async publishedCourse() {
    return this.prisma.course.findFirst({
      where: { status: 'published', deletedAt: null, currentVersionId: { not: null } },
      orderBy: { slug: 'asc' },
      include: { currentVersion: { include: { sessions: { orderBy: { order: 'asc' } } } } },
    });
  }
}
