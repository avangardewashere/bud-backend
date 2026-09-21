import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';

import { AuthModule } from './auth/auth.module.js';
import { RolesGuard } from './auth/guards/roles.guard.js';
import { SessionGuard } from './auth/guards/session.guard.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ErrorReporter } from './common/errors/error-reporter.js';
import { sanitizeUrl } from './common/logging/sanitize-url.js';
import { AppConfigModule, AppConfigService } from './config/index.js';
import { CourseSpecModule } from './course-spec/course-spec.module.js';
import { CoursesModule } from './courses/courses.module.js';
import { HealthModule } from './health/health.module.js';
import { NotesModule } from './notes/notes.module.js';
import { PrismaModule } from './prisma/index.js';
import { ProgressModule } from './progress/progress.module.js';
import { StorageModule } from './storage/index.js';

@Module({
  imports: [
    AppConfigModule,

    // JSON logs to stdout: the container runtime owns log shipping, not the app.
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          genReqId: (req, res) => {
            const existing = req.headers['x-request-id'];
            const id = typeof existing === 'string' ? existing : randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          // Never log credentials or session cookies, in any environment.
          redact: {
            paths: [
              'req.headers.cookie',
              'req.headers.authorization',
              'res.headers["set-cookie"]',
              'req.body.password',
              'req.body.currentPassword',
              'req.body.newPassword',
              'req.body.inviteToken',
            ],
            remove: true,
          },
          serializers: {
            // pino-http logs req.url verbatim, which put the OAuth
            // authorization code and CSRF state into every log line for
            // /auth/github/callback. A code is exchangeable for an access
            // token until it is used, and logs are read by more people and
            // systems than the database is.
            req(request: { url?: string; method?: string; id?: unknown }) {
              return {
                id: request.id,
                method: request.method,
                url: request.url ? sanitizeUrl(request.url) : request.url,
              };
            },
          },
          // Probes would otherwise dominate the log volume.
          autoLogging: {
            ignore: (req) => req.url === '/health' || req.url === '/ready',
          },
          transport: config.isProduction
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } },
        },
      }),
    }),

    PrismaModule,
    StorageModule,
    AuthModule,
    CourseSpecModule,
    CoursesModule,
    ProgressModule,
    NotesModule,
    HealthModule,
  ],
  providers: [
    // Authentication is on by default; routes opt out with @Public().
    { provide: APP_GUARD, useClass: SessionGuard },
    // Runs second, so request.user is already resolved.
    { provide: APP_GUARD, useClass: RolesGuard },
    ErrorReporter,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
