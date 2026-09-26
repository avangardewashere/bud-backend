import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { run } from './course.js';

/**
 * `bud-course validate`, checked the way an author experiences it: an exit code
 * and what was printed.
 *
 * The exit code is the load-bearing part — it is what a pre-commit hook or a CI
 * step reads — so each case pins it. Warnings must not fail: a missing cover is
 * worth telling someone about and is no reason to refuse their work.
 */

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
});

const temporary: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'bud-cli-'));
  temporary.push(root);

  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }

  return root;
}

const printed = () => out.join('');

describe('bud-course validate', () => {
  it('accepts the real Docker course package', async () => {
    const code = await run(['validate', join(FIXTURES, 'course-package')]);

    expect(code).toBe(0);
    expect(printed()).toContain('10 sessions');
    // It has no cover, which is a warning and must stay one.
    expect(printed()).toContain('Publishable');
  });

  it('accepts the package that has a cover, with nothing to report', async () => {
    const code = await run(['validate', join(FIXTURES, 'course-with-cover')]);

    expect(code).toBe(0);
    expect(printed()).toContain('No problems');
  });

  it('refuses a directory with no manifest, and says which file is missing', async () => {
    const root = tree({ 'session-1.html': '<p>a session and nothing else</p>' });

    const code = await run(['validate', root]);

    expect(code).toBe(1);
    expect(printed()).toContain('bud.manifest.json');
    expect(printed()).toContain('Not publishable yet');
  });

  it('refuses a manifest whose session entry is not in the package', async () => {
    // The commonest authoring mistake: renaming a file and not the manifest.
    const root = tree({
      'bud.manifest.json': JSON.stringify({
        spec: 'bud-course/1',
        id: 'ghost-course',
        title: 'Ghost',
        version: '1.0.0',
        summary: 'Points at a session that is not here.',
        sessions: [{ id: 's1', order: 1, title: 'Missing', entry: 'not-here.html' }],
      }),
    });

    const code = await run(['validate', root]);

    expect(code).toBe(1);
    expect(printed()).toContain('not-here.html');
  });

  it('reports a file it left out rather than hiding it', async () => {
    const root = tree({
      'bud.manifest.json': JSON.stringify({
        spec: 'bud-course/1',
        id: 'junk-course',
        title: 'Junk',
        version: '1.0.0',
        summary: 'Has a .DS_Store beside it, as any real folder does.',
        sessions: [{ id: 's1', order: 1, title: 'One', entry: 'one.html' }],
      }),
      'one.html': '<p>one</p>',
      '.DS_Store': 'finder junk',
    });

    const code = await run(['validate', root]);

    expect(code).toBe(0);
    expect(printed()).toContain('left out: .DS_Store');
  });

  it('prints the report as JSON for a machine to read', async () => {
    const code = await run(['validate', join(FIXTURES, 'course-with-cover'), '--json']);

    expect(code).toBe(0);
    const report = JSON.parse(printed()) as { ok: boolean; results: { code: string }[] };
    // The same shape the API returns, so one reader serves both.
    expect(report.ok).toBe(true);
    expect(report.results.map((r) => r.code)).toContain('manifest_valid');
  });

  it('says what to do when given no path', async () => {
    expect(await run(['validate'])).toBe(2);
    expect(err.join('')).toContain('bud-course validate <directory or .zip>');
  });

  it('explains itself with no arguments, and does not pretend that succeeded', async () => {
    // Exit 2, not 0: a script that runs `bud-course` with nothing has a bug.
    expect(await run([])).toBe(2);
    expect(printed()).toContain('validate <path>');
  });

  it('refuses an unknown command', async () => {
    expect(await run(['publish'])).toBe(2);
    expect(err.join('')).toContain('Unknown command: publish');
  });

  it('fails clearly when the path does not exist', async () => {
    await expect(run(['validate', join(tmpdir(), 'bud-nope-does-not-exist')])).rejects.toThrowError(
      /No such file or directory/,
    );
  });
});
