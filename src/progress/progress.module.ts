import { Module } from '@nestjs/common';

import { ActivityService } from './activity.service.js';
import { DashboardService } from './dashboard.service.js';
import { ProgressController } from './progress.controller.js';
import { ProgressService } from './progress.service.js';
import { StateService } from './state.service.js';

@Module({
  controllers: [ProgressController],
  providers: [ActivityService, DashboardService, ProgressService, StateService],
  exports: [StateService, ProgressService, ActivityService],
})
export class ProgressModule {}
