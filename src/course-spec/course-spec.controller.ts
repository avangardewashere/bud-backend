import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator.js';
import { courseSpecDocument } from './spec-document.js';

/**
 * Publishes the course package spec so the admin panel can show which fields
 * are required without re-implementing any checking, and so course authors have
 * something to validate against locally.
 *
 * This is the shared artefact agreed with the shell: the backend owns the
 * rules, and this is the machine-readable description of them.
 */
@ApiTags('course-spec')
@Controller('course-spec')
export class CourseSpecController {
  @Public()
  @Get('schema')
  @ApiOperation({
    summary: 'The bud.manifest.json JSON Schema',
    description:
      'JSON Schema (draft 2020-12) for spec bud-course/1, plus the limits and ' +
      'validation codes the uploader enforces.',
  })
  @ApiOkResponse({ description: 'The manifest schema and the limits that go with it.' })
  schema() {
    // The same document `bud-course spec` prints, so an author working offline
    // and the panel reading this route cannot be told different things.
    return courseSpecDocument();
  }
}
