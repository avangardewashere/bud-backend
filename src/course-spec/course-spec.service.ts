import { Injectable } from '@nestjs/common';
import type { Buffer } from 'node:buffer';

import {
  DEFAULT_ARCHIVE_LIMITS,
  formatBytes,
  NotAnArchiveError,
  readArchive,
  type ArchiveLimits,
  type ReadArchiveResult,
} from './archive.js';
import { MANIFEST_FILENAME, manifestSchema, type CourseManifest } from './manifest.schema.js';
import {
  checksSkipped,
  error,
  pass,
  toReport,
  warning,
  type ValidationReport,
  type ValidationResult,
} from './validation.types.js';

/**
 * Extensions a course package may contain (Tech-Information.md §11).
 * `htm` and `jpeg` are included as spelling variants of entries already on the
 * list; everything else is a deliberate addition and needs a reason.
 */
export const ALLOWED_EXTENSIONS = new Set([
  'html',
  'htm',
  'css',
  'js',
  'json',
  'md',
  'png',
  'jpg',
  'jpeg',
  'svg',
  'webp',
  'woff2',
  'txt',
]);

/** `<script src="…">` pointing at another origin. Inline script is the author's business. */
const EXTERNAL_SCRIPT = /<script\b[^>]*\bsrc\s*=\s*["']((?:https?:)?\/\/[^"']+)["'][^>]*>/gi;

export interface ValidateOptions {
  /**
   * Lets the caller answer "is this course id already taken by a different
   * course?" without this service knowing about the database.
   */
  isCourseIdTaken?: (id: string) => Promise<boolean>;
  limits?: ArchiveLimits;
}

export interface ValidationOutcome {
  report: ValidationReport;
  /** Only present when the manifest validated; the caller needs it to ingest. */
  manifest?: CourseManifest;
  /** Files actually present in the package, for the caller to upload. */
  entries?: ReadArchiveResult['entries'];
}

/**
 * Validates an uploaded course package and reports what the admin panel renders.
 *
 * The contract is frozen in Planning/Overall Plan.md §4. The rule that shapes
 * this code most: **never synthesise results for checks that did not run.** If
 * the manifest is unreadable, the checks downstream of it are meaningless, so
 * the report stops and says how many were skipped rather than padding itself
 * with speculative errors the author would go chasing.
 */
@Injectable()
export class CourseSpecService {
  async validate(archive: Buffer, options: ValidateOptions = {}): Promise<ValidationOutcome> {
    const limits = options.limits ?? DEFAULT_ARCHIVE_LIMITS;
    const results: ValidationResult[] = [];

    // ── read the archive ────────────────────────────────────────────────────
    let read: ReadArchiveResult;
    try {
      read = await readArchive(
        archive,
        (path) => path === MANIFEST_FILENAME || /\.html?$/i.test(path),
        limits,
      );
    } catch (cause) {
      if (cause instanceof NotAnArchiveError) {
        results.push(
          error('manifest_missing', 'That file is not a readable zip archive.', cause.message),
        );
        results.push(checksSkipped(5, 'provide a zip archive and try again.'));
        return { report: toReport(results) };
      }
      throw cause;
    }

    // Structural problems mean nothing in the package can be trusted, so stop
    // here rather than reporting on contents we just decided are suspect.
    if (read.violations.length > 0) {
      for (const violation of read.violations) {
        results.push(
          error(
            violation.kind,
            violation.path
              ? `${describeViolation(violation.kind)} in "${violation.path}"`
              : describeViolation(violation.kind),
            violation.detail,
          ),
        );
      }
      results.push(checksSkipped(5, 'repackage the course and try again.'));
      return { report: toReport(results) };
    }

    // ── 1. manifest ─────────────────────────────────────────────────────────
    const manifestSource = read.files.get(MANIFEST_FILENAME);

    if (manifestSource === undefined) {
      results.push(
        error(
          'manifest_missing',
          `No ${MANIFEST_FILENAME} at the root of the package.`,
          read.strippedRoot
            ? `Looked inside "${read.strippedRoot}/" as well.`
            : 'It must sit beside the course files, not inside a subfolder.',
        ),
      );
      results.push(checksSkipped(4, `add ${MANIFEST_FILENAME} and try again.`));
      return { report: toReport(results) };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestSource);
    } catch (cause) {
      results.push(
        error(
          'manifest_invalid',
          `${MANIFEST_FILENAME} is not valid JSON.`,
          cause instanceof Error ? cause.message : undefined,
        ),
      );
      results.push(checksSkipped(4, 'fix the manifest and try again.'));
      return { report: toReport(results) };
    }

    const validated = manifestSchema.safeParse(parsed);

    if (!validated.success) {
      results.push(
        error(
          'manifest_invalid',
          `${MANIFEST_FILENAME} does not match the bud-course/1 spec.`,
          validated.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('\n'),
        ),
      );
      results.push(checksSkipped(4, 'fix the manifest and try again.'));
      return { report: toReport(results) };
    }

    const manifest = validated.data;
    results.push(pass('manifest_valid', `Manifest valid against ${manifest.spec}`));

    // ── 2. course id availability ───────────────────────────────────────────
    if (options.isCourseIdTaken && (await options.isCourseIdTaken(manifest.id))) {
      results.push(
        error(
          'duplicate_course_id',
          `Course id "${manifest.id}" already belongs to another course.`,
          'Re-uploading the same course is fine — that creates a new version. ' +
            'A different course needs a different id.',
        ),
      );
    }

    // ── 3. every referenced file exists ─────────────────────────────────────
    const present = new Set(read.entries.map((e) => e.path));
    const missing = manifest.sessions
      .filter((session) => !present.has(session.entry))
      .map((session) => `${session.id}: ${session.entry}`);

    if (manifest.outline && !present.has(manifest.outline)) {
      missing.push(`outline: ${manifest.outline}`);
    }

    if (missing.length > 0) {
      results.push(
        error(
          'entry_missing',
          `${missing.length} referenced file${missing.length === 1 ? '' : 's'} missing from the package`,
          missing.join('\n'),
        ),
      );
    } else {
      results.push(
        pass(
          'entries_found',
          `${manifest.sessions.length} / ${manifest.sessions.length} session entries found`,
        ),
      );
    }

    // ── 4. archive safety ───────────────────────────────────────────────────
    // Traversal, symlinks and size already passed or we would have returned.
    // What is left is the extension allowlist.
    const disallowed = new Map<string, string[]>();
    for (const entry of read.entries) {
      const ext = entry.path.includes('.') ? entry.path.split('.').pop()!.toLowerCase() : '(none)';
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        const bucket = disallowed.get(ext) ?? [];
        bucket.push(entry.path);
        disallowed.set(ext, bucket);
      }
    }

    if (disallowed.size > 0) {
      // Grouped per extension rather than per file: removing every .exe is one
      // decision for the author, and the line count should track fixes.
      for (const [ext, paths] of disallowed) {
        results.push(
          error(
            'disallowed_extension',
            `${paths.length} file${paths.length === 1 ? '' : 's'} with a disallowed extension (.${ext})`,
            `${paths.slice(0, 20).join('\n')}${paths.length > 20 ? `\n…and ${paths.length - 20} more` : ''}`,
          ),
        );
      }
    } else {
      results.push(
        pass(
          'archive_safe',
          `Size ${formatBytes(archive.byteLength)} · no path traversal · allowed extensions only`,
        ),
      );
    }

    // ── 5. external scripts ─────────────────────────────────────────────────
    // One result per offending file: three scripts in one file is one fix.
    for (const [path, html] of read.files) {
      if (path === MANIFEST_FILENAME) {
        continue;
      }

      const urls = [...html.matchAll(EXTERNAL_SCRIPT)].map((m) => m[1]);
      if (urls.length > 0) {
        results.push(
          error(
            'external_script',
            `External script in ${path}`,
            `${[...new Set(urls)].join('\n')}\nBundle ${urls.length === 1 ? 'it' : 'them'} into the package.`,
          ),
        );
      }
    }

    // ── 6. cover ────────────────────────────────────────────────────────────
    if (!manifest.cover) {
      results.push(warning('cover_missing', 'No cover image; default cover will be generated.'));
    } else if (!present.has(manifest.cover)) {
      results.push(
        warning(
          'cover_missing',
          `Cover "${manifest.cover}" is missing; default cover will be generated.`,
        ),
      );
    }

    return { report: toReport(results), manifest, entries: read.entries };
  }
}

function describeViolation(kind: 'path_traversal' | 'symlink' | 'size_exceeded'): string {
  switch (kind) {
    case 'path_traversal':
      return 'Unsafe path';
    case 'symlink':
      return 'Symbolic link';
    case 'size_exceeded':
      return 'Package too large';
  }
}
