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
import { packagePathsReferencedBy, storageKeysUsedIn } from './references.js';
import { suggestFieldFor } from './suggest-field.js';
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
          validated.error.issues.map(describeIssue).join('\n'),
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
            // The allowed set, because the enum errors in this same tool name
            // their vocabulary and this one used to leave the author guessing
            // one extension per round trip.
            `${paths.slice(0, 20).join('\n')}${paths.length > 20 ? `\n…and ${paths.length - 20} more` : ''}\n` +
              `Allowed: ${[...ALLOWED_EXTENSIONS]
                .sort()
                .map((e) => `.${e}`)
                .join(' ')}`,
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
    // Each warning carries its own remedy. "No cover image" left an author who
    // had put a cover.png at the package root with no way to learn that the
    // manifest has to name it.
    if (!manifest.cover) {
      results.push(
        warning(
          'cover_missing',
          'No cover image; default cover will be generated.',
          'Add "cover": "<path>" to the manifest — a path relative to bud.manifest.json, ' +
            'e.g. "assets/cover.png". A wide image works best: the catalog renders it at 16:9, ' +
            'so 1200×675 is a good size.',
        ),
      );
    } else if (!present.has(manifest.cover)) {
      results.push(
        warning(
          'cover_missing',
          `Cover "${manifest.cover}" is missing; default cover will be generated.`,
          'The path is relative to bud.manifest.json, and the file has to be inside the package.',
        ),
      );
    } else {
      // Said out loud, because the report enumerated everything except whether
      // the one image an author deliberately made was being used at all.
      const bytes = read.entries.find((e) => e.path === manifest.cover)?.uncompressedSize;
      results.push(
        pass(
          'cover_found',
          `Cover ${manifest.cover}${bytes === undefined ? '' : ` · ${formatBytes(bytes)}`}`,
        ),
      );
    }

    // ── 7. the manifest against the files it names ──────────────────────────
    results.push(...consistencyChecks(manifest, read.files, present));

    return { report: toReport(results), manifest, entries: read.entries };
  }
}

/**
 * One Zod issue as a line an author can act on.
 *
 * The addition is the suggestion on an unrecognised key. Zod reports a rejected
 * `description` and a missing `summary` as two unrelated lines, and joining them
 * up was left to whoever was hand-writing their first manifest.
 */
function describeIssue(issue: { code: string; path: PropertyKey[]; message: string }): string {
  const at = issue.path.map(String).join('.');
  const line = `${at || '(root)'}: ${issue.message}`;

  if (issue.code !== 'unrecognized_keys') {
    return line;
  }

  const suggestions = ((issue as { keys?: string[] }).keys ?? [])
    .map((key) => {
      const field = suggestFieldFor(key, at);
      return field ? `"${key}" → did you mean "${field}"?` : undefined;
    })
    .filter((s): s is string => s !== undefined);

  return suggestions.length > 0 ? `${line}\n  ${suggestions.join('\n  ')}` : line;
}

/**
 * Everything that can only be checked by reading the session files and the
 * manifest against each other. All warnings, on purpose: each describes a
 * package that works and is missing something, and this validator's rule is
 * that warnings are worth fixing and never reasons to refuse.
 */
function consistencyChecks(
  manifest: CourseManifest,
  files: Map<string, string>,
  present: Set<string>,
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const declared = new Set(manifest.storageKeys);
  const used = new Set<string>();
  let unresolved = false;

  for (const session of manifest.sessions) {
    const source = files.get(session.entry);
    if (source === undefined) {
      // Already reported as a missing entry.
      continue;
    }

    const keys = storageKeysUsedIn(source);
    for (const key of keys.keys) {
      used.add(key);
    }
    unresolved ||= keys.unresolved;

    // One result per file, per the contract: a session pointing at four missing
    // images is one trip back to the folder.
    const dangling = packagePathsReferencedBy(session.entry, source).filter(
      (path) => !present.has(path),
    );

    if (dangling.length > 0) {
      results.push(
        warning(
          'asset_missing',
          `${session.entry} points at ${dangling.length} file${dangling.length === 1 ? '' : 's'} that ${dangling.length === 1 ? 'is' : 'are'} not in the package`,
          `${dangling.slice(0, 20).join('\n')}${dangling.length > 20 ? `\n…and ${dangling.length - 20} more` : ''}\n` +
            'Paths are relative to the file that names them. A learner sees a broken image.',
        ),
      );
    }
  }

  const undeclared = [...used].filter((key) => !declared.has(key)).sort();
  if (undeclared.length > 0) {
    results.push(
      warning(
        'storage_key_undeclared',
        `${undeclared.length} storage key${undeclared.length === 1 ? '' : 's'} used by a session but not declared in storageKeys`,
        `${undeclared.join('\n')}\n` +
          'Saving still works — Bud accepts an undeclared key — but the key will be missing from ' +
          "the learner's export and from the admin view of this course.",
      ),
    );
  }

  const unused = [...declared].filter((key) => !usedAnywhere(key, manifest, files)).sort();
  if (unused.length > 0) {
    results.push(
      warning(
        'storage_key_unused',
        `${unused.length} declared storage key${unused.length === 1 ? '' : 's'} that no session appears to use`,
        `${unused.join('\n')}\n` +
          'Usually a typo on one side or a session that was removed.' +
          (unresolved
            ? ' One or more keys in this course are built at runtime, so this list may include keys that are used after all.'
            : ''),
      ),
    );
  }

  return results;
}

/**
 * Whether a declared key appears anywhere in any session, literally.
 *
 * Looser than the call-site scan on purpose: this decides whether to *warn* that
 * nothing uses a key, and a course that builds a key out of a prefix would
 * otherwise be nagged about keys it uses perfectly well. A plain substring is
 * the honest test of "did the author write this string down anywhere".
 */
function usedAnywhere(key: string, manifest: CourseManifest, files: Map<string, string>): boolean {
  return manifest.sessions.some((session) => files.get(session.entry)?.includes(key) === true);
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
