import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import type { Buffer } from 'node:buffer';

import { AppConfigService } from '../config/app-config.service.js';

/**
 * Object storage for course packages. S3-compatible on purpose: MinIO locally,
 * Cloudflare R2 in production, and the only difference is configuration
 * (Tech-Information.md §4).
 *
 * Rule 4 from §10: everything user-generated goes here at versioned paths, and
 * a stored file is never rewritten. A new upload is a new version and a new
 * prefix, which is what makes course content cacheable forever and a rollback
 * a pointer change.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: AppConfigService) {
    this.bucket = config.get('S3_BUCKET');
    this.client = new S3Client({
      endpoint: config.get('S3_ENDPOINT'),
      region: config.get('S3_REGION'),
      // MinIO needs path-style addressing; R2 and S3 do not.
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE'),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY_ID'),
        secretAccessKey: config.get('S3_SECRET_ACCESS_KEY'),
      },
    });
  }

  /**
   * Immutable prefix for one version of one course. Everything about a version
   * lives under here, so deleting a version is a prefix delete.
   */
  static prefixFor(courseSlug: string, version: string): string {
    return `courses/${courseSlug}/${version}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Course files are immutable per version, so they can be cached hard.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  /** Reads a stored text file — the course outline, for the detail page. */
  async getText(key: string): Promise<string> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (!response.Body) {
      throw new Error(`No body for ${key}`);
    }

    return response.Body.transformToString('utf-8');
  }

  /** Reads a stored binary file — images and fonts inside a course package. */
  async getBytes(key: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (!response.Body) {
      throw new Error(`No body for ${key}`);
    }

    return response.Body.transformToByteArray();
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const object of response.Contents ?? []) {
        if (object.Key) {
          keys.push(object.Key);
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }

  /** Used to clean up after a failed ingest, so a half-written version is not left behind. */
  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix);

    // DeleteObjects takes at most 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
        }),
      );
    }

    return keys.length;
  }

  /**
   * Creates the bucket if it is missing. Called from the seed and from local
   * ingestion — never automatically in production, where the bucket is
   * provisioned deliberately and the API's credentials may not permit this.
   */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch {
      // Falls through to create; a missing bucket is the expected case here.
    }

    if (this.config.isProduction) {
      throw new Error(
        `Bucket "${this.bucket}" does not exist. Create it deliberately; ` +
          'the API does not provision storage in production.',
      );
    }

    await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    this.logger.log(`Created bucket "${this.bucket}"`);
  }

  /** Cheap check for the readiness endpoint, once course serving depends on it. */
  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

export { contentTypeFor } from './content-types.js';
