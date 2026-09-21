import { Module } from '@nestjs/common';

import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

@Module({
  controllers: [NotesController],
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
