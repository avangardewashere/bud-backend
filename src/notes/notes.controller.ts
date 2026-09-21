import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import type { RequestUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RateLimit, UserRateLimitGuard } from '../common/rate-limit/user-rate-limit.guard.js';
import { openApiSchema, zodBody } from '../common/validation/zod.pipe.js';
import { ref } from '../openapi/components.js';
import { NotesService } from './notes.service.js';

const saveNoteSchema = z.object({
  /** Markdown. An empty body deletes the note rather than storing emptiness. */
  bodyMd: z.string(),
});

const saveDeliverableSchema = z.object({
  /**
   * A link to a repo, a live site, a gist. Only http(s): a deliverable is
   * something the learner can open later, and javascript: or data: URLs would
   * be stored XSS waiting for whoever renders it.
   */
  url: z.url().refine((u) => /^https?:\/\//i.test(u), {
    message: 'Must be an http or https URL',
  }),
  comment: z.string().max(1000).optional(),
  /** Defaults to submitted. Pass false to retract without deleting the link. */
  submitted: z.boolean().optional(),
});

/**
 * Notes and deliverables: what the course asks the learner to produce.
 *
 * Notes autosave as someone types, so these sit behind the same per-user
 * allowance as the bridge rather than the global per-IP one.
 */
@ApiTags('me')
@ApiCookieAuth()
@Controller('me/courses/:slug')
@UseGuards(UserRateLimitGuard)
@RateLimit({ perMinute: 600, burst: 120 })
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get('notes')
  @ApiOperation({
    summary: 'Every note for a course, in session order',
    description: 'Sessions with no note are omitted rather than returned empty.',
  })
  @ApiOkResponse({ description: 'The notes.', schema: ref('NoteList') })
  @ApiForbiddenResponse({ description: 'Not enrolled.', schema: ref('ErrorResponse') })
  list(@CurrentUser() user: RequestUser, @Param('slug') slug: string) {
    return this.notes.listNotes(user.id, slug);
  }

  @Get('notes/export')
  @ApiOperation({
    summary: 'Every note as one markdown file',
    description:
      'Assembled here rather than in the shell: the ordering and the headings ' +
      'are the same decisions the list endpoint makes, and two implementations ' +
      'would drift.',
  })
  @ApiProduces('text/markdown')
  @ApiOkResponse({ description: 'A markdown document.' })
  @Header('Cache-Control', 'no-store')
  async export(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { filename, markdown } = await this.notes.exportNotes(user.id, slug);

    void reply
      .type('text/markdown; charset=utf-8')
      // Downloads as a file rather than rendering, which is what "export" means.
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(markdown);
  }

  @Get('sessions/:key/notes')
  @ApiOperation({ summary: 'The note for one session' })
  @ApiOkResponse({ description: 'The note, or null when there is none.', schema: ref('Note') })
  @ApiNotFoundResponse({ description: 'unknown_session.', schema: ref('ErrorResponse') })
  get(@CurrentUser() user: RequestUser, @Param('slug') slug: string, @Param('key') key: string) {
    return this.notes.getNote(user.id, slug, key);
  }

  @Put('sessions/:key/notes')
  @ApiOperation({
    summary: 'Write the note for one session',
    description: 'Whole value, like the bridge. An empty body deletes the note.',
  })
  @ApiBody({ schema: openApiSchema(saveNoteSchema) })
  @ApiOkResponse({ description: 'The saved note, or null if it was cleared.', schema: ref('Note') })
  save(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
    @Param('key') key: string,
    @Body(zodBody(saveNoteSchema)) body: z.infer<typeof saveNoteSchema>,
  ) {
    return this.notes.saveNote(user.id, slug, key, body.bodyMd);
  }

  @Delete('sessions/:key/notes')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete the note for one session' })
  @ApiNoContentResponse({ description: 'Gone.' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
    @Param('key') key: string,
  ): Promise<void> {
    await this.notes.deleteNote(user.id, slug, key);
  }

  // ── deliverables ──────────────────────────────────────────────────────────

  @Get('deliverables')
  @ApiOperation({
    summary: 'What the learner has submitted for this course',
    description: 'No grading — "submitted" is the learner’s own claim.',
  })
  @ApiOkResponse({ description: 'The deliverables.', schema: ref('DeliverableList') })
  listDeliverables(@CurrentUser() user: RequestUser, @Param('slug') slug: string) {
    return this.notes.listDeliverables(user.id, slug);
  }

  @Put('sessions/:key/deliverable')
  @ApiOperation({
    summary: 'Submit or update a deliverable',
    description: 'Pass submitted:false to retract without losing the link.',
  })
  @ApiBody({ schema: openApiSchema(saveDeliverableSchema) })
  @ApiOkResponse({ description: 'The deliverable.', schema: ref('Deliverable') })
  saveDeliverable(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
    @Param('key') key: string,
    @Body(zodBody(saveDeliverableSchema)) body: z.infer<typeof saveDeliverableSchema>,
  ) {
    return this.notes.saveDeliverable(user.id, slug, key, body);
  }

  @Delete('sessions/:key/deliverable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a deliverable entirely' })
  @ApiNoContentResponse({ description: 'Gone.' })
  async removeDeliverable(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
    @Param('key') key: string,
  ): Promise<void> {
    await this.notes.deleteDeliverable(user.id, slug, key);
  }
}
