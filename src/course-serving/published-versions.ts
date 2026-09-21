import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Decides whether a course version may be served publicly.
 *
 * Without this, the content origin served any version ever uploaded to anyone
 * who could guess a slug and a version number — so unpublishing a course hid it
 * from the catalog with a 404 while its files stayed readable. Withdrawing
 * something has to actually withdraw it, and a draft is unreleased work.
 *
 * Cached, because this sits in front of every asset request: a worksheet with
 * images and fonts is a dozen requests, and a database round trip on each one
 * would make the content path depend on the database's latency as well as its
 * availability.
 */
@Injectable()
export class PublishedVersions {
  /**
   * Short. Publishing is rare, so staleness is nearly always irrelevant — but
   * when someone unpublishes to take content down, the window before it stops
   * serving should be seconds rather than minutes.
   */
  private static readonly TTL_MS = 30_000;

  private readonly cache = new Map<string, { public: boolean; checkedAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async isPublic(slug: string, version: string): Promise<boolean> {
    const key = `${slug}@${version}`;
    const cached = this.cache.get(key);
    const now = Date.now();

    if (cached && now - cached.checkedAt < PublishedVersions.TTL_MS) {
      return cached.public;
    }

    const course = await this.prisma.course.findFirst({
      where: { slug, status: 'published', deletedAt: null },
      select: { currentVersion: { select: { version: true } } },
    });

    // Only the version the catalog is actually serving. An older version stays
    // in storage so a rollback is a pointer change, but it is not public: a
    // learner mid-course is pinned by their enrolment, not by fetching a URL.
    const isPublic = course?.currentVersion?.version === version;

    this.cache.set(key, { public: isPublic, checkedAt: now });
    this.prune(now);

    return isPublic;
  }

  /**
   * Forgets everything, so a publish or an unpublish takes effect immediately
   * on this instance rather than after the TTL.
   *
   * Only this instance: with more than one replica the others still wait out
   * their own TTL, so the worst case across a cluster remains the TTL. That
   * matters if the admin UI ever grows a "take this down now" button — it
   * would be honest on one instance and up to 30 seconds late on the rest,
   * and the copy should say so rather than imply instant.
   */
  invalidate(): void {
    this.cache.clear();
  }

  private prune(now: number): void {
    if (this.cache.size < 1000) {
      return;
    }

    for (const [key, entry] of this.cache) {
      if (now - entry.checkedAt >= PublishedVersions.TTL_MS) {
        this.cache.delete(key);
      }
    }
  }
}
