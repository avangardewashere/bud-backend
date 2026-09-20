import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Buffer } from 'node:buffer';

import { AppException } from '../common/errors/app-exception.js';
import { PrismaService } from '../prisma/index.js';

/**
 * The storage bridge: exactly what `window.storage.get/set/delete` moves, and
 * nothing more. Values are opaque to the platform by design — the shell never
 * parses course state, it only keeps it per user, per course, per key.
 *
 * Semantics frozen with the shell (Overall Plan §3):
 *
 *  - **Undeclared keys are accepted.** `storageKeys` in the manifest is
 *    documentation, not a contract the server enforces. Rejecting would punish
 *    the learner for the author's mistake: the worksheet catches the rejection
 *    and shows a small "not saved" flash, so hours of work disappear because
 *    somebody typo'd a key. It is also unenforceable — keys are computed inside
 *    opaque course JavaScript — and it would break learners mid-course whenever
 *    a re-upload renamed a key.
 *  - **Writes are whole-value, last write wins.** No partial patches, nothing
 *    to merge server-side.
 *  - **Failures are non-2xx.** Every worksheet reads one signal, whether the
 *    promise rejected. A 200 carrying "not saved" would make existing courses
 *    display "saved" for a write that never happened.
 */
@Injectable()
export class StateService {
  /**
   * Bounds on what author-controlled JavaScript can put in our database. The
   * total is the one that actually binds, and it is deliberately generous:
   * it is the only limit whose victim — a learner — has no way to see their
   * usage or prune it.
   */
  static readonly MAX_KEYS = 256;
  static readonly MAX_VALUE_BYTES = 1024 * 1024;
  static readonly MAX_TOTAL_BYTES = 32 * 1024 * 1024;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves a slug to a course the learner may write state for, and fails the
   * same way for "no such course" and "not enrolled" only where that is
   * honest — an unenrolled learner gets a distinct code, because the player can
   * act on it by enrolling.
   */
  private async courseFor(userId: string, slug: string): Promise<string> {
    const course = await this.prisma.course.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true },
    });

    if (!course) {
      throw new NotFoundException(`No course "${slug}".`);
    }

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId: course.id } },
      select: { unenrolledAt: true },
    });

    if (!enrollment || enrollment.unenrolledAt) {
      throw new AppException(
        'not_enrolled',
        'You are not enrolled in this course.',
        HttpStatus.FORBIDDEN,
      );
    }

    return course.id;
  }

  /**
   * `storage.get`. Returns `{ value: string | null }` — the shape the existing
   * worksheets already expect, so a missing key is a null value rather than a
   * 404 the course would have to handle.
   */
  async get(userId: string, slug: string, key: string): Promise<{ value: string | null }> {
    const courseId = await this.courseFor(userId, slug);

    const row = await this.prisma.courseState.findUnique({
      where: { userId_courseId_key: { userId, courseId, key } },
      select: { value: true },
    });

    // Stored as JSONB but moved as a string: the bridge contract is string in,
    // string out, and the platform never interprets what is inside.
    return { value: row ? asString(row.value) : null };
  }

  /** `storage.set`. Whole value, last write wins. */
  async set(userId: string, slug: string, key: string, value: string): Promise<void> {
    const courseId = await this.courseFor(userId, slug);
    const valueBytes = Buffer.byteLength(value, 'utf8');

    if (valueBytes > StateService.MAX_VALUE_BYTES) {
      throw new AppException(
        'storage_value_too_large',
        'That value is too large to save.',
        HttpStatus.PAYLOAD_TOO_LARGE,
        `${formatBytes(valueBytes)} exceeds the ${formatBytes(StateService.MAX_VALUE_BYTES)} limit for a single key.`,
      );
    }

    const existing = await this.prisma.courseState.findUnique({
      where: { userId_courseId_key: { userId, courseId, key } },
      select: { value: true },
    });

    await this.assertWithinBounds(userId, courseId, key, valueBytes, existing !== null);

    await this.prisma.courseState.upsert({
      where: { userId_courseId_key: { userId, courseId, key } },
      create: { userId, courseId, key, value },
      update: { value },
    });
  }

  /** `storage.delete`. Every worksheet's "Clear saved work" calls this. */
  async delete(userId: string, slug: string, key: string): Promise<void> {
    const courseId = await this.courseFor(userId, slug);

    await this.prisma.courseState
      .delete({ where: { userId_courseId_key: { userId, courseId, key } } })
      // Deleting a key that was never there is a success: the caller wanted it
      // gone, and it is gone.
      .catch(() => undefined);
  }

  /** Every key a learner holds for a course. Used by "export my data" later. */
  async keys(userId: string, courseId: string): Promise<{ key: string; bytes: number }[]> {
    const rows = await this.prisma.courseState.findMany({
      where: { userId, courseId },
      select: { key: true, value: true },
    });

    return rows.map((row) => ({
      key: row.key,
      bytes: Buffer.byteLength(asString(row.value), 'utf8'),
    }));
  }

  private async assertWithinBounds(
    userId: string,
    courseId: string,
    key: string,
    valueBytes: number,
    keyExists: boolean,
  ): Promise<void> {
    const held = await this.keys(userId, courseId);

    if (!keyExists && held.length >= StateService.MAX_KEYS) {
      throw new AppException(
        'storage_key_limit_reached',
        'This course has stored too many separate pieces of state.',
        HttpStatus.CONFLICT,
        `${held.length} keys is the limit of ${StateService.MAX_KEYS}. This is usually a bug in the course.`,
      );
    }

    const otherBytes = held.filter((k) => k.key !== key).reduce((total, k) => total + k.bytes, 0);

    if (otherBytes + valueBytes > StateService.MAX_TOTAL_BYTES) {
      throw new AppException(
        'storage_quota_exceeded',
        'There is no room left to save your work for this course.',
        HttpStatus.PAYLOAD_TOO_LARGE,
        `${formatBytes(otherBytes + valueBytes)} exceeds the ${formatBytes(StateService.MAX_TOTAL_BYTES)} limit for one course.`,
      );
    }
  }
}

/**
 * Everything written through the bridge is a string, so the JSONB column holds
 * JSON strings — but the column's type allows any JSON, and `String(anObject)`
 * would quietly yield "[object Object]". Anything that is not a string is
 * re-serialised rather than mangled.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
