import 'reflect-metadata';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { FastifyServerFactoryHandler, FastifyServerOptions } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { ErrorReporter } from './common/errors/error-reporter.js';
import { AppConfigService } from './config/index.js';
import { buildCoursesServer, isCoursePath } from './course-serving/courses-server.js';
import { PublishedVersions } from './course-serving/published-versions.js';
import { StorageService } from './storage/storage.service.js';
import { componentSchemas } from './openapi/components.js';

/**
 * Set only when course content shares the API's port. Until then — and always,
 * when courses have their own listener — every request goes to the API.
 */
let routeCourse: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // One HTTP server in front of two Fastify instances. Each request goes to
      // exactly one of them, whole: the courses server's CSP and nothing else,
      // or the API with its plugins. Neither sees the other's traffic.
      serverFactory: (handleApi: FastifyServerFactoryHandler, options: FastifyServerOptions) => {
        const server = createServer((req, res) => {
          if (routeCourse && isCoursePath(req.url ?? '/')) {
            routeCourse(req, res);
            return;
          }
          handleApi(req, res);
        });

        // Fastify applies its timeouts only to servers it creates itself, so a
        // factory silently falls back to Node's: a 5 s keep-alive instead of
        // 72 s. Behind a proxy that pools connections (Render's, Caddy's), the
        // proxy then reuses a socket just as Node closes it, and a request —
        // a progress save, a sign-in — fails as an intermittent 502. Render's
        // own guidance is 120 s, with the header timeout above it.
        server.keepAliveTimeout = 120_000;
        server.headersTimeout = 121_000;
        server.requestTimeout = options.requestTimeout ?? 0;
        server.setTimeout(options.connectionTimeout ?? 0);
        return server;
      },
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

  // Nothing the API returns is safe to cache: it is per-user or it changes.
  // Said outright rather than left to defaults, because a proxy in front may
  // cache whatever it is not told not to — Vercel's rewrite proxy, for one,
  // caches upstream responses by default, and would then hand one learner's
  // dashboard to the next person to ask. A route that knows better sets its
  // own header, and this leaves it alone.
  fastify.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
  });

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
  const logger = new NestLogger('Bootstrap');

  // Course content. Unset in development while the shell serves courses itself.
  const coursesPort = config.get('COURSES_PORT');

  // Shared port: for hosts that give a service one public port (Render's free
  // tier). Course content is then served from the API's own hostname.
  //
  // What must never happen is course JavaScript running with the *shell's*
  // origin, where the session lives. Two things hold that line here:
  //
  // - Every course response carries a CSP `sandbox` directive, so a course
  //   document is opaque-origin however it is reached. That matters because
  //   the shell proxies /api to this host: /api/{course}/{version}/page.html on
  //   the shell's origin arrives here as a course path, and without the
  //   sandbox that document would run as the shell. (The shell's rewrite also
  //   forwards only the API's own prefixes — defence in depth, not the fix.)
  // - The session cookie belongs to the shell's origin, because browsers reach
  //   the API only through that proxy; the env schema refuses the one
  //   configuration that would set it here (GitHub sign-in with its callback
  //   on this host).
  if (coursesPort && coursesPort === port) {
    const courses = buildCoursesServer(app.get(StorageService), config, app.get(PublishedVersions));
    // routing() needs the instance's routes compiled, which ready() does.
    await courses.ready();
    routeCourse = (req, res) => courses.routing(req, res);
  }

  await app.listen({ port, host });
  logger.log(`Bud API listening on http://${host}:${port} [${config.get('NODE_ENV')}]`);

  if (routeCourse) {
    logger.log(`Course content served on the same port, for paths shaped /{course}/{version}/…`);
  }

  // Course content on its own listener: the normal arrangement, and the one to
  // prefer wherever a host allows it. A different port is not a different
  // origin as far as cookies are concerned, so in production this listener
  // sits on its own hostname.
  if (coursesPort && coursesPort !== port) {
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

    // From the container, so the admin routes and the content origin share one
    // cache — otherwise unpublishing would clear a cache nothing reads.
    const courses = buildCoursesServer(app.get(StorageService), config, app.get(PublishedVersions));
    await courses.listen({ port: coursesPort, host });
    logger.log(`Course content listening on http://${host}:${coursesPort}`);
  }
  if (!config.isProduction) {
    logger.log(`API docs at ${config.get('API_ORIGIN')}/docs`);
  }
}

void bootstrap();
