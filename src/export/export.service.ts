import { Injectable } from '@nestjs/common';
import type { Buffer } from 'node:buffer';

import { zipFiles, type ZipEntry } from '../common/zip.js';
import { NotesService } from '../notes/notes.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Everything one learner owns, in one file they can keep.
 *
 * Bud holds work a learner did: what they typed into a worksheet, the notes they
 * wrote, what they handed in. A platform that holds that and cannot hand it back
 * is asking to be trusted without earning it, so this is a feature rather than a
 * favour.
 *
 * Grouped by course rather than dumped as tables, because the point is that a
 * person can read it. Internal row ids never appear: a course is its slug, a
 * session is its key, and neither means anything outside Bud that could be used
 * to correlate this file with anything else.
 *
 * Every query here is scoped to one user id. That is the whole correctness
 * property of this file, and it has a test that plants another learner's work
 * and proves none of it comes back.
 */
@Injectable()
export class ExportService {
  /** Bumped if the shape changes, so a reader can tell what it is looking at. */
  private static readonly SPEC = 'bud-export/1';

  constructor(
    private readonly prisma: PrismaService,
    private readonly notes: NotesService,
  ) {}

  async build(userId: string): Promise<{ filename: string; archive: Buffer }> {
    const exportedAt = new Date();
    const data = await this.collect(userId, exportedAt);

    const entries: ZipEntry[] = [
      { path: 'README.md', content: readme(data, exportedAt) },
      { path: 'bud-export.json', content: `${JSON.stringify(data, null, 2)}\n` },
    ];

    // The same Markdown the per-course export link produces, so a learner gets
    // one implementation of "my notes as a document" wherever they ask for it.
    for (const course of data.courses) {
      if (course.notes.length === 0) {
        continue;
      }
      const { markdown } = await this.notes.exportNotes(userId, course.slug);
      entries.push({ path: `notes/${course.slug}.md`, content: markdown });
    }

    return {
      filename: `bud-export-${exportedAt.toISOString().slice(0, 10)}.zip`,
      // A real timestamp here, unlike a course package: this file is a record of
      // a moment rather than a build to be reproduced.
      archive: await zipFiles(entries, { mtime: exportedAt }),
    };
  }

  private async collect(userId: string, exportedAt: Date): Promise<ExportData> {
    const [user, enrollments, progress, notes, deliverables, state, events, providers] =
      await Promise.all([
        this.prisma.user.findUniqueOrThrow({
          where: { id: userId },
          select: {
            email: true,
            name: true,
            avatarUrl: true,
            timezone: true,
            createdAt: true,
            role: true,
          },
        }),
        this.prisma.enrollment.findMany({
          where: { userId },
          include: { course: { select: { slug: true, title: true } } },
          orderBy: { startedAt: 'asc' },
        }),
        this.prisma.sessionProgress.findMany({ where: { userId } }),
        this.prisma.note.findMany({ where: { userId } }),
        this.prisma.deliverable.findMany({ where: { userId } }),
        this.prisma.courseState.findMany({ where: { userId } }),
        this.prisma.progressEvent.findMany({ where: { userId }, orderBy: { at: 'asc' } }),
        this.prisma.oAuthAccount.findMany({
          where: { userId },
          // The provider and when it was linked. Never the account id at that
          // provider, which identifies the person somewhere that is not Bud.
          select: { provider: true, createdAt: true },
        }),
      ]);

    // Row ids are internal, so everything is keyed by slug on the way out.
    const slugOf = new Map(enrollments.map((e) => [e.courseId, e.course.slug]));

    const courses = enrollments.map((enrollment) => {
      const mine = <T extends { courseId: string }>(rows: T[]) =>
        rows.filter((row) => row.courseId === enrollment.courseId);

      return {
        slug: enrollment.course.slug,
        title: enrollment.course.title,
        enrolledAt: enrollment.startedAt.toISOString(),
        lastOpenedAt: enrollment.lastOpenedAt?.toISOString() ?? null,
        completedAt: enrollment.completedAt?.toISOString() ?? null,
        unenrolledAt: enrollment.unenrolledAt?.toISOString() ?? null,
        sessions: mine(progress)
          .map((row) => ({
            sessionKey: row.sessionKey,
            status: row.status,
            fraction: row.fraction,
            startedAt: row.startedAt?.toISOString() ?? null,
            completedAt: row.completedAt?.toISOString() ?? null,
          }))
          .sort((a, b) => a.sessionKey.localeCompare(b.sessionKey, 'en')),
        notes: mine(notes)
          .map((note) => ({
            sessionKey: note.sessionKey,
            bodyMd: note.bodyMd,
            createdAt: note.createdAt.toISOString(),
            updatedAt: note.updatedAt.toISOString(),
          }))
          .sort((a, b) => a.sessionKey.localeCompare(b.sessionKey, 'en')),
        deliverables: mine(deliverables).map((deliverable) => ({
          sessionKey: deliverable.sessionKey,
          url: deliverable.url,
          comment: deliverable.comment,
          submittedAt: deliverable.submittedAt?.toISOString() ?? null,
        })),
        // The blobs the worksheets themselves saved — ticked boxes, typed
        // answers. The most irreplaceable thing in here.
        savedWork: mine(state).map((row) => ({
          key: row.key,
          value: row.value,
          updatedAt: row.updatedAt.toISOString(),
        })),
      };
    });

    return {
      spec: ExportService.SPEC,
      exportedAt: exportedAt.toISOString(),
      you: {
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        timezone: user.timezone,
        role: user.role,
        joinedAt: user.createdAt.toISOString(),
        signInProviders: providers.map((provider) => ({
          provider: provider.provider,
          linkedAt: provider.createdAt.toISOString(),
        })),
      },
      courses,
      activity: events.map((event) => ({
        at: event.at.toISOString(),
        type: event.type,
        course: event.courseId === null ? null : (slugOf.get(event.courseId) ?? null),
        sessionKey: event.sessionKey,
      })),
    };
  }
}

interface ExportData {
  spec: string;
  exportedAt: string;
  you: {
    email: string;
    name: string | null;
    avatarUrl: string | null;
    timezone: string;
    role: string;
    joinedAt: string;
    signInProviders: { provider: string; linkedAt: string }[];
  };
  courses: {
    slug: string;
    title: string;
    enrolledAt: string;
    lastOpenedAt: string | null;
    completedAt: string | null;
    unenrolledAt: string | null;
    sessions: unknown[];
    notes: { sessionKey: string; bodyMd: string }[];
    deliverables: unknown[];
    savedWork: unknown[];
  }[];
  activity: unknown[];
}

/**
 * What a person finds when they open the zip. It says what is *not* in here too,
 * because "export all my data" is a promise and an unqualified one would be a
 * slightly false one.
 */
function readme(data: ExportData, exportedAt: Date): string {
  return `# Your Bud data

Exported ${exportedAt.toISOString()} for ${data.you.email}.

- \`bud-export.json\` — everything below, machine-readable (\`${data.spec}\`).
- \`notes/\` — your notes per course, as Markdown, the same document the Export
  button on a course gives you.

## What is in the JSON

- **you** — your email, display name, timezone, when you joined, and which
  sign-in providers are linked. Not your password, which Bud only ever stored as
  a hash and cannot reverse.
- **courses** — one entry per course you enrolled in: when you started, what you
  finished, your notes, what you handed in, and **savedWork** — the blobs each
  worksheet saved, which is the part nothing else has a copy of.
- **activity** — every study event, in order. This is what the streak and the
  heatmap are drawn from.

## What is deliberately not in here

- **Sign-in sessions.** They are credentials, not records.
- **Your account ids at sign-in providers.** Those identify you somewhere that is
  not Bud, and exporting them would spread that rather than hand it back.
- **Course content.** The sessions you worked through belong to whoever wrote
  them; what you *did* in them is above.

${data.courses.length} course${data.courses.length === 1 ? '' : 's'}, ${data.courses.reduce((n, c) => n + c.notes.length, 0)} note${data.courses.reduce((n, c) => n + c.notes.length, 0) === 1 ? '' : 's'}, ${data.activity.length} activity event${data.activity.length === 1 ? '' : 's'}.
`;
}
