import { describe, expect, it, vi } from 'vitest';

import type { AppConfigService } from '../config/app-config.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { DemoService } from './demo.service.js';

/**
 * What the demo route costs a stranger, and what it costs us.
 *
 * It is the only unauthenticated route that writes, so both of these matter
 * more than they would anywhere else: a reset must not fire twice over the top
 * of a visitor who is using it, and a sign-in must not be able to add rows
 * forever. The sample progress those resets write is covered by
 * demo.sample.spec.ts and the e2e suite; here the published course is absent, so
 * a reset is just the deletes and the counting is honest.
 */

function makeService() {
  const tx = {
    note: { deleteMany: vi.fn(), createMany: vi.fn() },
    deliverable: { deleteMany: vi.fn(), create: vi.fn() },
    courseState: { deleteMany: vi.fn() },
    sessionProgress: { deleteMany: vi.fn(), createMany: vi.fn() },
    progressEvent: { deleteMany: vi.fn(), createMany: vi.fn() },
    enrollment: { deleteMany: vi.fn(), create: vi.fn() },
    authSession: { deleteMany: vi.fn() },
  };

  const prisma = {
    user: {
      upsert: vi.fn().mockResolvedValue({ id: 'demo-user', email: 'demo@bud.local' }),
      findUnique: vi.fn().mockResolvedValue({ id: 'demo-user', email: 'demo@bud.local' }),
    },
    // No published course: reset does its deletes and stops.
    course: { findMany: vi.fn().mockResolvedValue([]) },
    authSession: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    progressEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn((run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };

  const settings: Record<string, unknown> = {
    DEMO_MODE: true,
    DEMO_EMAIL: 'demo@bud.local',
    DEMO_NAME: 'Demo Learner',
    DEMO_RESET_IDLE_MINUTES: 15,
  };

  const service = new DemoService(
    prisma as unknown as PrismaService,
    { get: (name: string) => settings[name] } as unknown as AppConfigService,
  );

  return { service, prisma, tx };
}

/** As many sessions as were asked for: the cap, reached. */
function fullPage(take: number) {
  return Array.from({ length: take }, (_, index) => ({ id: `session-${index}` }));
}

describe('DemoService.claim', () => {
  it('resets once when two visitors arrive at the same moment', async () => {
    // Both would have found an idle demo and both reset it, and the second
    // transaction would have lost a race for the enrollment's unique key.
    const { service, prisma } = makeService();

    await Promise.all([service.claim(), service.claim()]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does not reset again straight after resetting', async () => {
    // A reset leaves no session behind, so "no sessions" would otherwise read as
    // idle for ever and rewind the page under whoever is reading it.
    const { service, prisma } = makeService();

    await service.claim();
    await service.claim();
    await service.claim();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('leaves a demo somebody is using alone', async () => {
    const { service, prisma } = makeService();
    prisma.authSession.findFirst.mockResolvedValue({ lastUsedAt: new Date() });

    await service.claim();

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('resets one that has been idle past the window', async () => {
    const { service, prisma } = makeService();
    prisma.authSession.findFirst.mockResolvedValue({
      lastUsedAt: new Date(Date.now() - 16 * 60_000),
    });

    await service.claim();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('drops the oldest sign-ins once the cap is full', async () => {
    const { service, prisma } = makeService();
    prisma.authSession.findFirst.mockResolvedValue({ lastUsedAt: new Date() });
    prisma.authSession.findMany.mockImplementation(({ take }: { take: number }) =>
      Promise.resolve(fullPage(take)),
    );
    prisma.authSession.deleteMany.mockResolvedValue({ count: 4 });

    await service.claim();

    const [query] = prisma.authSession.findMany.mock.calls[0] as [{ take: number }];
    expect(query.take).toBeGreaterThan(0);
    expect(prisma.authSession.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'demo-user',
        id: { notIn: fullPage(query.take).map((session) => session.id) },
      },
    });
  });

  it('keeps every sign-in while there is room', async () => {
    const { service, prisma } = makeService();
    prisma.authSession.findFirst.mockResolvedValue({ lastUsedAt: new Date() });
    prisma.authSession.findMany.mockImplementation(({ take }: { take: number }) =>
      Promise.resolve(fullPage(take - 1)),
    );

    await service.claim();

    expect(prisma.authSession.deleteMany).not.toHaveBeenCalled();
  });

  it('does not wedge the queue when a claim fails', async () => {
    const { service, prisma } = makeService();
    prisma.user.upsert
      .mockRejectedValueOnce(new Error('database asleep'))
      .mockResolvedValue({ id: 'demo-user', email: 'demo@bud.local' });

    const first = service.claim();
    const second = service.claim();

    await expect(first).rejects.toThrowError('database asleep');
    await expect(second).resolves.toMatchObject({ id: 'demo-user' });
  });
});

/**
 * A demo visitor is a signed-in learner, so they can write progress events for
 * as long as they like — and those same requests keep the account looking busy,
 * so the reset that would have cleared them never runs. Nothing else in the
 * schema prunes that table.
 */
describe('DemoService.pruneEvents', () => {
  it('keeps the newest history and drops what is behind it', async () => {
    const { service, prisma } = makeService();
    const cutoff = new Date('2026-09-01T00:00:00Z');
    prisma.progressEvent.findMany.mockImplementation(({ take }: { take: number }) =>
      Promise.resolve(
        Array.from({ length: take }, (_, index) => ({
          at: index === take - 1 ? cutoff : new Date('2026-09-20T00:00:00Z'),
        })),
      ),
    );
    prisma.progressEvent.deleteMany.mockResolvedValue({ count: 120 });

    const pruned = await service.pruneEvents();

    expect(pruned).toBe(120);
    expect(prisma.progressEvent.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'demo-user', at: { lt: cutoff } },
    });
  });

  it('does nothing while the history is small', async () => {
    const { service, prisma } = makeService();
    prisma.progressEvent.findMany.mockImplementation(({ take }: { take: number }) =>
      Promise.resolve(Array.from({ length: take - 1 }, () => ({ at: new Date() }))),
    );

    expect(await service.pruneEvents()).toBe(0);
    expect(prisma.progressEvent.deleteMany).not.toHaveBeenCalled();
  });

  it('does nothing before anyone has used the demo', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);

    expect(await service.pruneEvents()).toBe(0);
    expect(prisma.progressEvent.findMany).not.toHaveBeenCalled();
  });
});

/**
 * Taking turns is only safe if the queue has an exit. Without one, a single
 * query that never settles — a connection to a database that went to sleep, and
 * there is no timeout anywhere on this path — wedges the route for good, and
 * arrivals faster than the database can be read pile up on a 512 MB instance.
 */
describe('DemoService.claim under load', () => {
  it('turns visitors away rather than parking them all', async () => {
    const { service, prisma } = makeService();
    // A claim that never finishes, so everything queues behind the first.
    prisma.user.upsert.mockImplementation(() => new Promise(() => {}));

    const parked = Array.from({ length: 9 }, () => service.claim().catch((e: Error) => e));
    const outcomes = await Promise.all(parked.slice(8));

    expect((outcomes[0] as Error).message).toMatch(/busy/i);
  });

  it('hands the turn on when a claim hangs, instead of wedging the route', async () => {
    vi.useFakeTimers();
    try {
      const { service, prisma } = makeService();
      prisma.user.upsert.mockImplementationOnce(() => new Promise(() => {}));

      const stuck = service.claim();
      // Let the stuck claim take its turn before the next one asks for it.
      await vi.advanceTimersByTimeAsync(0);
      const next = service.claim();

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(next).resolves.toMatchObject({ id: 'demo-user' });
      void stuck.catch(() => undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Which course a visitor is dropped into. It was the first published course by
 * name, which means a fixture or a course beginning with "a" silently becomes
 * the thing the portfolio shows.
 */
describe('the course the demo shows', () => {
  const course = (slug: string, sessions: number) => ({
    id: `course-${slug}`,
    slug,
    currentVersion: {
      id: `version-${slug}`,
      sessions: Array.from({ length: sessions }, (_, index) => ({ key: `s${index + 1}` })),
    },
  });

  it('is the fullest one, not the first alphabetically', async () => {
    const harness = makeService();
    harness.prisma.course.findMany.mockResolvedValue([
      course('cover-check', 1),
      course('docker-fundamentals', 10),
    ]);

    const { tx } = harness;
    await harness.service.reset('demo-user');

    expect(tx.enrollment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ courseId: 'course-docker-fundamentals' }),
      }),
    );
  });
});
