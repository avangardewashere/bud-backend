import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service.js';
import type { StorageService } from '../storage/storage.service.js';
import { HealthController } from './health.controller.js';

/** Fails the test the moment anything reaches for a dependency. */
function untouchable<T>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`/health touched ${name}.${String(property)}`);
      },
    },
  ) as T;
}

describe('HealthController', () => {
  it('answers /health without touching the database or storage', () => {
    // Render probes /health continuously, and the shell calls it to wake a
    // sleeping instance. A database query here would keep Neon awake and burn
    // its free compute hours — so any access at all fails this test.
    const controller = new HealthController(
      untouchable<PrismaService>('prisma'),
      untouchable<StorageService>('storage'),
    );

    expect(controller.health()).toMatchObject({ status: 'ok' });
  });

  it('checks both dependencies on /ready, which is what it is for', async () => {
    const touched: string[] = [];
    const controller = new HealthController(
      { ping: () => (touched.push('database'), Promise.resolve()) } as unknown as PrismaService,
      { ping: () => (touched.push('storage'), Promise.resolve()) } as unknown as StorageService,
    );

    expect(await controller.ready()).toMatchObject({ status: 'ok' });
    expect(touched.sort()).toEqual(['database', 'storage']);
  });
});
