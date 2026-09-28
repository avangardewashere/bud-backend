import { Controller, Get, Header, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import type { RequestUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RateLimit, UserRateLimitGuard } from '../common/rate-limit/user-rate-limit.guard.js';
import { ExportService } from './export.service.js';

/**
 * Taking your work with you.
 *
 * Its own controller rather than another method on the dashboard's, because it
 * needs a rate limit of its own: this is the only endpoint that reads everything
 * a learner owns in one go, and it is the only one where a handful a minute is
 * generous rather than stingy.
 */
@ApiTags('me')
@ApiCookieAuth()
@Controller('me')
@UseGuards(UserRateLimitGuard)
// One export reads every row a learner owns and buffers a zip. Nobody needs a
// second one four seconds later, and a loop over this endpoint is the cheapest
// way to make the API do the most work.
@RateLimit({ perMinute: 6, burst: 3 })
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  @Get('export')
  @ApiOperation({
    summary: 'Everything you own, as a zip',
    description:
      'A JSON document with your profile, courses, progress, notes, ' +
      'deliverables, the blobs the worksheets saved and your whole activity ' +
      'history, plus your notes as Markdown per course, plus a README saying ' +
      'what is in it and what is deliberately left out. Sign-in sessions and ' +
      'your account ids at sign-in providers are not included.',
  })
  @ApiProduces('application/zip')
  @ApiOkResponse({ description: 'A zip archive.' })
  @Header('Cache-Control', 'no-store')
  async export(@CurrentUser() user: RequestUser, @Res() reply: FastifyReply): Promise<void> {
    const { filename, archive } = await this.exports.build(user.id);

    void reply
      .type('application/zip')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(archive);
  }
}
