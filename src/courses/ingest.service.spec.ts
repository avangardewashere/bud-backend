import { Buffer } from 'node:buffer';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';

import { isCoursePath } from '../course-serving/courses-server.js';
import type { CourseSpecService } from '../course-spec/course-spec.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { courseCoverUrl } from '../storage/course-keys.js';
import type { StorageService } from '../storage/storage.service.js';
import { IngestService } from './ingest.service.js';

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, body] of Object.entries(files)) {
    zip.addBuffer(Buffer.from(body), name);
  }
  zip.end();

  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Everything around the cleanup is faked: validation passes, the version is
 * new, and the failure is injected where a real one would happen — storing a
 * file, or writing the rows.
 */
function harness(fail: { put?: Error; rows?: Error }) {
  const deleted: string[] = [];

  const courseSpec = {
    validate: () =>
      Promise.resolve({
        report: { ok: true, results: [] },
        manifest: { id: 'docker', version: '1.0.0' },
      }),
  } as unknown as CourseSpecService;

  const prisma = {
    course: { findUnique: () => Promise.resolve(null) },
    $transaction: () => Promise.reject(fail.rows ?? new Error('unexpected: rows written')),
  } as unknown as PrismaService;

  const storage = {
    ensureBucket: () => Promise.resolve(),
    put: () => (fail.put ? Promise.reject(fail.put) : Promise.resolve()),
    deletePrefix: (prefix: string) => {
      deleted.push(prefix);
      return Promise.resolve(0);
    },
  } as unknown as StorageService;

  return { service: new IngestService(prisma, courseSpec, storage), deleted };
}

describe('IngestService cleanup after a failed ingest', () => {
  it('deletes only this version, with the trailing slash that keeps 1.0.0-rc.1 out of it', async () => {
    // Without the slash, 'courses/docker/1.0.0' is also a prefix of every key
    // under courses/docker/1.0.0-rc.1/ — another version, perhaps the live one.
    const { service, deleted } = harness({ rows: new Error('connection reset') });

    await expect(service.ingest(await zipOf({ 'a.html': 'a' }), 'admin')).rejects.toThrow(
      'connection reset',
    );
    expect(deleted).toEqual(['courses/docker/1.0.0/']);
  });

  it('cleans up the same way when storing a file fails part way', async () => {
    const { service, deleted } = harness({ put: new Error('storage down') });

    await expect(service.ingest(await zipOf({ 'a.html': 'a' }), 'admin')).rejects.toThrow(
      'storage down',
    );
    expect(deleted).toEqual(['courses/docker/1.0.0/']);
  });

  it('leaves the files alone when it lost a race to an identical upload', async () => {
    // Two submits of the same version both pass the "is it new" check and
    // write identical keys; the loser fails on the unique row. Its files are
    // the winner's files, so cleaning up would break the version that won.
    const raced = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const { service, deleted } = harness({ rows: raced });

    await expect(service.ingest(await zipOf({ 'a.html': 'a' }), 'admin')).rejects.toBe(raced);
    expect(deleted).toEqual([]);
  });
});

/**
 * What an ingest has to leave behind for a cover to resolve: the version's own
 * prefix and its manifest. The cover used to be a column on the course, written
 * from whatever was uploaded last — which pointed the catalog at a version the
 * content origin refuses to serve as soon as anyone uploaded a draft.
 */
describe('what an ingest leaves for the cover to be built from', () => {
  function successHarness(cover: string | null) {
    const written: { storagePrefix?: string; manifest?: unknown } = {};

    const courseSpec = {
      validate: () =>
        Promise.resolve({
          report: { ok: true, results: [] },
          manifest: {
            id: 'docker-fundamentals',
            version: '1.0.0',
            title: 'Docker',
            summary: 'Containers',
            level: 'beginner',
            tags: ['docker'],
            cover,
            sessions: [{ id: 's1', order: 1, title: 'One', entry: 'one.html' }],
          },
        }),
    } as unknown as CourseSpecService;

    const tx = {
      course: { upsert: () => Promise.resolve({ id: 'course-1' }) },
      courseVersion: {
        create: (args: { data: { storagePrefix: string; manifest: unknown } }) => {
          written.storagePrefix = args.data.storagePrefix;
          written.manifest = args.data.manifest;
          return Promise.resolve({ id: 'version-1' });
        },
      },
      courseSession: { createMany: () => Promise.resolve({ count: 1 }) },
    };

    const prisma = {
      course: { findUnique: () => Promise.resolve(null) },
      $transaction: (run: (t: typeof tx) => Promise<unknown>) => run(tx),
    } as unknown as PrismaService;

    const storage = {
      ensureBucket: () => Promise.resolve(),
      put: () => Promise.resolve(),
    } as unknown as StorageService;

    return { service: new IngestService(prisma, courseSpec, storage), written };
  }

  it('gives the catalog a cover URL the courses origin will serve', async () => {
    const { service, written } = successHarness('assets/cover.png');

    await service.ingest(await zipOf({ 'one.html': '<p>one</p>' }), 'admin');

    expect(written.storagePrefix).toBe('courses/docker-fundamentals/1.0.0');

    // The end the bug was at: what a browser is told to fetch.
    const url = courseCoverUrl('https://courses.example', {
      storagePrefix: written.storagePrefix!,
      manifest: written.manifest,
    });
    expect(url).toBe('https://courses.example/docker-fundamentals/1.0.0/assets/cover.png');
    expect(isCoursePath(new URL(url!).pathname)).toBe(true);
  });

  it('has no cover URL for a course without one', async () => {
    const { service, written } = successHarness(null);

    await service.ingest(await zipOf({ 'one.html': '<p>one</p>' }), 'admin');

    expect(
      courseCoverUrl('https://courses.example', {
        storagePrefix: written.storagePrefix!,
        manifest: written.manifest,
      }),
    ).toBeNull();
  });
});
