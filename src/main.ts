import 'reflect-metadata';

import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { AppConfigService } from './config/index.js';
import { componentSchemas } from './openapi/components.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Behind Caddy / a load balancer, so client IPs come from X-Forwarded-For.
      // Rate limiting and session records depend on getting this right.
      trustProxy: true,
      bodyLimit: 1 * 1024 * 1024,
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

  await fastify.register(fastifyRateLimit, {
    max: config.get('RATE_LIMIT_MAX'),
    timeWindow: config.get('RATE_LIMIT_WINDOW_MS'),
    // Per client IP. This hook runs on every request before Nest's guards, so
    // the session user is not known yet; per-user limits for the chatty bridge
    // endpoints belong on those routes when they land in Phase 1.
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
  if (!config.isProduction) {
    logger.log(`API docs at ${config.get('API_ORIGIN')}/docs`);
  }
}

void bootstrap();
