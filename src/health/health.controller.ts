import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

type CheckState = 'ok' | 'error';

@ApiTags('health')
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Liveness. Deliberately checks nothing external: if this fails the process
   * is broken and should be restarted. A dead database is not a reason to
   * restart — restarting fixes nothing and turns an outage into a crash loop.
   */
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ description: 'Process is up.' })
  health() {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  /**
   * Readiness. Checks the dependencies needed to serve traffic, so a load
   * balancer can take this instance out of rotation without killing it.
   *
   * Only the database decides readiness. Object storage is reported but not
   * fatal: without it course *content* cannot be served, while signing in, the
   * catalog, progress and the whole bridge still work. Taking the instance out
   * of rotation for a degraded subsystem would turn a partial outage into a
   * total one — but leaving it unreported would hide it, so monitoring gets the
   * detail even though the probe stays green.
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiOkResponse({ description: 'Ready to serve traffic.' })
  @ApiServiceUnavailableResponse({ description: 'A required dependency is unavailable.' })
  async ready() {
    const [database, storage] = await Promise.all([
      check(() => this.prisma.ping()),
      check(() => this.storage.ping()),
    ]);

    const checks: Record<string, CheckState> = { database, storage };

    if (database === 'error') {
      throw new ServiceUnavailableException({ status: 'error', checks });
    }

    return {
      status: storage === 'ok' ? 'ok' : 'degraded',
      checks,
    };
  }
}

async function check(probe: () => Promise<unknown>): Promise<CheckState> {
  try {
    await probe();
    return 'ok';
  } catch {
    return 'error';
  }
}
