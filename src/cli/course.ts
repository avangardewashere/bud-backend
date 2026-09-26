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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_ARCHIVE_LIMITS } from '../course-spec/archive.js';
import { CourseSpecService, type ValidationOutcome } from '../course-spec/course-spec.service.js';
import { packCourseDirectory } from '../course-spec/pack.js';
import { formatReport, summariseReport } from './report.js';

const USAGE = `bud-course — check and build Bud course packages

  validate <path> [--json]   Check a course directory or .zip against the spec

A path may be a directory of course files or an already-built .zip.
Exits 0 when the package would be accepted, 1 when it would be refused.
Warnings never fail: they are things worth fixing, not reasons to refuse.
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

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'validate':
      return validateCommand(rest);
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
