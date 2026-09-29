import { HttpStatus } from '@nestjs/common';
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

  it('reports degraded storage in the body while staying a 200', async () => {
    // Deliberate, and load-bearing in two directions. A failing object store
    // must not take the instance out of rotation — sign-in, the catalog,
    // progress and the bridge all still work without it — so this resolves
    // rather than throws. But it means the status code cannot be read as "all
    // well", which is what scripts/verify-deploy.mjs used to do: it printed a
    // pass for a deployment that could not serve a single course file. Nothing
    // pinned either half until now.
    const controller = new HealthController(
      { ping: () => Promise.resolve() } as unknown as PrismaService,
      { ping: () => Promise.reject(new Error('bucket unreachable')) } as unknown as StorageService,
    );

    await expect(controller.ready()).resolves.toEqual({
      status: 'degraded',
      checks: { database: 'ok', storage: 'error' },
    });
  });

  it('refuses readiness when the database is gone', async () => {
    // The other direction: a dead database is not degraded service, it is no
    // service, so this one does leave rotation.
    const controller = new HealthController(
      { ping: () => Promise.reject(new Error('no connection')) } as unknown as PrismaService,
      { ping: () => Promise.resolve() } as unknown as StorageService,
    );

    await expect(controller.ready()).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      response: { status: 'error', checks: { database: 'error', storage: 'ok' } },
    });
  });
});
