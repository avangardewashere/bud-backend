import 'reflect-metadata';

import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { ErrorReporter } from './common/errors/error-reporter.js';
import { AppConfigService } from './config/index.js';
import { buildCoursesServer } from './course-serving/courses-server.js';
import { PublishedVersions } from './course-serving/published-versions.js';
import { PrismaService } from './prisma/prisma.service.js';
import { StorageService } from './storage/storage.service.js';
import { componentSchemas } from './openapi/components.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Behind Caddy / a load balancer, so client IPs come from X-Forwarded-For.
      // Rate limiting and session records depend on getting this right.
      trustProxy: true,
      // Must stay comfortably above the 1 MiB per-value storage cap. If the two
      // match, fastify answers 413 first with no envelope and no `code`, and the
      // shell cannot tell a limit it should explain from a crash it should retry.
      bodyLimit: 2 * 1024 * 1024,
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  app.flushLogs();

  const config = app.get(AppConfigService);

  // Register on the Fastify instance itself rather than through Nest's wrapper:
  // fastify's own `register` is generic over the plugin's instance type, so the
  // plugins' type augmentations line up instead of fighting Nest's signature.
  const fastify = app.getHttpAdapter().getInstance();

  await fastify.register(fastifyHelmet, {
    // The API serves JSON, never HTML. The course-serving origin gets its own,
    // much stricter policy when it lands in Phase 1.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await fastify.register(fastifyCookie);

  // Course package uploads. The per-file cap is enforced again in the route,
  // because fastify truncates at the limit rather than refusing outright.
  await fastify.register(fastifyMultipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10 },
  });

  await fastify.register(fastifyRateLimit, {
    max: config.get('RATE_LIMIT_MAX'),
    timeWindow: config.get('RATE_LIMIT_WINDOW_MS'),
    // Per client IP, and deliberately loose: this is a blunt ceiling against a
    // single source flooding the API, not the real protection. The endpoints
    // that need a meaningful limit — the bridge's state routes — carry their own
    // per-user allowance, because this hook runs before Nest's guards and cannot
    // know who is calling. One IP can legitimately be many learners behind a
    // NAT, and in development it is every browser tab at once.
    keyGenerator: (request) => request.ip,
  });

  app.enableCors({
    origin: config.corsOrigins,
    // The shell authenticates with an httpOnly cookie, so credentials must flow.
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });

  // Shut down cleanly so in-flight requests finish and Prisma disconnects.
  app.enableShutdownHooks();

  // A process that dies with its error report still buffered has told nobody
  // what killed it.
  const reporter = app.get(ErrorReporter);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void reporter.flush());
  }

  if (!config.isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Bud API')
      .setDescription(
        'Backend for Bud, the learning platform. The frontend shell talks to this ' +
          'service over JSON with an httpOnly session cookie.',
      )
      .setVersion('0.1.0')
      .addCookieAuth('bud_session')
      .addServer(config.get('API_ORIGIN'))
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);

    // The routes reference these by $ref; register the definitions so the shell's
    // generated client gets named types (PublicUser, ErrorResponse) rather than
    // an anonymous structural copy per endpoint.
    document.components ??= {};
    document.components.schemas = {
      ...document.components.schemas,
      ...componentSchemas,
    };
    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'docs/openapi.json',
    });
  }

  const port = config.get('PORT');
  const host = config.get('HOST');

  await app.listen({ port, host });

  const logger = new NestLogger('Bootstrap');
  logger.log(`Bud API listening on http://${host}:${port} [${config.get('NODE_ENV')}]`);

  // Course content on its own origin. Separate listener, not a route: a
  // different port is not a different origin as far as cookies are concerned,
  // and this boundary is what keeps author-controlled JavaScript away from the
  // session. Unset in development while the shell serves courses itself.
  const coursesPort = config.get('COURSES_PORT');
  if (coursesPort) {
    // The CSP and the bridge tag are built from COURSES_ORIGIN, so if that does
    // not actually point at this listener the policy names an origin nothing is
    // served from — and the course half-works in a way that is painful to
    // diagnose. Behind a proxy the ports legitimately differ, so warn rather
    // than refuse, and only where a mismatch is unlikely to be deliberate.
    const declaredPort = new URL(config.get('COURSES_ORIGIN')).port;
    if (config.isDevelopment && declaredPort && declaredPort !== String(coursesPort)) {
      logger.warn(
        `COURSES_ORIGIN is ${config.get('COURSES_ORIGIN')} but course content is being served ` +
          `on port ${coursesPort}. The CSP and the injected bridge tag are built from ` +
          'COURSES_ORIGIN, so point it at this listener or courses will load against the wrong policy.',
      );
    }

    const courses = buildCoursesServer(
      app.get(StorageService),
      config,
      new PublishedVersions(app.get(PrismaService)),
    );
    await courses.listen({ port: coursesPort, host });
    logger.log(`Course content listening on http://${host}:${coursesPort}`);
  }
  if (!config.isProduction) {
    logger.log(`API docs at ${config.get('API_ORIGIN')}/docs`);
  }
}

void bootstrap();
