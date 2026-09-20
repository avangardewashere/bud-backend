import { Module } from '@nestjs/common';

import { DashboardService } from './dashboard.service.js';
import { ProgressController } from './progress.controller.js';
import { ProgressService } from './progress.service.js';
import { StateService } from './state.service.js';

@Module({
  controllers: [ProgressController],
  providers: [DashboardService, ProgressService, StateService],
  exports: [StateService, ProgressService],
})
export class ProgressModule {}
