import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';

import { courseFilesUnder, packCourseDirectory } from './pack.js';

/**
 * Packing is the step where "my folder" becomes "the thing the server judges",
 * so a difference between what an author validates and what an admin uploads
 * shows up here or nowhere. These tests care about the archive's *shape* — names,
 * order, exclusions — because the rules about its contents belong to
 * CourseSpecService and are tested against it.
 */

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A throwaway directory tree; keys are relative paths, values file contents. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'bud-pack-'));
  temporary.push(root);

  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }

  return root;
}

/** Entry names as a zip reader actually sees them. */
async function namesIn(archive: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('not a zip'));
        return;
      }
      const names: string[] = [];
      zip.on('entry', (entry: { fileName: string }) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('packCourseDirectory', () => {
  it('names entries relative to the directory, with forward slashes', async () => {
    const root = tree({
      'bud.manifest.json': '{}',
      'sessions/one.html': '<p>one</p>',
      'assets/img/cover.png': 'not really a png',
    });

    const { archive } = await packCourseDirectory(root);

    // Forward slashes whatever the host OS does, because that is what a zip
    // entry name is — this test is the reason it passes on Windows.
    expect(await namesIn(archive)).toEqual([
      'assets/img/cover.png',
      'bud.manifest.json',
      'sessions/one.html',
    ]);
  });

  it('produces the same bytes twice from the same files', async () => {
    // So an author can tell that what they are uploading is what they built,
    // and so a rebuild in CI is comparable. Timestamps are fixed for this.
    const root = tree({ 'bud.manifest.json': '{}', 'a.html': '<p>a</p>' });

    const first = await packCourseDirectory(root);
    const second = await packCourseDirectory(root);

    expect(second.archive.equals(first.archive)).toBe(true);
  });

  it('leaves out what is never part of a course, and says so', async () => {
    const root = tree({
      'bud.manifest.json': '{}',
      '.DS_Store': 'finder junk',
      'node_modules/pkg/index.js': 'module.exports = 1',
      '.git/config': '[core]',
      'assets/Thumbs.db': 'windows junk',
    });

    const { archive, skipped } = await packCourseDirectory(root);

    // Excluded rather than left to fail validation: an author who opened the
    // folder in Finder should not be told their course contains a bad file type.
    expect(await namesIn(archive)).toEqual(['bud.manifest.json']);
    expect(skipped.sort()).toEqual(['.DS_Store', '.git', 'assets/Thumbs.db', 'node_modules']);
  });

  it('never follows a symlink into the archive', async () => {
    const root = tree({ 'bud.manifest.json': '{}' });
    const outside = tree({ 'secret.txt': 'not yours' });

    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    } catch {
      // Windows without developer mode refuses to create symlinks; the archive
      // reader's own refusal is covered in course-spec.service.spec.ts.
      return;
    }

    const { archive, skipped } = await packCourseDirectory(root);

    expect(await namesIn(archive)).toEqual(['bud.manifest.json']);
    expect(skipped).toContain('link.txt');
  });

  it('refuses a path that is not a directory', async () => {
    const root = tree({ 'bud.manifest.json': '{}' });

    await expect(packCourseDirectory(join(root, 'bud.manifest.json'))).rejects.toThrowError(
      /Not a directory/,
    );
  });
});

describe('courseFilesUnder', () => {
  it('sorts, so the archive does not depend on filesystem order', () => {
    const root = tree({ 'z.html': 'z', 'a.html': 'a', 'm/b.html': 'b' });

    expect(courseFilesUnder(root).files).toEqual(['a.html', 'm/b.html', 'z.html']);
  });
});
