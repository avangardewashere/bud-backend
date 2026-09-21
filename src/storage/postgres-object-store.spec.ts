import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service.js';
import { ObjectNotFoundError } from './object-store.js';
import { PostgresObjectStore } from './postgres-object-store.js';

interface Row {
  key: string;
  contentType: string;
  body: Uint8Array;
}

/**
 * A stand-in for `prisma.storedObject`, with one deliberate property: prefix
 * matching behaves like the SQL it becomes. `startsWith` compiles to LIKE,
 * where `_` matches any character — so this fake over-matches the same way a
 * real database would, and the store's own filtering has to cope with it.
 */
function fakePrisma(rows: Map<string, Row>) {
  const like = (prefix: string) =>
    new RegExp(
      `^${prefix
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/_/g, '.')
        .replace(/%/g, '.*')}`,
    );

  const storedObject = {
    upsert: ({
      where,
      create,
      update,
    }: {
      where: { key: string };
      create: Row;
      update: Partial<Row>;
    }) => {
      const existing = rows.get(where.key);
      rows.set(where.key, existing ? { ...existing, ...update } : create);
      return Promise.resolve();
    },
    findUnique: ({ where }: { where: { key: string } }) => {
      const row = rows.get(where.key);
      return Promise.resolve(row ? { body: row.body } : null);
    },
    findMany: ({ where }: { where: { key: { startsWith: string } } }) =>
      Promise.resolve(
        [...rows.values()]
          .filter((row) => like(where.key.startsWith).test(row.key))
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((row) => ({ key: row.key })),
      ),
    deleteMany: ({ where }: { where: { key: { in: string[] } } }) => {
      let count = 0;
      for (const key of where.key.in) {
        if (rows.delete(key)) count += 1;
      }
      return Promise.resolve({ count });
    },
  };

  return { storedObject } as unknown as PrismaService;
}

describe('PostgresObjectStore', () => {
  let rows: Map<string, Row>;
  let store: PostgresObjectStore;

  beforeEach(() => {
    rows = new Map();
    store = new PostgresObjectStore(fakePrisma(rows));
  });

  it('reads back exactly the bytes it was given', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await store.put('courses/c/1.0.0/cover.png', png, 'image/png');

    expect(Buffer.from(await store.getBytes('courses/c/1.0.0/cover.png'))).toEqual(png);
  });

  it('decodes text as UTF-8', async () => {
    await store.put(
      'courses/c/1.0.0/outline.md',
      Buffer.from('# Café — naïve ✓', 'utf-8'),
      'text/markdown',
    );

    expect(await store.getText('courses/c/1.0.0/outline.md')).toBe('# Café — naïve ✓');
  });

  it('overwrites on a second put, as PutObject does', async () => {
    await store.put('k', Buffer.from('one'), 'text/plain');
    await store.put('k', Buffer.from('two'), 'text/plain');

    expect(await store.getText('k')).toBe('two');
    expect(rows.size).toBe(1);
  });

  it('rejects a missing key with an error that names it', async () => {
    await expect(store.getBytes('courses/c/9.9.9/nope.html')).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    await expect(store.getText('courses/c/9.9.9/nope.html')).rejects.toThrow(/nope\.html/);
  });

  it('lists only keys under the prefix, even where LIKE would over-match', async () => {
    await store.put('courses/a_b/1.0.0/index.html', Buffer.from('mine'), 'text/html');
    // `_` in the prefix matches the `x` here in SQL — but this is not under it.
    await store.put('courses/axb/1.0.0/index.html', Buffer.from('not mine'), 'text/html');

    expect(await store.list('courses/a_b/')).toEqual(['courses/a_b/1.0.0/index.html']);
  });

  it('deletes by the exact keys it listed, never by pattern', async () => {
    await store.put('courses/a_b/1.0.0/index.html', Buffer.from('mine'), 'text/html');
    await store.put('courses/a_b/1.0.0/page.html', Buffer.from('mine'), 'text/html');
    await store.put('courses/axb/1.0.0/index.html', Buffer.from('not mine'), 'text/html');

    expect(await store.deletePrefix('courses/a_b/')).toBe(2);
    // The file LIKE would have matched is still there.
    expect(await store.getText('courses/axb/1.0.0/index.html')).toBe('not mine');
  });

  it('deletes nothing, and says so, when nothing matches', async () => {
    expect(await store.deletePrefix('courses/none/')).toBe(0);
  });

  it('needs no provisioning and no separate probe', async () => {
    await expect(store.ensureReady()).resolves.toBeUndefined();
    await expect(store.ping()).resolves.toBeUndefined();
  });
});
