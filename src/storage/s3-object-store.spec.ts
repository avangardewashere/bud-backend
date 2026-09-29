import { describe, expect, it } from 'vitest';

import { describeStorageFailure } from './s3-object-store.js';

/**
 * The message a production boot dies with when object storage is not usable.
 *
 * It used to say "bucket does not exist" whatever had happened, which is the
 * one diagnosis that sends an operator to create a bucket they already have.
 * These branches cannot be reached from a real MinIO without breaking the
 * configuration four different ways, so they are tested from the error shapes
 * the AWS SDK produces instead.
 */

/** What `@aws-sdk/client-s3` throws: a named error carrying `$metadata`. */
function sdkError(name: string, httpStatusCode?: number): Error {
  const error = new Error(name);
  error.name = name;
  Object.assign(error, { $metadata: httpStatusCode === undefined ? {} : { httpStatusCode } });
  return error;
}

/**
 * What it throws when nothing answered, which is a different shape: the name
 * stays `Error` and the reason is in Node's `code`.
 */
function networkError(code: string): Error {
  const error = new Error(`connect ${code} 127.0.0.1:9000`);
  Object.assign(error, { code, $metadata: {} });
  return error;
}

describe('describeStorageFailure', () => {
  it('names a missing bucket, and says to create it', () => {
    expect(describeStorageFailure(sdkError('NotFound', 404), 'uploads')).toMatch(
      /"uploads" does not exist/,
    );
  });

  it('blames the credentials on a 403, not the bucket', () => {
    // The expensive mistake: an operator who reads "does not exist" creates a
    // second bucket, which cannot fix a key that is being rejected.
    const message = describeStorageFailure(sdkError('Forbidden', 403), 'uploads');

    expect(message).toMatch(/credentials were rejected/);
    expect(message).toMatch(/S3_ACCESS_KEY_ID/);
    expect(message).not.toMatch(/does not exist/);
  });

  it('names the region on a redirect', () => {
    expect(describeStorageFailure(sdkError('PermanentRedirect', 301), 'uploads')).toMatch(
      /different region than S3_REGION/,
    );
  });

  it('names the endpoint when nothing answered at all', () => {
    // A network failure carries no HTTP status, because there was no response —
    // and its `name` is the useless `Error`, so the message has to reach for
    // Node's `code`. Built here the way the SDK builds it.
    const message = describeStorageFailure(networkError('ECONNREFUSED'), 'uploads');

    expect(message).toMatch(/nothing answered at S3_ENDPOINT/);
    expect(message).toMatch(/ECONNREFUSED/);
  });

  it('reports an unfamiliar status rather than guessing', () => {
    expect(describeStorageFailure(sdkError('InternalError', 500), 'uploads')).toMatch(
      /answered 500 \(InternalError\)/,
    );
  });

  it('survives something that is not an Error at all', () => {
    // The catch block hands this function whatever was thrown.
    expect(() => describeStorageFailure('a string', 'uploads')).not.toThrow();
    expect(describeStorageFailure(null, 'uploads')).toMatch(/nothing answered/);
  });
});
