import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import type { Buffer } from 'node:buffer';

import type { AppConfigService } from '../config/app-config.service.js';
import type { ObjectStore } from './object-store.js';

/** The env schema requires these whenever this driver is selected. */
function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is not set, and STORAGE_DRIVER is s3.`);
  }
  return value;
}

/**
 * What a failed `HeadBucket` actually means, in the words of the thing to fix.
 *
 * The SDK reports the HTTP status on `$metadata` and a name on the error, and
 * for this one command they separate the cases cleanly: 404 is a bucket that is
 * not there, 403 is a bucket we are not allowed to see (a rejected key, or
 * someone else's bucket), 301 is the right bucket in another region, and no
 * status at all means nothing answered.
 *
 * Exported for its test: these branches are unreachable from a real MinIO
 * without breaking the config four different ways.
 */
export function describeStorageFailure(error: unknown, bucket: string): string {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  const name = error instanceof Error ? error.name : '';

  if (status === 404 || name === 'NotFound' || name === 'NoSuchBucket') {
    return `bucket "${bucket}" does not exist, so create it deliberately.`;
  }
  if (status === 403 || name === 'Forbidden' || name === 'AccessDenied') {
    return (
      `the credentials were rejected for bucket "${bucket}", or they belong to an account ` +
      'that cannot see it — check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.'
    );
  }
  if (status === 301 || name === 'PermanentRedirect') {
    return `bucket "${bucket}" exists in a different region than S3_REGION says.`;
  }
  if (status === 400 && (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch')) {
    return 'the access key or secret is malformed — check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.';
  }
  if (status === undefined) {
    // A network failure carries no HTTP status and no useful name — the SDK
    // hands up `{ name: 'Error', code: 'ECONNREFUSED' }`, so the code is the
    // part worth printing.
    const code = (error as { code?: string } | null)?.code;
    return `nothing answered at S3_ENDPOINT (${code ?? name ?? 'no response'}), so the endpoint or the network is wrong.`;
  }

  return `the store answered ${status}${name ? ` (${name})` : ''}.`;
}

/**
 * Any S3-compatible bucket: MinIO locally, R2 or S3 in production — the only
 * difference is configuration (Tech-Information.md §4).
 */
export class S3ObjectStore implements ObjectStore {
  private readonly logger = new Logger(S3ObjectStore.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: AppConfigService) {
    this.bucket = required(config.get('S3_BUCKET'), 'S3_BUCKET');
    this.client = new S3Client({
      endpoint: required(config.get('S3_ENDPOINT'), 'S3_ENDPOINT'),
      region: config.get('S3_REGION'),
      // MinIO needs path-style addressing; R2 and S3 do not.
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE'),
      credentials: {
        accessKeyId: required(config.get('S3_ACCESS_KEY_ID'), 'S3_ACCESS_KEY_ID'),
        secretAccessKey: required(config.get('S3_SECRET_ACCESS_KEY'), 'S3_SECRET_ACCESS_KEY'),
      },
    });
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

  async getText(key: string): Promise<string> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (!response.Body) {
      throw new Error(`No body for ${key}`);
    }

    return response.Body.transformToString('utf-8');
  }

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
   * Creates the bucket if it is missing — never in production, where the
   * bucket is provisioned deliberately and the API's credentials may not
   * permit this.
   */
  async ensureReady(): Promise<void> {
    let failure: unknown;

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      // Falls through to create; a missing bucket is the expected case here.
      failure = error;
    }

    if (this.config.isProduction) {
      // This message is the first thing an operator sees when a production boot
      // fails, and "the bucket does not exist" used to be all it could say —
      // for a rejected key, a wrong region or an unreachable endpoint alike.
      // Three different things to go and do, reported as the one that was
      // probably not it, at the moment there is least else to go on.
      throw new Error(
        `Object storage is not usable: ${describeStorageFailure(failure, this.bucket)} ` +
          `Endpoint ${this.config.get('S3_ENDPOINT')}, region ${this.config.get('S3_REGION')}, ` +
          `bucket "${this.bucket}". The API does not provision storage in production.`,
      );
    }

    await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    this.logger.log(`Created bucket "${this.bucket}"`);
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}
