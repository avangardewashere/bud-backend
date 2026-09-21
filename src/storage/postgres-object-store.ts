import { Buffer } from 'node:buffer';

import type { PrismaService } from '../prisma/prisma.service.js';
import { ObjectNotFoundError, type ObjectStore } from './object-store.js';

/**
 * Course files in the main database (STORAGE_DRIVER=postgres).
 *
 * For hosting with no object store. The Docker course is 400 KB across twelve
 * files, so Neon's free 0.5 GB holds a thousand of them; and it trades an
 * account, a card on file and a download cap for one table. Everything is
 * keyed exactly as in a bucket, so switching back to S3 is a data copy, not a
 * code change.
 */
export class PostgresObjectStore implements ObjectStore {
  constructor(private readonly prisma: PrismaService) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    // Overwrites, as PutObject does. Versions are immutable by convention —
    // a new upload is a new prefix — not by this method refusing.
    const bytes = new Uint8Array(body);
    await this.prisma.storedObject.upsert({
      where: { key },
      create: { key, contentType, body: bytes },
      update: { contentType, body: bytes },
    });
  }

  async getText(key: string): Promise<string> {
    return Buffer.from(await this.getBytes(key)).toString('utf-8');
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const row = await this.prisma.storedObject.findUnique({
      where: { key },
      select: { body: true },
    });

    if (!row) {
      throw new ObjectNotFoundError(key);
    }

    return row.body;
  }

  async list(prefix: string): Promise<string[]> {
    const rows = await this.prisma.storedObject.findMany({
      where: { key: { startsWith: prefix } },
      select: { key: true },
      orderBy: { key: 'asc' },
    });

    // startsWith becomes SQL LIKE, where `_` and `%` are wildcards. Keys are
    // generated and contain neither today, but a prefix match that can
    // over-match must not be what decides which files a delete removes.
    return rows.map((row) => row.key).filter((key) => key.startsWith(prefix));
  }

  async deletePrefix(prefix: string): Promise<number> {
    // By the exact keys `list` settled on, never by pattern.
    const keys = await this.list(prefix);
    if (keys.length === 0) {
      return 0;
    }

    const { count } = await this.prisma.storedObject.deleteMany({
      where: { key: { in: keys } },
    });
    return count;
  }

  /** The table is created by migration; there is nothing to provision. */
  async ensureReady(): Promise<void> {}

  /**
   * The readiness endpoint already checks the database this lives in, so a
   * second query here would only double the cost of every probe.
   */
  async ping(): Promise<void> {}
}
