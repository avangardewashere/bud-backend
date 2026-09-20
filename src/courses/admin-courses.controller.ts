import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Buffer } from 'node:buffer';

import type { AuthenticatedRequest, RequestUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { openApiSchema, zodBody } from '../common/validation/zod.pipe.js';
import { DEFAULT_ARCHIVE_LIMITS } from '../course-spec/archive.js';
import { ref } from '../openapi/components.js';
import { PrismaService } from '../prisma/index.js';
import { IngestService } from './ingest.service.js';
import {
  listQuerySchema,
  updateCourseSchema,
  type ListQuery,
  type UpdateCourseInput,
} from './dto/course.schemas.js';

/**
 * Course management. The only admin surface Phase 1 builds: the owner decided
 * (Overall Plan §8.1) that there is no learner two yet, so there is no user
 * administration to go with it.
 */
@ApiTags('admin')
@ApiCookieAuth()
@Roles('admin')
@Controller('admin/courses')
export class AdminCoursesController {
  constructor(
    private readonly ingest: IngestService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a course package',
    description:
      'Validates the zip and, if it passes, stores its files and creates a **draft** ' +
      'version. Publishing is a separate, deliberate step. A failed validation returns ' +
      '200 with ok=false and the checklist — the upload worked, the package did not.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiCreatedResponse({ description: 'Package accepted.', schema: ref('IngestResult') })
  @ApiBadRequestResponse({ description: 'No file, or that version already exists.' })
  @ApiForbiddenResponse({ description: 'Not an admin.' })
  async upload(@Req() request: AuthenticatedRequest, @CurrentUser() user: RequestUser) {
    const file = await request.file({
      limits: { fileSize: DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes, files: 1 },
    });

    if (!file) {
      throw new BadRequestException('Attach the course package as "file".');
    }

    const archive = await file.toBuffer();

    // Fastify truncates at the limit rather than throwing, so the flag is the
    // only honest signal that the upload was cut short.
    if (file.file.truncated) {
      throw new BadRequestException(
        `Package exceeds the ${DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes / (1024 * 1024)} MB limit.`,
      );
    }

    const result = await this.ingest.ingest(Buffer.from(archive), user.id);

    return {
      ok: result.report.ok,
      results: result.report.results,
      course: result.course
        ? {
            id: result.course.id,
            slug: result.course.slug,
            title: result.course.title,
            status: result.course.status,
            version: result.version?.version ?? null,
            filesStored: result.filesStored ?? 0,
          }
        : null,
    };
  }

  @Get()
  @ApiOperation({ summary: 'Every course, including drafts and archived ones' })
  @ApiOkResponse({ description: 'A page of courses.', schema: ref('AdminCourseList') })
  async list(@Query(zodBody(listQuerySchema)) query: ListQuery) {
    const rows = await this.prisma.course.findMany({
      where: { deletedAt: null },
      include: {
        currentVersion: true,
        _count: { select: { versions: true, enrollments: true } },
      },
      orderBy: { id: 'asc' },
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);

    return {
      courses: page.map((course) => ({
        id: course.id,
        slug: course.slug,
        title: course.title,
        status: course.status,
        currentVersion: course.currentVersion?.version ?? null,
        versionCount: course._count.versions,
        enrollmentCount: course._count.enrollments,
        createdAt: course.createdAt.toISOString(),
        updatedAt: course.updatedAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit ? page[page.length - 1].id : null,
    };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Publish, unpublish, archive, or point at a different version',
    description:
      'Publishing requires a version to publish: a course with no versions has ' +
      'nothing to show a learner.',
  })
  @ApiBody({ schema: openApiSchema(updateCourseSchema) })
  @ApiOkResponse({ description: 'The updated course.', schema: ref('AdminCourse') })
  async update(
    @Param('id') id: string,
    @Body(zodBody(updateCourseSchema)) body: UpdateCourseInput,
  ) {
    const course = await this.prisma.course.findFirst({
      where: { id, deletedAt: null },
      include: { versions: true, _count: { select: { versions: true, enrollments: true } } },
    });

    if (!course) {
      throw new NotFoundException('No such course.');
    }

    let currentVersionId = course.currentVersionId;

    if (body.currentVersion) {
      const target = course.versions.find((v) => v.version === body.currentVersion);
      if (!target) {
        throw new BadRequestException(`"${course.slug}" has no version ${body.currentVersion}.`);
      }
      currentVersionId = target.id;
    }

    // Publishing without a version would put a course in the catalog that
    // cannot be opened.
    if (body.status === 'published' && !currentVersionId) {
      const latest = course.versions.at(-1);
      if (!latest) {
        throw new BadRequestException(
          `"${course.slug}" has no versions yet. Upload a package before publishing.`,
        );
      }
      currentVersionId = latest.id;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (currentVersionId && currentVersionId !== course.currentVersionId) {
        await tx.courseVersion.update({
          where: { id: currentVersionId },
          data: { publishedAt: new Date() },
        });
      }

      return tx.course.update({
        where: { id },
        data: {
          ...(body.status ? { status: body.status } : {}),
          ...(currentVersionId ? { currentVersionId } : {}),
        },
        include: {
          currentVersion: true,
          _count: { select: { versions: true, enrollments: true } },
        },
      });
    });

    return {
      id: updated.id,
      slug: updated.slug,
      title: updated.title,
      status: updated.status,
      currentVersion: updated.currentVersion?.version ?? null,
      versionCount: updated._count.versions,
      enrollmentCount: updated._count.enrollments,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }
}
