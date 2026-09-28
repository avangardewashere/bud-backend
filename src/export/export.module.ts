import { Module } from '@nestjs/common';

import { NotesModule } from '../notes/notes.module.js';
import { ExportController } from './export.controller.js';
import { ExportService } from './export.service.js';

/**
 * Imports NotesModule for its Markdown builder, so a learner's notes read the
 * same whether they come from the export or from a course's own Export link.
 */
@Module({
  imports: [NotesModule],
  controllers: [ExportController],
  providers: [ExportService],
})
export class ExportModule {}
