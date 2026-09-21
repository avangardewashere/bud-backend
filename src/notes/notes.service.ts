import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Buffer } from 'node:buffer';

import { AppException } from '../common/errors/app-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { demoteHeadings } from './markdown.js';

export interface NoteView {
  sessionKey: string;
  sessionTitle: string | null;
  sessionOrder: number | null;
  bodyMd: string;
  updatedAt: string;
}

export interface DeliverableView {
  sessionKey: string;
  sessionTitle: string | null;
  /** What the manifest asked for, so the UI can show the ask beside the answer. */
  asked: string | null;
  url: string;
  comment: string | null;
  submittedAt: string | null;
  updatedAt: string;
}

/**
 * Notes and deliverables — what the course already asks people to produce.
 *
 * Every Docker session ends with "write notes.md" and names a deliverable, so
 * this is the platform holding work the learner is being asked for anyway
 * rather than inventing a new thing to fill in.
 *
 * There is **no grading**. A deliverable is submitted when the learner says so
 * and retracted when they say so; nothing here judges it, and no one else can
 * see it (Overall Plan §5.7).
 */
@Injectable()
export class NotesService {
  /**
   * A note is markdown a person typed, so the cap is generous — but unbounded
   * text in a database is how a table becomes unqueryable. 256 KiB is a very
   * long note and a very small row.
   */
  static readonly MAX_NOTE_BYTES = 256 * 1024;
  static readonly MAX_URL_LENGTH = 2048;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the course and checks enrolment, and returns the session titles
   * so notes can be shown against the session they belong to.
   */
  private async courseFor(userId: string, slug: string) {
    const course = await this.prisma.course.findFirst({
      where: { slug, deletedAt: null },
      include: { currentVersion: { include: { sessions: { orderBy: { order: 'asc' } } } } },
    });

    if (!course) {
      throw new NotFoundException(`No course "${slug}".`);
    }

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId: course.id } },
      select: { unenrolledAt: true },
    });

    if (!enrollment || enrollment.unenrolledAt) {
      throw new AppException(
        'not_enrolled',
        'You are not enrolled in this course.',
        HttpStatus.FORBIDDEN,
      );
    }

    return course;
  }

  private assertKnownSession(
    course: { currentVersion: { sessions: { key: string }[] } | null },
    sessionKey: string,
  ): void {
    if (!course.currentVersion?.sessions.some((s) => s.key === sessionKey)) {
      throw new AppException(
        'unknown_session',
        `"${sessionKey}" is not a session of this course.`,
        HttpStatus.NOT_FOUND,
      );
    }
  }

  // ── notes ─────────────────────────────────────────────────────────────────

  async getNote(userId: string, slug: string, sessionKey: string): Promise<NoteView | null> {
    const course = await this.courseFor(userId, slug);
    this.assertKnownSession(course, sessionKey);

    const note = await this.prisma.note.findUnique({
      where: { userId_courseId_sessionKey: { userId, courseId: course.id, sessionKey } },
    });

    if (!note) {
      return null;
    }

    const session = course.currentVersion?.sessions.find((s) => s.key === sessionKey);

    return {
      sessionKey,
      sessionTitle: session?.title ?? null,
      sessionOrder: session?.order ?? null,
      bodyMd: note.bodyMd,
      updatedAt: note.updatedAt.toISOString(),
    };
  }

  /**
   * Saves a note. An empty body deletes it rather than storing emptiness —
   * a note the learner cleared should not keep appearing in the export.
   */
  async saveNote(
    userId: string,
    slug: string,
    sessionKey: string,
    bodyMd: string,
  ): Promise<NoteView | null> {
    const course = await this.courseFor(userId, slug);
    this.assertKnownSession(course, sessionKey);

    const bytes = Buffer.byteLength(bodyMd, 'utf8');
    if (bytes > NotesService.MAX_NOTE_BYTES) {
      throw new AppException(
        'storage_value_too_large',
        'That note is too long to save.',
        HttpStatus.PAYLOAD_TOO_LARGE,
        `${Math.round(bytes / 1024)} KB exceeds the ${NotesService.MAX_NOTE_BYTES / 1024} KB limit for one note.`,
      );
    }

    if (bodyMd.trim() === '') {
      await this.deleteNote(userId, slug, sessionKey);
      return null;
    }

    await this.prisma.note.upsert({
      where: { userId_courseId_sessionKey: { userId, courseId: course.id, sessionKey } },
      create: { userId, courseId: course.id, sessionKey, bodyMd },
      update: { bodyMd },
    });

    return this.getNote(userId, slug, sessionKey);
  }

  async deleteNote(userId: string, slug: string, sessionKey: string): Promise<void> {
    const course = await this.courseFor(userId, slug);

    await this.prisma.note
      .delete({
        where: { userId_courseId_sessionKey: { userId, courseId: course.id, sessionKey } },
      })
      .catch(() => undefined);
  }

  /** Every note for a course, in session order rather than by when it was written. */
  async listNotes(userId: string, slug: string): Promise<NoteView[]> {
    const course = await this.courseFor(userId, slug);

    const notes = await this.prisma.note.findMany({
      where: { userId, courseId: course.id },
    });

    const byKey = new Map(notes.map((n) => [n.sessionKey, n]));

    return (course.currentVersion?.sessions ?? [])
      .filter((session) => byKey.has(session.key))
      .map((session) => {
        const note = byKey.get(session.key)!;
        return {
          sessionKey: session.key,
          sessionTitle: session.title,
          sessionOrder: session.order,
          bodyMd: note.bodyMd,
          updatedAt: note.updatedAt.toISOString(),
        };
      });
  }

  /**
   * Every note for a course as one markdown document (§5.7).
   *
   * Assembled here rather than in the shell because the ordering, the headings
   * and the "which sessions have nothing" decision are the same questions the
   * list endpoint answers, and two implementations would drift.
   */
  async exportNotes(userId: string, slug: string): Promise<{ filename: string; markdown: string }> {
    const course = await this.courseFor(userId, slug);
    const notes = await this.listNotes(userId, slug);

    const lines = [`# ${course.title} — notes`, ''];

    if (notes.length === 0) {
      lines.push('_No notes yet._', '');
    }

    for (const note of notes) {
      lines.push(`## ${note.sessionOrder}. ${note.sessionTitle ?? note.sessionKey}`, '');
      // Notes.md files start with their own `# Session 1`, which would put an
      // H1 inside an H2 and give the document two competing titles. Shift the
      // note's own headings beneath the session heading so there is one
      // outline. Code fences are left alone — see demoteHeadings.
      lines.push(demoteHeadings(note.bodyMd.trimEnd(), 2), '');
    }

    return {
      filename: `${course.slug}-notes.md`,
      markdown: lines.join('\n'),
    };
  }

  // ── deliverables ──────────────────────────────────────────────────────────

  async listDeliverables(userId: string, slug: string): Promise<DeliverableView[]> {
    const course = await this.courseFor(userId, slug);

    const rows = await this.prisma.deliverable.findMany({
      where: { userId, courseId: course.id },
    });

    const byKey = new Map(rows.map((d) => [d.sessionKey, d]));

    return (course.currentVersion?.sessions ?? [])
      .filter((session) => byKey.has(session.key))
      .map((session) => this.toView(byKey.get(session.key)!, session));
  }

  async saveDeliverable(
    userId: string,
    slug: string,
    sessionKey: string,
    input: { url: string; comment?: string; submitted?: boolean },
  ): Promise<DeliverableView> {
    const course = await this.courseFor(userId, slug);
    this.assertKnownSession(course, sessionKey);

    if (input.url.length > NotesService.MAX_URL_LENGTH) {
      throw new AppException('validation_failed', 'That link is too long.', HttpStatus.BAD_REQUEST);
    }

    const submittedAt = input.submitted === false ? null : new Date();

    const row = await this.prisma.deliverable.upsert({
      where: { userId_courseId_sessionKey: { userId, courseId: course.id, sessionKey } },
      create: {
        userId,
        courseId: course.id,
        sessionKey,
        url: input.url,
        comment: input.comment,
        submittedAt,
      },
      update: { url: input.url, comment: input.comment, submittedAt },
    });

    await this.prisma.progressEvent.create({
      data: {
        userId,
        courseId: course.id,
        sessionKey,
        type: submittedAt ? 'deliverable.submitted' : 'deliverable.retracted',
      },
    });

    const session = course.currentVersion?.sessions.find((s) => s.key === sessionKey);
    return this.toView(row, session);
  }

  async deleteDeliverable(userId: string, slug: string, sessionKey: string): Promise<void> {
    const course = await this.courseFor(userId, slug);

    await this.prisma.deliverable
      .delete({
        where: { userId_courseId_sessionKey: { userId, courseId: course.id, sessionKey } },
      })
      .catch(() => undefined);
  }

  private toView(
    row: {
      sessionKey: string;
      url: string;
      comment: string | null;
      submittedAt: Date | null;
      updatedAt: Date;
    },
    session?: { title: string; deliverable: string | null },
  ): DeliverableView {
    return {
      sessionKey: row.sessionKey,
      sessionTitle: session?.title ?? null,
      asked: session?.deliverable ?? null,
      url: row.url,
      comment: row.comment,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
