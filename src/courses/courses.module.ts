import { Module } from '@nestjs/common';

import { CourseSpecModule } from '../course-spec/course-spec.module.js';
import { AdminCoursesController } from './admin-courses.controller.js';
import { CoursesController } from './courses.controller.js';
import { PublishedVersions } from '../course-serving/published-versions.js';
import { CoursesService } from './courses.service.js';
import { IngestService } from './ingest.service.js';

@Module({
  imports: [CourseSpecModule],
  controllers: [CoursesController, AdminCoursesController],
  providers: [CoursesService, IngestService, PublishedVersions],
  exports: [CoursesService, IngestService, PublishedVersions],
})
export class CoursesModule {}
