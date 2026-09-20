import { Buffer } from 'node:buffer';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

/**
 * Reading an uploaded zip is the part of this service that is actually
 * dangerous: the bytes are author-controlled and we have never run them.
 * Nothing here writes to disk — entries are inspected from the central
 * directory and only the few files we need are decompressed, into memory,
 * against a cap.
 *
 * The threats this guards against, per Tech-Information.md §11:
 *   - path traversal (`../`, absolute paths, drive letters) escaping the prefix
 *   - symlinks pointing anywhere at all
 *   - zip bombs: a small archive declaring an enormous expansion
 *   - files we have no business serving (extension allowlist, applied later)
 */

export interface ArchiveLimits {
  /** Cap on the compressed upload. Start at 50 MB (Overall Plan §4). */
  maxArchiveBytes: number;
  /** Cap on the total declared uncompressed size — the zip-bomb guard. */
  maxTotalUncompressedBytes: number;
  /** Cap on any single file we decompress to read. */
  maxReadableFileBytes: number;
  /** Refuse absurd entry counts before doing any work per entry. */
  maxEntries: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxArchiveBytes: 50 * 1024 * 1024,
  maxTotalUncompressedBytes: 200 * 1024 * 1024,
  maxReadableFileBytes: 2 * 1024 * 1024,
  maxEntries: 5_000,
};

export interface ArchiveEntry {
  /** Normalised, forward-slashed, common root folder stripped. */
  path: string;
  uncompressedSize: number;
  isDirectory: boolean;
}

/** A structural problem found while reading. These stop validation. */
export interface ArchiveViolation {
  kind: 'path_traversal' | 'symlink' | 'size_exceeded';
  /** The raw entry name, as written in the zip — not the normalised one. */
  path: string;
  detail: string;
}

export interface ReadArchiveResult {
  entries: ArchiveEntry[];
  violations: ArchiveViolation[];
  /** Contents of the files we were asked to read, keyed by normalised path. */
  files: Map<string, string>;
  /** The single top-level folder that was stripped, if there was one. */
  strippedRoot?: string;
  totalUncompressedBytes: number;
}

/** Thrown when the bytes are not a readable zip at all. */
export class NotAnArchiveError extends Error {}

/**
 * Normalises a zip entry name and reports whether it tries to escape.
 * Returns null when the entry is unsafe.
 */
function normaliseEntryPath(raw: string): string | null {
  // Some writers emit backslashes; treat them as separators rather than
  // letting "a\..\..\b" slip past a forward-slash-only check.
  const unified = raw.replace(/\\/g, '/');

  if (unified.includes('\0')) {
    return null;
  }

  // Absolute, or a Windows drive letter.
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
    return null;
  }

  const segments = unified.split('/');
  if (segments.some((s) => s === '..')) {
    return null;
  }

  // Drop "." segments and empty ones from doubled slashes.
  const cleaned = segments.filter((s) => s !== '.' && s !== '').join('/');

  return cleaned === '' ? null : cleaned;
}

/**
 * `decodeStrings: false` means fileName is a Buffer at runtime even though the
 * types say string. Decode as UTF-8; a name that is not valid UTF-8 will come
 * back with replacement characters and fail the allowlist later, which is the
 * right outcome.
 */
function entryName(entry: Entry): string {
  return Buffer.isBuffer(entry.fileName)
    ? (entry.fileName as Buffer).toString('utf8')
    : entry.fileName;
}

/** Unix mode lives in the high 16 bits of externalFileAttributes. */
function isSymlink(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  return mode === 0xa000;
}

/**
 * Authors zip the folder, not its contents, far more often than not. Rather
 * than reject that with a confusing "manifest missing", strip a single shared
 * top-level directory when every entry is inside it.
 */
function findCommonRoot(paths: string[]): string | undefined {
  const tops = new Set<string>();

  for (const p of paths) {
    const [top, ...rest] = p.split('/');
    if (rest.length === 0) {
      // A file at the root means there is no single wrapping folder.
      return undefined;
    }
    tops.add(top);
    if (tops.size > 1) {
      return undefined;
    }
  }

  const [only] = [...tops];
  return only;
}

/**
 * With `decodeStrings: false`, yauzl hands us raw name bytes and performs no
 * validation of its own. That is deliberate: by default yauzl *rejects* an
 * entry named `../../etc/passwd` by emitting an error, which would surface as
 * a 500 rather than as the `path_traversal` line the admin panel is supposed
 * to render. Refusing the archive is our job, and it has to be a report.
 */
function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: false }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(new NotAnArchiveError(err?.message ?? 'Could not read the archive'));
        return;
      }
      resolve(zipfile);
    });
  });
}

function readEntryText(zipfile: ZipFile, entry: Entry, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('Could not open entry'));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;

      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        // Trust the stream, not the declared size: a lying central directory
        // must not let a file expand past the cap.
        if (total > maxBytes) {
          stream.destroy();
          reject(new Error(`Entry exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

/**
 * Walks the archive once. `wantsContent` decides which files are decompressed;
 * everything else is inspected from metadata only.
 */
export async function readArchive(
  buffer: Buffer,
  wantsContent: (path: string) => boolean,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<ReadArchiveResult> {
  const violations: ArchiveViolation[] = [];

  if (buffer.byteLength > limits.maxArchiveBytes) {
    violations.push({
      kind: 'size_exceeded',
      path: '',
      detail: `Archive is ${formatBytes(buffer.byteLength)}; the limit is ${formatBytes(limits.maxArchiveBytes)}.`,
    });
    return { entries: [], violations, files: new Map(), totalUncompressedBytes: 0 };
  }

  const zipfile = await openZip(buffer);

  const raw: { entry: Entry; normalised: string }[] = [];
  let totalUncompressedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    zipfile.on('error', reject);
    zipfile.on('end', resolve);

    zipfile.on('entry', (entry: Entry) => {
      if (raw.length >= limits.maxEntries) {
        violations.push({
          kind: 'size_exceeded',
          path: entryName(entry),
          detail: `Archive contains more than ${limits.maxEntries} entries.`,
        });
        zipfile.close();
        resolve();
        return;
      }

      // Symlinks are checked before normalisation: the target, not the name,
      // is what escapes, and we never want to follow one.
      if (isSymlink(entry)) {
        violations.push({
          kind: 'symlink',
          path: entryName(entry),
          detail: 'Symbolic links are not allowed in a course package.',
        });
        zipfile.readEntry();
        return;
      }

      const rawName = entryName(entry);
      const normalised = normaliseEntryPath(rawName);
      if (normalised === null) {
        violations.push({
          kind: 'path_traversal',
          path: entryName(entry),
          detail: 'Entry path escapes the package root.',
        });
        zipfile.readEntry();
        return;
      }

      totalUncompressedBytes += entry.uncompressedSize;
      if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
        violations.push({
          kind: 'size_exceeded',
          path: entryName(entry),
          detail:
            `Archive expands to more than ${formatBytes(limits.maxTotalUncompressedBytes)}. ` +
            'This usually means the package contains something it should not.',
        });
        zipfile.close();
        resolve();
        return;
      }

      raw.push({ entry, normalised });
      zipfile.readEntry();
    });

    zipfile.readEntry();
  });

  if (violations.length > 0) {
    return { entries: [], violations, files: new Map(), totalUncompressedBytes };
  }

  const strippedRoot = findCommonRoot(raw.map((r) => r.normalised));
  const strip = (p: string) => (strippedRoot ? p.slice(strippedRoot.length + 1) : p);

  const entries: ArchiveEntry[] = raw.map(({ entry, normalised }) => ({
    path: strip(normalised),
    uncompressedSize: entry.uncompressedSize,
    // yauzl has no isDirectory flag; a trailing slash is the convention.
    isDirectory: normalised.endsWith('/') || entryName(entry).endsWith('/'),
  }));

  const files = new Map<string, string>();

  for (const [index, { entry }] of raw.entries()) {
    const path = entries[index].path;

    if (entries[index].isDirectory || !wantsContent(path)) {
      continue;
    }

    try {
      files.set(path, await readEntryText(zipfile, entry, limits.maxReadableFileBytes));
    } catch (cause) {
      violations.push({
        kind: 'size_exceeded',
        path: entryName(entry),
        detail: cause instanceof Error ? cause.message : 'Could not read entry.',
      });
    }
  }

  zipfile.close();

  return {
    entries: entries.filter((e) => !e.isDirectory),
    violations,
    files,
    strippedRoot,
    totalUncompressedBytes,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
