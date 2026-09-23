import { Module } from '@nestjs/common';

import { DemoService } from './demo.service.js';

/**
 * The public demo account. Exported rather than routed here: signing in is the
 * auth module's job, and the demo only decides *who* is signed in.
 */
@Module({
  providers: [DemoService],
  exports: [DemoService],
})
export class DemoModule {}
