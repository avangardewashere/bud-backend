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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { DEFAULT_ARCHIVE_LIMITS } from '../course-spec/archive.js';
import { CourseSpecService, type ValidationOutcome } from '../course-spec/course-spec.service.js';
import { MANIFEST_FILENAME, manifestSchema } from '../course-spec/manifest.schema.js';
import { describeIssue } from '../course-spec/describe-issue.js';
import { packCourseDirectory } from '../course-spec/pack.js';
import { courseSpecDocument } from '../course-spec/spec-document.js';
import { formatReport, summariseReport } from './report.js';
import { scaffoldFiles, sessionFile, slugify } from './scaffold.js';

const USAGE = `bud-course — check and build Bud course packages

  init <dir> [--id <slug>] [--title <title>]
                             Start a course: a manifest, an outline, and a first
                             session with the storage bridge already wired
  add-session <dir> [--title <title>] [--weight light|medium|heavy]
                             Add a session to a course that already exists:
                             the manifest entry, its storage key and the file
  validate <path> [--json]   Check a course directory or .zip against the spec
  pack <dir> [-o <file>]     Check a directory, then write the .zip to upload
  spec [--json]              Every manifest field, the limits and the allowed
                             file types — offline, no server needed

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

  // Checked here when `-o` named the file, because whether it exists has nothing
  // to do with whether the package is valid. Running `pack` twice used to print
  // the whole green report and "No problems. Publishable." and only then refuse,
  // so the reader believed a file had been written. Without `-o` the name comes
  // from the manifest, so that check cannot move any earlier than the parse.
  if (out !== undefined && existsSync(resolve(out)) && !force) {
    process.stderr.write(`${resolve(out)} exists already. Pass --force to replace it.\n`);
    return 1;
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
    // "Nothing written" as the last line, so the ending and the exit code agree
    // — the report above it says the package is fine, and it is.
    process.stderr.write(
      `\n${target} exists already. Pass --force to replace it, or -o to write elsewhere.\nNothing written.\n`,
    );
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

/** A flag's value, or undefined. `--id slug` and `--id=slug` both work. */
function flag(argv: string[], name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) {
    return inline.slice(name.length + 3);
  }

  const at = argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : argv[at + 1];
  return value?.startsWith('-') ? undefined : value;
}

/**
 * Writes a course that is already valid, and proves it by validating what it
 * just wrote with the same code everything else uses. A scaffold that needs
 * fixing before it passes is a scaffold that teaches the wrong thing.
 */
export async function initCommand(argv: string[]): Promise<number> {
  const idFlag = flag(argv, 'id');
  const titleFlag = flag(argv, 'title');
  const skip = new Set([idFlag, titleFlag].filter((value): value is string => value !== undefined));
  const dir = argv.find((arg) => !arg.startsWith('-') && !skip.has(arg));

  if (!dir) {
    process.stderr.write('init needs a directory: bud-course init <dir> [--id <slug>]\n');
    return 2;
  }

  const full = resolve(dir);

  // Never write into work that is already there. An author who typed the wrong
  // path should lose nothing.
  if (existsSync(full) && readdirSync(full).length > 0) {
    process.stderr.write(`${full} is not empty. Pick a new directory.\n`);
    return 1;
  }

  const id = idFlag ?? slugify(basename(full));
  if (!id) {
    process.stderr.write(
      `Cannot make a course id from "${basename(full)}". Pass --id <slug>: lowercase ` +
        'letters, digits and single hyphens.\n',
    );
    return 2;
  }
  if (!slugify(id) || slugify(id) !== id) {
    process.stderr.write(
      `"${id}" is not a usable course id: lowercase letters, digits and single hyphens, 2 to 64 characters.\n`,
    );
    return 2;
  }

  for (const file of scaffoldFiles(id, titleFlag)) {
    const target = join(full, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    process.stdout.write(`  created ${file.path}\n`);
  }

  // The same validator, on what was just written. If this ever fails, the
  // template is wrong and the author should not be the one to discover it.
  const packed = await packCourseDirectory(full);
  const outcome = await new CourseSpecService().validate(packed.archive);

  process.stdout.write('\n');
  for (const line of formatReport(outcome.report)) {
    process.stdout.write(`${line}\n`);
  }

  if (!outcome.report.ok) {
    process.stderr.write(
      '\nThe template does not validate. That is a bug in Bud, not in your course.\n',
    );
    return 1;
  }

  process.stdout.write(
    `\n${id} is ready. Write session-1.html, then:\n` +
      `  npm run course -- validate ${dir}\n` +
      `  npm run course -- pack ${dir}\n`,
  );

  return 0;
}

/**
 * Adds a session to a course that already exists.
 *
 * `init` writes "a first session" and then refuses to help ever again, because
 * it will not write into a directory that has anything in it. So every author
 * asked to write a three-session course did the same five coordinated edits by
 * hand: a `sessions[]` entry with an id and an order that have to be unique, a
 * matching `storageKeys` entry, a copied HTML file, and the key constant changed
 * inside it. Four of those five had nothing checking them, and the CLI already
 * knew every rule involved — it enforces them on the way back in.
 *
 * Three of the four authors asked for this by name. A three-session course is
 * the normal case, and the toolkit only knew how to start one.
 */
export async function addSessionCommand(argv: string[]): Promise<number> {
  const titleFlag = flag(argv, 'title');
  const idFlag = flag(argv, 'id');
  const weightFlag = flag(argv, 'weight');
  const skip = new Set(
    [titleFlag, idFlag, weightFlag].filter((value): value is string => value !== undefined),
  );
  const dir = argv.find((arg) => !arg.startsWith('-') && !skip.has(arg));

  if (!dir) {
    process.stderr.write(
      'add-session needs a directory: bud-course add-session <dir> [--title <title>]\n',
    );
    return 2;
  }

  if (weightFlag !== undefined && !['light', 'medium', 'heavy'].includes(weightFlag)) {
    process.stderr.write(`--weight must be light, medium or heavy, not "${weightFlag}".\n`);
    return 2;
  }

  const full = resolve(dir);
  const manifestPath = join(full, MANIFEST_FILENAME);

  if (!existsSync(manifestPath)) {
    process.stderr.write(
      `No ${MANIFEST_FILENAME} in ${full}.\nStart a course with: bud-course init ${dir}\n`,
    );
    return 1;
  }

  // Parsed with the real schema, because everything below depends on knowing
  // the ids and orders already in use. A manifest this cannot read is one an
  // author should fix with the tool that explains it.
  const source = readFileSync(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    process.stderr.write(
      `${MANIFEST_FILENAME} is not valid JSON: ${cause instanceof Error ? cause.message : 'unreadable'}\n`,
    );
    return 1;
  }

  const validated = manifestSchema.safeParse(parsed);
  if (!validated.success) {
    process.stderr.write(`${MANIFEST_FILENAME} does not match the spec yet, so there is no\n`);
    process.stderr.write('safe place to add a session. What is wrong with it:\n\n');
    for (const issue of validated.error.issues) {
      process.stderr.write(`  ${describeIssue(issue)}\n`);
    }
    process.stderr.write(`\n  bud-course validate ${dir}\n  bud-course spec\n`);
    return 1;
  }

  const manifest = validated.data;
  const taken = {
    ids: new Set(manifest.sessions.map((s) => s.id)),
    entries: new Set(manifest.sessions.map((s) => s.entry)),
    keys: new Set(manifest.storageKeys),
  };

  const position = manifest.sessions.length + 1;

  // Follows whatever the author has been doing: `s1, s2, s3` from the scaffold,
  // or `session-1` style if they renamed them. Guessing their convention beats
  // imposing one on a course that already has three sessions named otherwise.
  const shortStyle = manifest.sessions.every((s) => /^s\d+$/.test(s.id));
  const id =
    idFlag ?? nextFree((n) => (shortStyle ? `s${n}` : `session-${n}`), position, taken.ids);

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    process.stderr.write(
      `"${id}" is not a usable session id: letters, digits, hyphens or underscores.\n`,
    );
    return 2;
  }
  if (taken.ids.has(id)) {
    process.stderr.write(`Session id "${id}" is already used in this course.\n`);
    return 1;
  }

  const entry = nextFree((n) => `session-${n}.html`, position, taken.entries);
  const entryPath = join(full, entry);
  if (existsSync(entryPath)) {
    // Not in the manifest, but on disk: someone's work in progress.
    process.stderr.write(`${entry} already exists. Move it aside, or add it to the manifest.\n`);
    return 1;
  }

  const stateKey = nextFree((n) => `${manifest.id}:session-${n}`, position, taken.keys);
  const title = titleFlag ?? `Session ${position}`;
  const order = manifest.sessions.reduce((highest, s) => Math.max(highest, s.order), 0) + 1;

  writeFileSync(entryPath, sessionFile(manifest.title, title, id, stateKey));

  // Appended to the parsed object, so JSON.stringify emits the author's own key
  // order back at them — JSON.parse preserves it. Indentation is normalised to
  // two spaces, which is what `init` writes.
  const updated = parsed as {
    sessions: unknown[];
    storageKeys?: string[];
  };
  updated.sessions.push({
    id,
    order,
    title,
    entry,
    weight: weightFlag ?? 'light',
  });
  updated.storageKeys = [...(updated.storageKeys ?? []), stateKey];
  writeFileSync(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);

  process.stdout.write(
    `  created ${entry}\n` +
      `  updated ${MANIFEST_FILENAME}\n` +
      `    session  ${id} — "${title}", order ${order}\n` +
      `    storage  ${stateKey}\n\n`,
  );

  // The whole package, with the same validator as everything else: adding a
  // session should never be the thing that quietly breaks a course.
  const packed = await packCourseDirectory(full);
  const outcome = await new CourseSpecService().validate(packed.archive);

  for (const line of formatReport(outcome.report)) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(`\n${summariseReport(outcome.report)}\n`);

  if (!outcome.report.ok) {
    process.stderr.write(
      '\nThe course does not validate with the session added. That is a bug in Bud,\n' +
        'not in your course — the session it wrote came from the same template as init.\n',
    );
    return 1;
  }

  process.stdout.write(`\nWrite ${entry}, then:\n  npm run course -- validate ${dir}\n`);
  return 0;
}

/** The first `shape(n)` that nothing has claimed, starting from `from`. */
function nextFree(shape: (n: number) => string, from: number, used: Set<string>): string {
  let n = from;
  while (used.has(shape(n))) {
    n += 1;
  }
  return shape(n);
}

/**
 * The manifest reference, offline.
 *
 * The README opens the authoring section by promising that none of this needs a
 * database, an environment or a running Bud — and then pointed at
 * `GET /course-spec/schema` as the only description of the manifest. Every
 * author who has written a course from scratch reverse-engineered the field
 * names out of validation errors instead, one guess per round trip: one of them
 * spent twenty of their thirty-one commands on it.
 *
 * Human-readable by default because that is what an author wants at that moment;
 * `--json` prints the exact document the endpoint serves, for a script.
 */
export function specCommand(argv: string[]): number {
  const document = courseSpecDocument();

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return 0;
  }

  const schema = document.schema as {
    properties?: Record<string, JsonSchemaField>;
    required?: string[];
  };

  process.stdout.write(`${document.manifestFilename} — spec ${document.spec}\n\n`);
  process.stdout.write(describeFields(schema, 'course'));

  const sessions = schema.properties?.sessions?.items;
  if (sessions) {
    process.stdout.write('\nEach entry in sessions:\n\n');
    process.stdout.write(describeFields(sessions, 'session'));
  }

  const { maxArchiveBytes, maxTotalUncompressedBytes, maxEntries } = document.limits;
  process.stdout.write(
    '\nLimits\n' +
      `  archive         ${(maxArchiveBytes / 1024 / 1024).toFixed(0)} MB\n` +
      `  unpacked        ${(maxTotalUncompressedBytes / 1024 / 1024).toFixed(0)} MB\n` +
      `  files           ${maxEntries}\n` +
      `  file types      ${document.allowedExtensions.map((e) => `.${e}`).join(' ')}\n`,
  );

  process.stdout.write(
    '\nAnything not listed above is refused rather than ignored, so a typo in a field name\n' +
      'is an error and not a setting that silently does nothing. --json prints this verbatim.\n',
  );

  return 0;
}

interface JsonSchemaField {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  items?: { properties?: Record<string, JsonSchemaField>; required?: string[] };
  properties?: Record<string, JsonSchemaField>;
  anyOf?: JsonSchemaField[];
  default?: unknown;
}

/** One line per field: name, required or not, and what it accepts. */
function describeFields(
  schema: { properties?: Record<string, JsonSchemaField>; required?: string[] },
  what: string,
): string {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const names = Object.keys(properties);

  if (names.length === 0) {
    return `  (no fields found for ${what})\n`;
  }

  const width = Math.max(...names.map((n) => n.length));

  return names
    .map((name) => {
      const field = properties[name];
      const mark = required.has(name) ? '*' : ' ';
      const line = `  ${mark} ${name.padEnd(width)}  ${describeType(field)}\n`;
      // The description below it, wrapped: these are sentences, and folding
      // them into the type column would make both unreadable.
      return field.description ? line + wrap(field.description, width + 6) : line;
    })
    .join('')
    .concat(`\n  * required\n`);
}

/** Hanging-indented lines that fit a terminal, because a field note is prose. */
function wrap(text: string, indent: number, width = 96): string {
  const room = Math.max(24, width - indent);
  const lines: string[] = [];
  let line = '';

  for (const word of text.split(/\s+/)) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= room) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') {
    lines.push(line);
  }

  return lines.map((l) => `${' '.repeat(indent)}${l}\n`).join('');
}

function describeType(field: JsonSchemaField): string {
  if (field.const !== undefined) {
    return `exactly ${JSON.stringify(field.const)}`;
  }
  if (field.enum) {
    return field.enum.map((v) => String(v)).join(' | ');
  }

  // Zod emits `anyOf` for a nullable or optional union; the interesting branch
  // is the one that is not `null`.
  const branch = field.anyOf?.find((b) => b.type !== 'null') ?? field;
  const type = Array.isArray(branch.type) ? branch.type.join(' | ') : (branch.type ?? 'value');

  if (type === 'array') {
    return branch.items?.properties ? 'array of objects' : 'array of strings';
  }
  if (type === 'object') {
    return `object (${Object.keys(branch.properties ?? {}).join(', ') || 'no fields'})`;
  }

  return branch.format ? `${type} (${branch.format})` : type;
}

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'init':
      return initCommand(rest);
    case 'add-session':
    case 'add':
      return addSessionCommand(rest);
    case 'validate':
      return validateCommand(rest);
    case 'pack':
      return packCommand(rest);
    case 'spec':
    case 'schema':
      return specCommand(rest);
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
