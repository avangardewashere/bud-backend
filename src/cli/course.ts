/**
 * `bud-course` — the authoring toolkit.
 *
 *   node dist/cli/course.js validate <directory or .zip> [--json]
 *
 * For someone writing a course, not someone running Bud. It needs no database,
 * no environment, no server and no account: a course package is a file, and
 * whether it is a valid one is a property of the file.
 *
 * The point is that it cannot disagree with the server. It runs the very same
 * CourseSpecService that POST /admin/courses runs, over an archive built the
 * very same way, so "it validates locally" and "it will be accepted" are the
 * same sentence. A second implementation of these rules — which is what a
 * client-side checker would be — would drift, and an author would find out at
 * upload time. Roadmap-Status records that decision.
 *
 * Lives in src/ rather than scripts/ so it compiles into dist/ and works with
 * no tsx and no dev dependencies.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { DEFAULT_ARCHIVE_LIMITS } from '../course-spec/archive.js';
import { CourseSpecService, type ValidationOutcome } from '../course-spec/course-spec.service.js';
import { packCourseDirectory } from '../course-spec/pack.js';
import { formatReport, summariseReport } from './report.js';

const USAGE = `bud-course — check and build Bud course packages

  validate <path> [--json]   Check a course directory or .zip against the spec
  pack <dir> [-o <file>]     Check a directory, then write the .zip to upload

A path to validate may be a directory of course files or an already-built .zip.
Exits 0 when the package would be accepted, 1 when it would be refused.
Warnings never fail: they are things worth fixing, not reasons to refuse.

pack writes <id>-<version>.zip beside you unless -o says otherwise, and will
not overwrite an existing file unless you pass --force.
`;

/** Where the archive came from, and how big it turned out. */
interface Source {
  archive: Buffer;
  describe: string;
  /** Only for a directory: what packing left out. */
  skipped: string[];
}

export async function readSource(path: string): Promise<Source> {
  const full = resolve(path);

  if (!existsSync(full)) {
    throw new Error(`No such file or directory: ${full}`);
  }

  if (statSync(full).isDirectory()) {
    const packed = await packCourseDirectory(full);
    return {
      archive: packed.archive,
      describe: `${full} — ${packed.entries.length} file${packed.entries.length === 1 ? '' : 's'}`,
      skipped: packed.skipped,
    };
  }

  return { archive: readFileSync(full), describe: full, skipped: [] };
}

export async function validateCommand(argv: string[]): Promise<number> {
  const asJson = argv.includes('--json');
  const path = argv.find((arg) => !arg.startsWith('--'));

  if (!path) {
    process.stderr.write('validate needs a path: bud-course validate <directory or .zip>\n');
    return 2;
  }

  const source = await readSource(path);
  const outcome: ValidationOutcome = await new CourseSpecService().validate(source.archive);

  if (asJson) {
    // The report verbatim, for a CI step or an editor plugin. Same shape the
    // API returns, so anything that can read one can read the other.
    process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
    return outcome.report.ok ? 0 : 1;
  }

  const kb = (source.archive.byteLength / 1024).toFixed(1);
  const capMb = (DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes / 1024 / 1024).toFixed(0);
  process.stdout.write(`${source.describe}\n  ${kb} KB packed, of ${capMb} MB allowed\n\n`);

  for (const name of source.skipped) {
    process.stdout.write(`  · left out: ${name}\n`);
  }
  if (source.skipped.length > 0) {
    process.stdout.write('\n');
  }

  for (const line of formatReport(outcome.report)) {
    process.stdout.write(`${line}\n`);
  }

  if (outcome.manifest) {
    const { id, version, title, sessions } = outcome.manifest;
    process.stdout.write(
      `\n  ${title} — ${id}@${version}, ${sessions.length} session${sessions.length === 1 ? '' : 's'}\n`,
    );
  }

  process.stdout.write(`\n${summariseReport(outcome.report)}\n`);

  return outcome.report.ok ? 0 : 1;
}

/**
 * Builds the archive an admin uploads — but only once it would be accepted.
 *
 * Packing an unpublishable course and handing it over would just move the
 * rejection later, to the one place where the author is not present to read it.
 * Warnings still pack: they are notes, not refusals.
 */
export async function packCommand(argv: string[]): Promise<number> {
  const force = argv.includes('--force');
  const outFlag = argv.findIndex((arg) => arg === '-o' || arg === '--out');
  const out = outFlag === -1 ? undefined : argv[outFlag + 1];

  if (outFlag !== -1 && (out === undefined || out.startsWith('-'))) {
    process.stderr.write('-o needs a filename after it.\n');
    return 2;
  }

  // `index !== outFlag + 1` skips -o's own value. Guarded, because with no -o
  // at all outFlag is -1 and that test would skip the first argument instead —
  // which is the directory.
  const dir = argv.find(
    (arg, index) => !arg.startsWith('-') && (outFlag === -1 || index !== outFlag + 1),
  );

  if (!dir) {
    process.stderr.write('pack needs a directory: bud-course pack <dir> [-o <file>]\n');
    return 2;
  }

  const full = resolve(dir);
  if (!existsSync(full) || !statSync(full).isDirectory()) {
    throw new Error(`Not a directory: ${full}`);
  }

  const packed = await packCourseDirectory(full);
  const outcome = await new CourseSpecService().validate(packed.archive);

  for (const name of packed.skipped) {
    process.stdout.write(`  · left out: ${name}\n`);
  }

  for (const line of formatReport(outcome.report)) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(`\n${summariseReport(outcome.report)}\n`);

  if (!outcome.report.ok || !outcome.manifest) {
    process.stderr.write('\nNothing written.\n');
    return 1;
  }

  const { id, version, title, sessions } = outcome.manifest;
  process.stdout.write(
    `\n  ${title} — ${id}@${version}, ${sessions.length} session${sessions.length === 1 ? '' : 's'}\n`,
  );

  // Named from the manifest, because the id and the version are what identify a
  // package — not whatever the folder holding it happens to be called.
  const target = resolve(out ?? `${id}-${version}.zip`);

  // A package may already be the one someone uploaded, and a version is
  // supposed to be immutable, so overwriting is a decision rather than a default.
  if (existsSync(target) && !force) {
    process.stderr.write(`\n${target} exists already. Pass --force to replace it.\n`);
    return 1;
  }

  // `pack -o build/course.zip` should work the first time, without a mkdir.
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, packed.archive);

  const kb = (packed.archive.byteLength / 1024).toFixed(1);
  const digest = createHash('sha256').update(packed.archive).digest('hex').slice(0, 16);
  process.stdout.write(`\nWrote ${target}\n  ${kb} KB · sha256 ${digest}…\n`);
  // Packing is deterministic, so this digest identifies the files that went in —
  // it is worth pasting somewhere alongside "I uploaded this".
  process.stdout.write(`  ${packed.entries.length} files, ready for POST /admin/courses\n`);

  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'validate':
      return validateCommand(rest);
    case 'pack':
      return packCommand(rest);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return command === undefined ? 2 : 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

// Only when run as a program, so the commands above stay importable by tests.
if (process.argv[1] && /course\.[cm]?js$/.test(process.argv[1])) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
