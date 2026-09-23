import { Injectable } from '@nestjs/common';
import type { Buffer } from 'node:buffer';

import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ObjectStore } from './object-store.js';
import { PostgresObjectStore } from './postgres-object-store.js';
import { S3ObjectStore } from './s3-object-store.js';

/**
 * Storage for course packages. STORAGE_DRIVER picks where files live: an
 * S3-compatible bucket (the default — MinIO locally, R2 or S3 in production)
 * or a table in the main database, for free hosting with no object store.
 * Callers cannot tell which, and should not need to.
 *
 * Rule 4 from Tech-Information.md §10: everything user-generated goes here at
 * versioned paths, and a stored file is never rewritten. A new upload is a new
 * version and a new prefix, which is what makes course content cacheable
 * forever and a rollback a pointer change.
 */
@Injectable()
export class StorageService {
  private readonly store: ObjectStore;

  constructor(config: AppConfigService, prisma: PrismaService) {
    this.store =
      config.get('STORAGE_DRIVER') === 'postgres'
        ? new PostgresObjectStore(prisma)
        : new S3ObjectStore(config);
  }

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.store.put(key, body, contentType);
  }

  /** Reads a stored text file — the course outline, for the detail page. */
  getText(key: string): Promise<string> {
    return this.store.getText(key);
  }

  /** Reads a stored binary file — images and fonts inside a course package. */
  getBytes(key: string): Promise<Uint8Array> {
    return this.store.getBytes(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.store.list(prefix);
  }

  /** Used to clean up after a failed ingest, so a half-written version is not left behind. */
  deletePrefix(prefix: string): Promise<number> {
    return this.store.deletePrefix(prefix);
  }

  /** Called before an ingest writes. Creates the bucket outside production, for S3. */
  ensureBucket(): Promise<void> {
    return this.store.ensureReady();
  }

  /** Cheap check for the readiness endpoint. */
  ping(): Promise<void> {
    return this.store.ping();
  }
}

export { contentTypeFor } from './content-types.js';
