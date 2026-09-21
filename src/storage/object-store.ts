import type { Buffer } from 'node:buffer';

/**
 * What StorageService needs from wherever course files actually live.
 *
 * Deliberately the lowest common denominator of an object store — keyed blobs
 * with a content type, listed and deleted by prefix — so an S3 bucket and a
 * database table can both honour it exactly, and nothing above StorageService
 * can tell which one it has.
 */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Rejects when there is no object at `key`. */
  getText(key: string): Promise<string>;
  /** Rejects when there is no object at `key`. */
  getBytes(key: string): Promise<Uint8Array>;
  list(prefix: string): Promise<string[]>;
  deletePrefix(prefix: string): Promise<number>;
  /** Makes sure the store can accept writes — creating a bucket, if it has one. */
  ensureReady(): Promise<void>;
  /** A cheap round trip, for the readiness endpoint. */
  ping(): Promise<void>;
}

/** Thrown by stores that have no native "no such key" error of their own. */
export class ObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`No stored object at ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}
