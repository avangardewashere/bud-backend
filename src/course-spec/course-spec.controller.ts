import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { Public } from '../auth/decorators/public.decorator.js';
import { ALLOWED_EXTENSIONS } from './course-spec.service.js';
import { DEFAULT_ARCHIVE_LIMITS } from './archive.js';
import { manifestSchema } from './manifest.schema.js';
import { VALIDATION_CODES } from './validation.types.js';

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
  /** Generated once: the schema cannot change at runtime. */
  private readonly jsonSchema = z.toJSONSchema(manifestSchema, {
    io: 'input',
    target: 'draft-2020-12',
  });

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
    return {
      spec: 'bud-course/1',
      manifestFilename: 'bud.manifest.json',
      schema: this.jsonSchema,
      limits: {
        maxArchiveBytes: DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes,
        maxTotalUncompressedBytes: DEFAULT_ARCHIVE_LIMITS.maxTotalUncompressedBytes,
        maxEntries: DEFAULT_ARCHIVE_LIMITS.maxEntries,
      },
      allowedExtensions: [...ALLOWED_EXTENSIONS].sort(),
      // Published so the panel can key its hints off codes it knows about and
      // degrade gracefully for ones added later.
      validationCodes: [...VALIDATION_CODES],
    };
  }
}
