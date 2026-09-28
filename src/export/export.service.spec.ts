import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';

import type { NotesService } from '../notes/notes.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ExportService } from './export.service.js';

/**
 * The export's one correctness property is that it contains exactly one
 * learner's work. Everything else is formatting.
 *
 * So the fake database here holds two learners, and every query is answered
 * honestly — filtered by the `where` it was actually given. A fake that ignores
 * the filter would let a missing `userId` pass unnoticed, which is the single
 * bug in this file that would matter.
 */

const MINE = 'user-mine';
const THEIRS = 'user-theirs';

function makeService() {
  const rows = {
    users: [
      {
        id: MINE,
        email: 'mine@bud.local',
        name: 'Mine',
        avatarUrl: null,
        timezone: 'Europe/London',
        role: 'learner',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: THEIRS,
        email: 'theirs@bud.local',
        name: 'Theirs',
        avatarUrl: null,
        timezone: 'UTC',
        role: 'learner',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ],
    enrollments: [
      {
        userId: MINE,
        courseId: 'course-docker',
        startedAt: new Date('2026-02-01T00:00:00Z'),
        lastOpenedAt: null,
        completedAt: null,
        unenrolledAt: null,
        course: { slug: 'docker-fundamentals', title: 'Docker' },
      },
      {
        userId: MINE,
        courseId: 'course-empty',
        startedAt: new Date('2026-03-01T00:00:00Z'),
        lastOpenedAt: null,
        completedAt: null,
        unenrolledAt: null,
        course: { slug: 'just-enrolled', title: 'Just Enrolled' },
      },
      {
        userId: THEIRS,
        courseId: 'course-secret',
        startedAt: new Date('2026-02-01T00:00:00Z'),
        lastOpenedAt: null,
        completedAt: null,
        unenrolledAt: null,
        course: { slug: 'their-course', title: 'Theirs' },
      },
    ],
    sessionProgress: [
      {
        userId: MINE,
        courseId: 'course-docker',
        sessionKey: 's1',
        status: 'complete',
        fraction: null,
        startedAt: new Date('2026-02-02T00:00:00Z'),
        completedAt: new Date('2026-02-03T00:00:00Z'),
      },
      {
        userId: THEIRS,
        courseId: 'course-secret',
        sessionKey: 's1',
        status: 'complete',
        fraction: null,
        startedAt: null,
        completedAt: null,
      },
    ],
    notes: [
      {
        userId: MINE,
        courseId: 'course-docker',
        sessionKey: 's1',
        bodyMd: 'Containers are processes with their own filesystem view.',
        createdAt: new Date('2026-02-02T00:00:00Z'),
        updatedAt: new Date('2026-02-02T00:00:00Z'),
      },
      {
        userId: THEIRS,
        courseId: 'course-secret',
        sessionKey: 's1',
        bodyMd: 'THEIR PRIVATE NOTE',
        createdAt: new Date('2026-02-02T00:00:00Z'),
        updatedAt: new Date('2026-02-02T00:00:00Z'),
      },
    ],
    deliverables: [
      {
        userId: MINE,
        courseId: 'course-docker',
        sessionKey: 's1',
        url: 'https://github.com/example/mine',
        comment: null,
        submittedAt: new Date('2026-02-04T00:00:00Z'),
      },
      {
        userId: THEIRS,
        courseId: 'course-secret',
        sessionKey: 's1',
        url: 'https://github.com/example/THEIRS',
        comment: null,
        submittedAt: new Date('2026-02-04T00:00:00Z'),
      },
    ],
    courseState: [
      {
        userId: MINE,
        courseId: 'course-docker',
        key: 'docker-course:state',
        value: { ticked: true },
        updatedAt: new Date('2026-02-05T00:00:00Z'),
      },
      {
        userId: THEIRS,
        courseId: 'course-secret',
        key: 'their:state',
        value: { secret: 'THEIR SAVED WORK' },
        updatedAt: new Date('2026-02-05T00:00:00Z'),
      },
    ],
    progressEvents: [
      {
        userId: MINE,
        courseId: 'course-docker',
        sessionKey: 's1',
        type: 'session.completed',
        at: new Date('2026-02-03T00:00:00Z'),
      },
      {
        userId: MINE,
        courseId: null,
        sessionKey: null,
        type: 'course.completed',
        at: new Date('2026-02-06T00:00:00Z'),
      },
      {
        userId: THEIRS,
        courseId: 'course-secret',
        sessionKey: 's1',
        type: 'session.completed',
        at: new Date('2026-02-03T00:00:00Z'),
      },
    ],
    oauth: [
      { userId: MINE, provider: 'github', createdAt: new Date('2026-01-02T00:00:00Z') },
      { userId: THEIRS, provider: 'github', createdAt: new Date('2026-01-02T00:00:00Z') },
    ],
  };

  /** Honours the `where.userId` it is given, so a missing one shows up. */
  const scoped = <T extends { userId: string }>(all: T[]) =>
    vi.fn(({ where }: { where?: { userId?: string } }) =>
      Promise.resolve(all.filter((row) => row.userId === where?.userId)),
    );

  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn(({ where }: { where: { id: string } }) => {
        const found = rows.users.find((u) => u.id === where.id);
        return found ? Promise.resolve(found) : Promise.reject(new Error('no such user'));
      }),
    },
    enrollment: { findMany: scoped(rows.enrollments) },
    sessionProgress: { findMany: scoped(rows.sessionProgress) },
    note: { findMany: scoped(rows.notes) },
    deliverable: { findMany: scoped(rows.deliverables) },
    courseState: { findMany: scoped(rows.courseState) },
    progressEvent: { findMany: scoped(rows.progressEvents) },
    oAuthAccount: { findMany: scoped(rows.oauth) },
  };

  const notes = {
    exportNotes: vi.fn((_userId: string, slug: string) =>
      Promise.resolve({ filename: `${slug}-notes.md`, markdown: `# Docker — notes\n` }),
    ),
  };

  return {
    service: new ExportService(
      prisma as unknown as PrismaService,
      notes as unknown as NotesService,
    ),
    prisma,
    notes,
  };
}

/** The zip's entries, as a reader sees them. */
async function read(archive: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('not a zip'));
        return;
      }

      const files = new Map<string, string>();
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('unreadable entry'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(files));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('ExportService', () => {
  it('contains nothing belonging to another learner', async () => {
    // The only test here that would matter if it failed.
    const { service } = makeService();

    const { archive } = await service.build(MINE);
    const whole = archive.toString('binary');
    const files = await read(archive);
    const text = [...files.values()].join('\n');

    for (const theirs of [
      'theirs@bud.local',
      'their-course',
      'THEIR PRIVATE NOTE',
      'THEIR SAVED WORK',
      'github.com/example/THEIRS',
    ]) {
      expect(text).not.toContain(theirs);
    }
    // Also not hiding in the uncompressed bytes anywhere.
    expect(whole).not.toContain('THEIR PRIVATE NOTE');
  });

  it('asks the database for one user and no more', async () => {
    const { service, prisma } = makeService();

    await service.build(MINE);

    // Every list query must carry the scope. A new table added to the export
    // without one would fail here rather than in production.
    for (const table of [
      prisma.enrollment,
      prisma.sessionProgress,
      prisma.note,
      prisma.deliverable,
      prisma.courseState,
      prisma.progressEvent,
      prisma.oAuthAccount,
    ]) {
      expect(table.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: MINE }) }),
      );
    }
  });

  it('holds the work that nothing else has a copy of', async () => {
    const { service } = makeService();

    const { archive } = await service.build(MINE);
    const files = await read(archive);
    const data = JSON.parse(files.get('bud-export.json')!) as {
      spec: string;
      you: { email: string; signInProviders: { provider: string }[] };
      courses: {
        slug: string;
        notes: { bodyMd: string }[];
        savedWork: { key: string; value: unknown }[];
        sessions: unknown[];
        deliverables: unknown[];
      }[];
      activity: { type: string; course: string | null }[];
    };

    expect(data.spec).toBe('bud-export/1');
    expect(data.you.email).toBe('mine@bud.local');
    expect(data.you.signInProviders).toEqual([
      { provider: 'github', linkedAt: '2026-01-02T00:00:00.000Z' },
    ]);

    const course = data.courses[0];
    expect(course.slug).toBe('docker-fundamentals');
    expect(course.notes[0].bodyMd).toContain('Containers are processes');
    // The blobs the worksheets saved: the irreplaceable part.
    expect(course.savedWork).toEqual([
      {
        key: 'docker-course:state',
        value: { ticked: true },
        updatedAt: '2026-02-05T00:00:00.000Z',
      },
    ]);
    expect(course.sessions).toHaveLength(1);
    expect(course.deliverables).toHaveLength(1);
    expect(data.activity).toHaveLength(2);
  });

  it('never puts an internal row id in the file', async () => {
    // A slug means something to a person; a uuid means something only to Bud,
    // and only inside it.
    const { service } = makeService();

    const files = await read((await service.build(MINE)).archive);

    expect(files.get('bud-export.json')).not.toContain('course-docker');
    expect(files.get('bud-export.json')).not.toContain(MINE);
  });

  it('names a course-level event by slug, and a course-less one not at all', async () => {
    const { service } = makeService();

    const files = await read((await service.build(MINE)).archive);
    const data = JSON.parse(files.get('bud-export.json')!) as {
      activity: { type: string; course: string | null }[];
    };

    expect(data.activity[0]).toMatchObject({
      type: 'session.completed',
      course: 'docker-fundamentals',
    });
    expect(data.activity[1]).toMatchObject({ type: 'course.completed', course: null });
  });

  it('includes the notes as Markdown, built by the same code as the Export link', async () => {
    const { service, notes } = makeService();

    const files = await read((await service.build(MINE)).archive);

    expect(notes.exportNotes).toHaveBeenCalledWith(MINE, 'docker-fundamentals');
    expect(files.get('notes/docker-fundamentals.md')).toContain('# Docker — notes');
  });

  it('says in the README what it deliberately left out', async () => {
    // An unqualified "all my data" would be a slightly false promise.
    const { service } = makeService();

    const files = await read((await service.build(MINE)).archive);
    const readme = files.get('README.md')!;

    expect(readme).toContain('deliberately not in here');
    expect(readme).toContain('Sign-in sessions');
    expect(readme).toContain('mine@bud.local');
  });

  it('names the file by the day it was taken', async () => {
    const { service } = makeService();

    const { filename } = await service.build(MINE);

    expect(filename).toMatch(/^bud-export-\d{4}-\d{2}-\d{2}\.zip$/);
  });

  it('writes no notes file for a course with no notes', async () => {
    // This learner is enrolled in two courses and has written in one. A file
    // called notes/just-enrolled.md would be an empty document pretending to be
    // a record.
    const { service } = makeService();

    const files = await read((await service.build(MINE)).archive);

    expect([...files.keys()].filter((name) => name.startsWith('notes/'))).toEqual([
      'notes/docker-fundamentals.md',
    ]);
  });

  it('still lists a course the learner has only enrolled in', async () => {
    const { service } = makeService();

    const files = await read((await service.build(MINE)).archive);
    const data = JSON.parse(files.get('bud-export.json')!) as {
      courses: { slug: string; notes: unknown[] }[];
    };

    expect(data.courses.map((course) => course.slug)).toEqual([
      'docker-fundamentals',
      'just-enrolled',
    ]);
    expect(data.courses[1].notes).toEqual([]);
  });
});
