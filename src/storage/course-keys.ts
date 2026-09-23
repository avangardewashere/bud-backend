/**
 * Where a course file is stored, and where a browser fetches it from.
 *
 * These are two different strings, and treating them as one cost every course
 * its cover image. A storage key is `courses/{slug}/{version}/{path}`; the path
 * the courses origin serves is `/{slug}/{version}/{path}`. The `courses/`
 * namespace belongs to the bucket, not to the URL — the content router reads
 * the second segment of a path as a version number, and a key handed out as a
 * URL puts the slug there, so it answered 404 for every cover ever uploaded.
 *
 * Nothing caught it because the only field built this way is nullable and has
 * always been null: neither the real Docker manifest nor the test fixture ships
 * a cover. Both directions live here now, with a test that walks a key out to a
 * URL and back through the router that has to accept it.
 */

import { normaliseEntryPath } from '../course-spec/entry-path.js';

/** The bucket namespace every course file lives under. */
const NAMESPACE = 'courses';

/**
 * Immutable prefix for one version of one course. Everything about a version
 * lives under here, so deleting a version is a prefix delete.
 */
export function courseStoragePrefix(courseSlug: string, version: string): string {
  return `${NAMESPACE}/${courseSlug}/${version}`;
}

/**
 * The public path for a stored course file, leading slash included, or null if
 * the key is not course content at all — which is a caller's bug, not a missing
 * file, and shows up as an absent cover rather than a broken link.
 */
export function courseContentPath(storageKey: string): string | null {
  const prefix = `${NAMESPACE}/`;
  if (!storageKey.startsWith(prefix) || storageKey.length === prefix.length) {
    return null;
  }

  // Encoded segment by segment, because the router decodes what it receives
  // (courses-server.ts) and a key is a literal, not a URL. Unencoded, a file
  // named `cover#1.png` truncated the path at the fragment and a `%` in a name
  // made the whole URL invalid. Slugs and versions contain nothing that changes
  // under encoding, so only the file part moves.
  return `/${storageKey.slice(prefix.length).split('/').map(encodeURIComponent).join('/')}`;
}

/** The absolute URL a browser loads a stored course file from. */
export function courseContentUrl(coursesOrigin: string, storageKey: string): string | null {
  const path = courseContentPath(storageKey);
  if (path === null) {
    return null;
  }

  // COURSES_ORIGIN is a validated URL, which may carry a trailing slash.
  return `${coursesOrigin.replace(/\/+$/, '')}${path}`;
}

/**
 * The cover image for the version of a course that is actually being served, or
 * null when it declares none.
 *
 * Derived from that version rather than read off a column on the course, and
 * that is the whole point: a column follows the newest *upload*. Uploading a
 * draft over a published course moved the cover to a version the content origin
 * refuses to serve — it only serves the current published one — so the catalog
 * went back to a broken image while every key looked right.
 *
 * The manifest's own spelling is normalised exactly as the archive normalised it
 * when the files were stored. The validator accepts `./assets/cover.png` and
 * `assets//cover.png`; both were stored as `assets/cover.png`, and linking the
 * raw spelling pointed at an object that was never written.
 */
export function courseCoverUrl(
  coursesOrigin: string,
  version: { storagePrefix: string; manifest: unknown } | null | undefined,
): string | null {
  const declared = (version?.manifest as { cover?: unknown } | null | undefined)?.cover;
  if (!version || typeof declared !== 'string' || declared.trim() === '') {
    return null;
  }

  const path = normaliseEntryPath(declared);
  if (path === null) {
    return null;
  }

  return courseContentUrl(coursesOrigin, `${version.storagePrefix}/${path}`);
}
