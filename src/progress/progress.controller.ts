import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';

import type { RequestUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RateLimit, UserRateLimitGuard } from '../common/rate-limit/user-rate-limit.guard.js';
import { openApiSchema, zodBody } from '../common/validation/zod.pipe.js';
import { ref } from '../openapi/components.js';
import { ActivityService } from './activity.service.js';
import { activityQuerySchema } from './dto/progress.schemas.js';
import { DashboardService } from './dashboard.service.js';
import { ProgressService } from './progress.service.js';
import { StateService } from './state.service.js';

const setStateSchema = z.object({
  /**
   * Opaque to the platform. The course decides what this means.
   *
   * Deliberately unbounded here. A zod `.max()` counts *characters*, not bytes,
   * so it would disagree with the service's `Buffer.byteLength` check about what
   * 1 MiB means the moment a learner types a non-ASCII character — and it would
   * shadow it, returning 400 validation_failed instead of the agreed 413
   * storage_value_too_large. One check, in bytes, in the service. Fastify's
   * bodyLimit is the backstop for anything absurd.
   */
  value: z.string(),
});

const fractionSchema = z.object({
  fraction: z.number().min(0).max(1),
});

/**
 * Everything the player needs: the learner's dashboard, their progress through
 * a course, and the storage bridge the course itself talks to.
 *
 * These are the hottest endpoints in the API — the worksheets debounce at
 * 400 ms and save on nearly every keystroke — which is why they have their own
 * rate limit rather than sharing the global one.
 */
@ApiTags('me')
@ApiCookieAuth()
@Controller('me')
@UseGuards(UserRateLimitGuard)
// Sized for the bridge, not for ordinary API traffic: the worksheets debounce
// at 400 ms, so a learner typing sustains roughly 2.5 writes a second. 600/min
// is twice that with a burst allowance on top, which a real learner will not
// reach and a course looping over writes will.
@RateLimit({ perMinute: 600, burst: 120 })
export class ProgressController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly progress: ProgressService,
    private readonly state: StateService,
    private readonly activity: ActivityService,
  ) {}

  @Get('dashboard')
  @ApiOperation({
    summary: 'Everything the learner is working on',
    description:
      'One round trip on purpose: this is the first screen after sign-in, and ' +
      'assembling it from three calls would let the slowest decide how the app feels.',
  })
  @ApiOkResponse({ description: 'The dashboard.', schema: ref('Dashboard') })
  getDashboard(@CurrentUser() user: RequestUser) {
    return this.dashboard.forUser(user.id);
  }

  @Get('activity')
  @ApiOperation({
    summary: 'Streaks and the activity heatmap',
    description:
      'Days are cut in the timezone the learner set, so an evening session counts ' +
      'for the evening it happened in. Signing in is not activity: only studying ' +
      'keeps a streak alive.',
  })
  @ApiOkResponse({ description: 'Activity for the requested window.', schema: ref('Activity') })
  getActivity(
    @CurrentUser() user: RequestUser,
    @Query(zodBody(activityQuerySchema)) query: { weeks: number },
  ) {
    return this.activity.forUser(user.id, query.weeks);
  }

  // ── the storage bridge ────────────────────────────────────────────────────

  @Get('courses/:slug/state/:key')
  @ApiOperation({
    summary: 'bridge: storage.get',
    description:
      'A key that was never written returns `{ value: null }` rather than 404, ' +
      'because that is the shape the existing worksheets already handle.',
  })
  @ApiParam({ name: 'key', description: 'Opaque course-chosen key.' })
  @ApiOkResponse({ description: 'The stored value, or null.', schema: ref('StateValue') })
  @ApiForbiddenResponse({ description: 'Not enrolled.', schema: ref('ErrorResponse') })
  getState(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
    @Param('key') key: string,
  ) {
    return this.state.get(user.id, slug, key);
  }

  @Put('courses/:slug/state/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'bridge: storage.set',
    description:
      'Whole value, last write wins — no partial patches. Keys the manifest did ' +
      'not declare are accepted: rejecting would punish the learner for the ' +
      'author’s mistake, since the worksheet turns a rejection into a small ' +
      '"not saved" flash that is easy to miss.',
  })
  @ApiBody({ schema: openApiSchema(setStateSchema) })
  @ApiNoContentResponse({ description: 'Saved.' })
  @ApiForbiddenResponse({ description: 'Not enrolled.', schema: ref('ErrorResponse') })
  @ApiConflictResponse({
    description: 'storage_key_limit_reached — too many distinct keys.',
    schema: ref('ErrorResponse'),
  })
  @ApiPayloadTooLargeResponse({
    description: 'storage_value_too_large, or storage_quota_exceeded.',
    schema: ref('ErrorResponse'),
  })
  async setState(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
    @Param('key') key: string,
    @Body(zodBody(setStateSchema)) body: z.infer<typeof setStateSchema>,
  ): Promise<void> {
    await this.state.set(user.id, slug, key, body.value);
  }

  @Delete('courses/:slug/state/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'bridge: storage.delete',
    description:
      'Every worksheet’s "Clear saved work" calls this. Deleting a key that was ' +
      'never there succeeds — the caller wanted it gone, and it is gone.',
  })
  @ApiNoContentResponse({ description: 'Gone.' })
  async deleteState(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
    @Param('key') key: string,
  ): Promise<void> {
    await this.state.delete(user.id, slug, key);
  }

  // ── progress ──────────────────────────────────────────────────────────────

  @Get('courses/:slug/progress')
  @ApiOperation({ summary: 'Progress through every session of a course' })
  @ApiOkResponse({ description: 'Per-session progress.', schema: ref('SessionProgressList') })
  sessions(@CurrentUser() user: RequestUser, @Param('slug') slug: string) {
    return this.progress.sessionsFor(user.id, slug);
  }

  @Post('courses/:slug/sessions/:key/open')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The learner opened a session',
    description: 'Drives "continue where you left off". Never un-completes a finished session.',
  })
  @ApiOkResponse({ description: 'Updated progress.', schema: ref('SessionProgress') })
  @ApiNotFoundResponse({ description: 'unknown_session.', schema: ref('ErrorResponse') })
  open(@CurrentUser() user: RequestUser, @Param('slug') slug: string, @Param('key') key: string) {
    return this.progress.open(user.id, slug, key);
  }

  @Post('courses/:slug/sessions/:key/progress')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'bridge: bud.progress',
    description: 'Optional fine-grained progress. Never moves backwards.',
  })
  @ApiBody({ schema: openApiSchema(fractionSchema) })
  @ApiOkResponse({ description: 'Updated progress.', schema: ref('SessionProgress') })
  setFraction(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
    @Param('key') key: string,
    @Body(zodBody(fractionSchema)) body: z.infer<typeof fractionSchema>,
  ) {
    return this.progress.setFraction(user.id, slug, key, body.fraction);
  }

  @Post('courses/:slug/sessions/:key/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'bridge: bud.complete',
    description:
      'The course suggests completion; the shell records it. Shell state is the ' +
      'source of truth and is never synced back into the course’s own blob.',
  })
  @ApiOkResponse({ description: 'Updated progress.', schema: ref('SessionProgress') })
  complete(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
    @Param('key') key: string,
  ) {
    return this.progress.complete(user.id, slug, key);
  }

  @Delete('courses/:slug/sessions/:key/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reopen a session marked complete by mistake' })
  @ApiOkResponse({ description: 'Updated progress.', schema: ref('SessionProgress') })
  uncomplete(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
    @Param('key') key: string,
  ) {
    return this.progress.uncomplete(user.id, slug, key);
  }
}
