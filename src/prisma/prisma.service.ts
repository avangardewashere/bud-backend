import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { AppConfigService } from '../config/app-config.service.js';

/**
 * Prisma 7 has no Rust query engine and no datasource URL in the schema: the
 * connection is supplied by a driver adapter built here, from validated config.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL'),
        // node-postgres waits forever for a connection by default. A database
        // that scales to zero (Neon's free tier suspends after five idle
        // minutes) takes a few seconds to resume, and one whose quota is spent
        // never does — a request should fail and say so, not hang. Generous
        // enough for a cold resume.
        connectionTimeoutMillis: 15_000,
      }),
      log: config.isProduction ? ['warn', 'error'] : ['query', 'warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Cheap dependency check for the readiness endpoint. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
