import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from './env.schema.js';

/**
 * Typed accessor over the validated environment. Inject this, never ConfigService
 * directly, so config shape stays discoverable and refactorable.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get isDevelopment(): boolean {
    return this.get('NODE_ENV') === 'development';
  }

  get isTest(): boolean {
    return this.get('NODE_ENV') === 'test';
  }

  /** Origins allowed to call this API with credentials. */
  get corsOrigins(): string[] {
    return [this.get('APP_ORIGIN')];
  }

  get githubOAuthEnabled(): boolean {
    return Boolean(this.get('GITHUB_CLIENT_ID') && this.get('GITHUB_CLIENT_SECRET'));
  }

  get sessionAbsoluteTtlMs(): number {
    return this.get('SESSION_ABSOLUTE_TTL_DAYS') * 24 * 60 * 60 * 1000;
  }

  get sessionIdleTtlMs(): number {
    return this.get('SESSION_IDLE_TTL_HOURS') * 60 * 60 * 1000;
  }
}
