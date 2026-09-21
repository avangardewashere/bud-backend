import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';

import { AppConfigService } from '../../config/app-config.service.js';

/**
 * Error tracking (Overall Plan §5.10 — boring and mandatory).
 *
 * Inert without SENTRY_DSN, which is the normal state in development and in
 * CI. Everything still goes to the structured log either way; this only adds
 * somewhere to find out that production broke without reading the logs.
 *
 * Wrapped in a service rather than called directly so the rest of the codebase
 * does not import a vendor SDK, and so the decision about *what is worth
 * reporting* lives in one place instead of at every throw site.
 */
@Injectable()
export class ErrorReporter {
  private readonly logger = new Logger(ErrorReporter.name);
  private readonly active: boolean;

  constructor(config: AppConfigService) {
    const dsn = config.get('SENTRY_DSN');
    this.active = Boolean(dsn);

    if (!this.active) {
      return;
    }

    Sentry.init({
      dsn,
      environment: config.get('NODE_ENV'),
      // Errors only. Performance tracing on every bridge write would be a lot
      // of volume for a question nobody is asking yet.
      tracesSampleRate: 0,
      // The bridge moves course state that belongs to the learner; none of it
      // is ours to ship to a third party while diagnosing a stack trace.
      sendDefaultPii: false,
      beforeSend: (event) => ErrorReporter.scrub(event),
    });

    this.logger.log(`Error reporting enabled for ${config.get('NODE_ENV')}`);
  }

  get enabled(): boolean {
    return this.active;
  }

  /**
   * Reports an unexpected failure. Expected ones — a wrong password, a validation
   * error, a 404 — are not failures and are deliberately not sent: an error
   * tracker that fills with 401s is one nobody reads.
   */
  report(error: unknown, context: { path?: string; method?: string; userId?: string }): void {
    if (!this.active) {
      return;
    }

    Sentry.withScope((scope) => {
      scope.setTag('path', context.path ?? 'unknown');
      scope.setTag('method', context.method ?? 'unknown');

      // The id, never the email: enough to correlate a report with a person we
      // can ask, without putting an address in a third-party system.
      if (context.userId) {
        scope.setUser({ id: context.userId });
      }

      Sentry.captureException(error);
    });
  }

  /** Flushes buffered events on shutdown, so a crash does not lose its own report. */
  async flush(timeoutMs = 2000): Promise<void> {
    if (this.active) {
      await Sentry.flush(timeoutMs);
    }
  }

  /**
   * Last-resort scrub. `sendDefaultPii: false` already keeps headers and bodies
   * out, but a cookie or a token reaching Sentry would be a disclosure rather
   * than a bug report, so the belt gets braces.
   */
  private static scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
    if (event.request?.headers) {
      delete event.request.headers.cookie;
      delete event.request.headers.authorization;
    }
    delete event.request?.data;

    return event;
  }
}
