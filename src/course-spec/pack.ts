import type { Buffer } from 'node:buffer';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { zipFiles } from '../common/zip.js';

/**
 * Turning a directory of course files into the zip an admin uploads.
 *
 * One implementation, used by everything that needs it: the authoring CLI's
 * `pack` and `validate`, and the development ingest script. A course that packs
 * one way here and another way there is a course that validates locally and is
 * refused on upload, which is the whole failure this file exists to prevent.
 *
 * It does not validate. Packing produces the artefact; CourseSpecService decides
 * whether it is acceptable, and it is the only thing that decides.
 */

/**
 * Names that are never part of a course, at any depth.
 *
 * Excluded rather than left to fail validation: an author who has opened the
 * folder in Finder should not be told their course contains a file type Bud does
 * not allow. What is skipped is always reported, because a silent exclusion of a
 * file the manifest points at would be worse than the error it avoids.
 */
const NEVER_PACKED = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.idea',
  '.vscode',
]);

/**
 * Extensions that cannot be part of a valid package, so packing one in would
 * only produce a rejection.
 *
 * `.zip` earns its place by being the natural mistake: the obvious way to build
 * a package is `pack . -o course.zip` from inside the course folder, and the
 * second run would then try to pack the first run's output. The spec's allowlist
 * has never included zip, so nothing legitimate is lost.
 */
const NEVER_PACKED_EXTENSIONS = new Set(['.zip']);

export interface PackedPackage {
  archive: Buffer;
  /** Entry names in the archive, forward-slashed, in the order they were written. */
  entries: string[];
  /** Paths skipped by the exclusion list, relative to the directory. */
  skipped: string[];
}

/**
 * Every file under a directory, recursively, excluding the names above.
 * Returns paths relative to `dir`, forward-slashed, sorted.
 */
export function courseFilesUnder(dir: string): { files: string[]; skipped: string[] } {
  const files: string[] = [];
  const skipped: string[] = [];

  const walk = (current: string): void => {
    // Sorted so the archive's entry order does not depend on the filesystem.
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    );

    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join('/');

      const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
      if (NEVER_PACKED.has(entry.name) || NEVER_PACKED_EXTENSIONS.has(extension)) {
        skipped.push(rel);
        continue;
      }

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(rel);
      } else {
        // A symlink, a socket, a device. The validator refuses symlinks in an
        // archive; never follow one into it in the first place.
        skipped.push(rel);
      }
    }
  };

  walk(dir);

  return { files, skipped };
}

/**
 * Packs a course directory into an upload archive.
 *
 * Entry names are relative to `dir` and always forward-slashed, whatever the
 * host OS uses, because that is what a zip entry name is.
 */
export async function packCourseDirectory(dir: string): Promise<PackedPackage> {
  if (!statSync(dir).isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }

  const { files, skipped } = courseFilesUnder(dir);

  // Timestamps left to the shared default, which is fixed: the same files twice
  // produce the same bytes, so an author can tell that what they are uploading
  // is what they built.
  const archive = await zipFiles(
    files.map((name) => ({
      path: name,
      content: readFileSync(join(dir, name.split('/').join(sep))),
    })),
  );

  return { archive, entries: files, skipped };
}
