import { Module } from '@nestjs/common';

import { CourseSpecController } from './course-spec.controller.js';
import { CourseSpecService } from './course-spec.service.js';

@Module({
  controllers: [CourseSpecController],
  providers: [CourseSpecService],
  exports: [CourseSpecService],
})
export class CourseSpecModule {}
