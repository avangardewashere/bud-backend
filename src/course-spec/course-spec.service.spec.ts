import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import yazl from 'yazl';

import { CourseSpecService } from './course-spec.service.js';
import type { CourseManifest } from './manifest.schema.js';
import type { ValidationCode, ValidationReport } from './validation.types.js';

/**
 * The real manifest, copied verbatim from the course package the shell ships
 * (`Bud - frontend/courses/docker-fundamentals/1.0.0/bud.manifest.json`).
 * Seeding from the real one rather than inventing a second is deliberate: a
 * hand-written fixture that quietly disagrees with the actual course would let
 * the validator pass tests and reject reality.
 */
const realManifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../test/fixtures/course-package/bud.manifest.json', import.meta.url)),
    'utf8',
  ),
) as CourseManifest;

interface ZipFileSpec {
  path: string;
  content?: string;
  /** Marks the entry as a symlink via its unix mode bits. */
  symlink?: boolean;
  /**
   * Write this exact byte sequence as the entry name, bypassing yazl's own
   * path validation. Needed because yazl is well behaved and refuses to
   * *produce* `../` names — but a hostile uploader is under no such
   * obligation, and that is precisely the case worth testing.
   */
  hostilePath?: string;
}

async function makeZip(files: ZipFileSpec[]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const patches: { placeholder: string; actual: string }[] = [];

  for (const [index, file] of files.entries()) {
    const content = Buffer.from(file.content ?? '');
    // 0xA1FF0000 = S_IFLNK | 0777 in the high 16 bits.
    const mode = file.symlink ? 0xa1ff : 0o100644;

    let name = file.path;

    if (file.hostilePath !== undefined) {
      // Same byte length as the real name, so patching it in afterwards leaves
      // every offset in the zip intact.
      const marker = `__RAW${index}__`;
      name = marker.padEnd(file.hostilePath.length, '_').slice(0, file.hostilePath.length);
      patches.push({ placeholder: name, actual: file.hostilePath });
    }

    zip.addBuffer(content, name, { mode });
  }

  zip.end();

  const built = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });

  // The name appears twice per entry: local file header and central directory.
  for (const { placeholder, actual } of patches) {
    let from = 0;
    for (;;) {
      const at = built.indexOf(placeholder, from, 'latin1');
      if (at === -1) break;
      built.write(actual, at, 'latin1');
      from = at + placeholder.length;
    }
  }

  return built;
}

/** A package that should validate cleanly: the real manifest plus stub files. */
function realCoursePackage(overrides: ZipFileSpec[] = []): Promise<Buffer> {
  const files: ZipFileSpec[] = [
    { path: 'bud.manifest.json', content: JSON.stringify(realManifest) },
    { path: realManifest.outline!, content: '# Docker course outline' },
    ...realManifest.sessions.map((s) => ({
      path: s.entry,
      content: `<!doctype html><title>${s.title}</title><script>window.storage.get("k")</script>`,
    })),
  ];

  return makeZip([...files, ...overrides]);
}

const codes = (report: ValidationReport): ValidationCode[] => report.results.map((r) => r.code);
const find = (report: ValidationReport, code: ValidationCode) =>
  report.results.find((r) => r.code === code);

describe('CourseSpecService', () => {
  const service = new CourseSpecService();

  describe('the real Docker course package', () => {
    let report: ValidationReport;

    beforeAll(async () => {
      const outcome = await service.validate(await realCoursePackage());
      report = outcome.report;
    });

    it('validates', () => {
      expect(report.ok).toBe(true);
      expect(report.results.filter((r) => r.severity === 'error')).toEqual([]);
    });

    it('reports the three passes the mockup draws', () => {
      expect(codes(report)).toEqual(
        expect.arrayContaining(['manifest_valid', 'entries_found', 'archive_safe']),
      );
    });

    it('counts all ten sessions', () => {
      expect(find(report, 'entries_found')?.message).toBe('10 / 10 session entries found');
    });

    it('warns that the cover is missing without blocking publish', () => {
      expect(find(report, 'cover_missing')?.severity).toBe('warning');
      expect(report.ok).toBe(true);
    });

    it('returns the parsed manifest for the caller to ingest', async () => {
      const outcome = await service.validate(await realCoursePackage());
      expect(outcome.manifest?.id).toBe('docker-fundamentals');
      expect(outcome.manifest?.sessions).toHaveLength(10);
      // Ten storage keys, not one — the spike's finding.
      expect(outcome.manifest?.storageKeys).toHaveLength(10);
    });
  });

  describe('manifest problems stop the run', () => {
    it('reports a missing manifest and says what was skipped', async () => {
      const zip = await makeZip([{ path: 'index.html', content: '<html></html>' }]);
      const { report } = await service.validate(zip);

      expect(report.ok).toBe(false);
      expect(codes(report)).toEqual(['manifest_missing', 'checks_skipped']);
    });

    it('reports invalid JSON without guessing at the contents', async () => {
      const zip = await makeZip([{ path: 'bud.manifest.json', content: '{ not json' }]);
      const { report } = await service.validate(zip);

      expect(codes(report)).toEqual(['manifest_invalid', 'checks_skipped']);
    });

    it('reports a schema failure with the offending paths in detail', async () => {
      const zip = await makeZip([
        {
          path: 'bud.manifest.json',
          content: JSON.stringify({ ...realManifest, version: 'one-point-oh' }),
        },
      ]);
      const { report } = await service.validate(zip);

      expect(codes(report)).toEqual(['manifest_invalid', 'checks_skipped']);
      expect(find(report, 'manifest_invalid')?.detail).toContain('version');
    });

    it('rejects duplicate session ids, which would corrupt progress', async () => {
      const sessions = [realManifest.sessions[0], { ...realManifest.sessions[1], id: 's1' }];
      const zip = await makeZip([
        { path: 'bud.manifest.json', content: JSON.stringify({ ...realManifest, sessions }) },
      ]);
      const { report } = await service.validate(zip);

      expect(find(report, 'manifest_invalid')?.detail).toContain('Duplicate session id');
    });

    it('never synthesises results for checks that did not run', async () => {
      const zip = await makeZip([{ path: 'bud.manifest.json', content: '{ not json' }]);
      const { report } = await service.validate(zip);

      // The package has one problem, so the author sees one problem — not ten.
      expect(report.results.filter((r) => r.severity === 'error')).toHaveLength(1);
      expect(find(report, 'checks_skipped')?.severity).toBe('warning');
    });
  });

  describe('archive safety', () => {
    it('rejects path traversal', async () => {
      const zip = await makeZip([
        { path: 'bud.manifest.json', content: JSON.stringify(realManifest) },
        { path: 'placeholder-a', hostilePath: '../../etc/passwd', content: 'root:x:0:0' },
      ]);
      const { report } = await service.validate(zip);

      expect(report.ok).toBe(false);
      expect(codes(report)).toContain('path_traversal');
    });

    it('rejects backslash traversal, which a forward-slash check would miss', async () => {
      const zip = await makeZip([
        { path: 'bud.manifest.json', content: JSON.stringify(realManifest) },
        {
          path: 'placeholder-b',
          hostilePath: '..\\..\\windows\\system32\\evil.dll',
          content: 'MZ',
        },
      ]);
      const { report } = await service.validate(zip);

      expect(codes(report)).toContain('path_traversal');
    });

    it('rejects symlinks', async () => {
      const zip = await makeZip([
        { path: 'bud.manifest.json', content: JSON.stringify(realManifest) },
        { path: 'secrets', content: '/etc/shadow', symlink: true },
      ]);
      const { report } = await service.validate(zip);

      expect(report.ok).toBe(false);
      expect(codes(report)).toContain('symlink');
    });

    it('stops after a structural problem rather than reporting on suspect contents', async () => {
      const zip = await makeZip([
        { path: 'bud.manifest.json', content: JSON.stringify(realManifest) },
        { path: 'placeholder-c', hostilePath: '../escape.txt', content: 'x' },
      ]);
      const { report } = await service.validate(zip);

      expect(codes(report)).toEqual(['path_traversal', 'checks_skipped']);
    });

    it('rejects an archive over the cap', async () => {
      const zip = await realCoursePackage();
      const { report } = await service.validate(zip, {
        limits: {
          maxArchiveBytes: 10,
          maxTotalUncompressedBytes: 1_000,
          maxReadableFileBytes: 1_000,
          maxEntries: 100,
        },
      });

      expect(codes(report)).toContain('size_exceeded');
    });

    it('rejects a zip bomb by its declared expansion', async () => {
      const zip = await makeZip([
        { path: 'bud.manifest.json', content: JSON.stringify(realManifest) },
        { path: 'big.txt', content: 'a'.repeat(200_000) },
      ]);
      const { report } = await service.validate(zip, {
        limits: {
          maxArchiveBytes: 50 * 1024 * 1024,
          maxTotalUncompressedBytes: 50_000,
          maxReadableFileBytes: 1024,
          maxEntries: 100,
        },
      });

      expect(codes(report)).toContain('size_exceeded');
    });

    it('rejects files outside the extension allowlist, grouped per extension', async () => {
      const { report } = await service.validate(
        await realCoursePackage([
          { path: 'tool.exe', content: 'MZ' },
          { path: 'other.exe', content: 'MZ' },
        ]),
      );

      const disallowed = report.results.filter((r) => r.code === 'disallowed_extension');
      // One line per extension: removing every .exe is one decision.
      expect(disallowed).toHaveLength(1);
      expect(disallowed[0].message).toContain('2 files');
      expect(disallowed[0].detail).toContain('tool.exe');
    });

    it('is not fooled by a file with no extension', async () => {
      const { report } = await service.validate(
        await realCoursePackage([{ path: 'Makefile', content: 'all:' }]),
      );

      expect(codes(report)).toContain('disallowed_extension');
    });
  });

  describe('referenced files', () => {
    it('reports missing session entries as one result listing them', async () => {
      const zip = await makeZip([
        { path: 'bud.manifest.json', content: JSON.stringify(realManifest) },
        { path: realManifest.outline!, content: '# outline' },
        // Only the first session's file is present.
        { path: realManifest.sessions[0].entry, content: '<html></html>' },
      ]);
      const { report } = await service.validate(zip);

      const missing = find(report, 'entry_missing');
      expect(missing?.severity).toBe('error');
      expect(missing?.message).toContain('9 referenced files missing');
      expect(missing?.detail).toContain(realManifest.sessions[1].entry);
    });
  });

  describe('external scripts', () => {
    it('reports one result per file, with every URL in detail', async () => {
      const { report } = await service.validate(
        await realCoursePackage([
          {
            path: realManifest.sessions[0].entry,
            content:
              '<script src="https://cdn.example.com/chart.js"></script>' +
              '<script src="https://cdn.example.com/util.js"></script>' +
              '<script>console.log("inline is fine")</script>',
          },
        ]),
      );

      const external = report.results.filter((r) => r.code === 'external_script');
      // Two scripts in one file is one thing to fix.
      expect(external).toHaveLength(1);
      expect(external[0].detail).toContain('chart.js');
      expect(external[0].detail).toContain('util.js');
      expect(external[0].detail).toContain('Bundle them into the package.');
    });

    it('allows inline script, which is the author&apos;s own course code', async () => {
      const { report } = await service.validate(await realCoursePackage());

      expect(codes(report)).not.toContain('external_script');
    });

    it('catches protocol-relative sources', async () => {
      const { report } = await service.validate(
        await realCoursePackage([
          {
            path: realManifest.sessions[0].entry,
            content: '<script src="//cdn.example.com/x.js"></script>',
          },
        ]),
      );

      expect(codes(report)).toContain('external_script');
    });
  });

  describe('packaging kindnesses', () => {
    it('accepts a zip of the folder rather than its contents', async () => {
      const files: ZipFileSpec[] = [
        { path: 'docker-course/bud.manifest.json', content: JSON.stringify(realManifest) },
        { path: `docker-course/${realManifest.outline!}`, content: '# outline' },
        ...realManifest.sessions.map((s) => ({
          path: `docker-course/${s.entry}`,
          content: '<html></html>',
        })),
      ];
      const { report } = await service.validate(await makeZip(files));

      expect(report.ok).toBe(true);
      expect(find(report, 'entries_found')).toBeDefined();
    });

    it('rejects something that is not a zip at all', async () => {
      const { report } = await service.validate(Buffer.from('I am a PDF, honest'));

      expect(report.ok).toBe(false);
      expect(codes(report)).toEqual(['manifest_missing', 'checks_skipped']);
    });
  });

  describe('course id availability', () => {
    it('reports a clash, and explains that re-uploading is not one', async () => {
      const { report } = await service.validate(await realCoursePackage(), {
        isCourseIdTaken: () => Promise.resolve(true),
      });

      const clash = find(report, 'duplicate_course_id');
      expect(clash?.severity).toBe('error');
      expect(clash?.detail).toContain('new version');
    });

    it('says nothing when the id is free', async () => {
      const { report } = await service.validate(await realCoursePackage(), {
        isCourseIdTaken: () => Promise.resolve(false),
      });

      expect(codes(report)).not.toContain('duplicate_course_id');
      expect(report.ok).toBe(true);
    });
  });

  describe('the report contract', () => {
    it('derives ok from the absence of errors, never from warnings', async () => {
      const { report } = await service.validate(await realCoursePackage());

      expect(report.results.some((r) => r.severity === 'warning')).toBe(true);
      expect(report.ok).toBe(true);
    });

    it('gives every result a severity, a code and a message', async () => {
      const { report } = await service.validate(await realCoursePackage());

      for (const r of report.results) {
        expect(r.severity).toMatch(/^(pass|warning|error)$/);
        expect(r.code).toBeTruthy();
        expect(r.message).toBeTruthy();
      }
    });
  });
});
