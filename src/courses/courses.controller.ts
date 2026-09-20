import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { zodBody } from '../common/validation/zod.pipe.js';
import { ref } from '../openapi/components.js';
import { CoursesService } from './courses.service.js';
import { listQuerySchema, type ListQuery } from './dto/course.schemas.js';

@ApiTags('courses')
@ApiCookieAuth()
@Controller('courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  @ApiOperation({
    summary: 'The catalog',
    description:
      'Published courses only, newest last. Includes the caller’s progress for ' +
      'any course they are enrolled in.',
  })
  @ApiQuery({ name: 'cursor', required: false, description: 'From the previous nextCursor.' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', default: 20 } })
  @ApiOkResponse({ description: 'A page of published courses.', schema: ref('CourseList') })
  list(@CurrentUser() user: RequestUser, @Query(zodBody(listQuerySchema)) query: ListQuery) {
    return this.courses.list(user.id, query);
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'One course, with its outline and session list',
    description: 'Unpublished courses are indistinguishable from missing ones.',
  })
  @ApiOkResponse({ description: 'The course.', schema: ref('CourseDetail') })
  @ApiNotFoundResponse({ description: 'No published course with that slug.' })
  detail(@CurrentUser() user: RequestUser, @Param('slug') slug: string) {
    return this.courses.detail(user.id, slug);
  }

  @Post(':slug/enroll')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enrol in a course',
    description: 'Idempotent, and re-enrolling after leaving resumes rather than resets.',
  })
  @ApiOkResponse({ description: 'Enrolled.', schema: ref('ProgressSummary') })
  @ApiNotFoundResponse({ description: 'No published course with that slug.' })
  enroll(@CurrentUser() user: RequestUser, @Param('slug') slug: string) {
    return this.courses.enroll(user.id, slug);
  }

  @Delete(':slug/enroll')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Leave a course',
    description: 'Keeps progress, so re-enrolling picks up where it left off.',
  })
  @ApiNoContentResponse({ description: 'No longer enrolled.' })
  async unenroll(@CurrentUser() user: RequestUser, @Param('slug') slug: string): Promise<void> {
    await this.courses.unenroll(user.id, slug);
  }
}
