import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { openApiSchema, zodBody } from '../common/validation/zod.pipe.js';
import { AuthService } from './auth.service.js';
import type { AuthenticatedRequest, PublicUser, RequestUser } from './auth.types.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import {
  changePasswordResultSchema,
  changePasswordSchema,
  errorSchema,
  loginSchema,
  registerSchema,
  userEnvelopeSchema,
  type ChangePasswordInput,
  type LoginInput,
  type RegisterInput,
} from './dto/auth.schemas.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { SessionService } from './session.service.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly throttle: LoginThrottleService,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Requires a valid invite token while SIGNUP_MODE is invite_only. ' +
      'On success the session cookie is set, so the caller is signed in immediately.',
  })
  @ApiBody({ schema: openApiSchema(registerSchema) })
  @ApiCreatedResponse({
    description: 'Account created and signed in; the session cookie is set.',
    schema: openApiSchema(userEnvelopeSchema, 'output'),
  })
  @ApiForbiddenResponse({
    description: 'Signup closed, or the invite is invalid/expired.',
    schema: openApiSchema(errorSchema, 'output'),
  })
  @ApiConflictResponse({
    description: 'That email address is already registered.',
    schema: openApiSchema(errorSchema, 'output'),
  })
  async register(
    @Body(zodBody(registerSchema)) input: RegisterInput,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ user: PublicUser }> {
    const user = await this.auth.register(input);
    await this.startSession(user.id, request, reply);

    return { user: AuthService.toPublicUser(user) };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiBody({ schema: openApiSchema(loginSchema) })
  @ApiOkResponse({
    description: 'Signed in; the session cookie is set.',
    schema: openApiSchema(userEnvelopeSchema, 'output'),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid email or password.',
    schema: openApiSchema(errorSchema, 'output'),
  })
  @ApiTooManyRequestsResponse({
    description: 'Too many failed attempts; try again later. See Retry-After.',
    schema: openApiSchema(errorSchema, 'output'),
  })
  async login(
    @Body(zodBody(loginSchema)) input: LoginInput,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ user: PublicUser }> {
    const throttleKey = LoginThrottleService.key(input.email, request.ip);

    if (this.throttle.isBlocked(throttleKey)) {
      const retryAfter = this.throttle.retryAfterSeconds(throttleKey);
      reply.header('Retry-After', String(retryAfter));
      throw new HttpException(
        {
          error: 'Too Many Requests',
          message: `Too many failed sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let user;
    try {
      user = await this.auth.validateCredentials(input);
    } catch (error) {
      this.throttle.recordFailure(throttleKey);
      throw error;
    }

    this.throttle.recordSuccess(throttleKey);

    await this.startSession(user.id, request, reply);
    await this.auth.recordLogin(user.id);

    return { user: AuthService.toPublicUser(user) };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Sign out and destroy the current session' })
  @ApiNoContentResponse({ description: 'Signed out; the cookie is cleared.' })
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    if (request.budSession) {
      await this.sessions.revoke(request.budSession.id);
    }
    this.sessions.clearCookie(reply);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Change the current password',
    description: 'Signs out every other session for this account.',
  })
  @ApiBody({ schema: openApiSchema(changePasswordSchema) })
  @ApiOkResponse({
    description: 'Password changed; every other session was signed out.',
    schema: openApiSchema(changePasswordResultSchema, 'output'),
  })
  @ApiUnauthorizedResponse({
    description: 'Current password is incorrect.',
    schema: openApiSchema(errorSchema, 'output'),
  })
  async changePassword(
    @Body(zodBody(changePasswordSchema)) input: ChangePasswordInput,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ revokedSessions: number }> {
    return this.auth.changePassword(user.id, input, request.budSession?.id ?? '');
  }

  private async startSession(
    userId: string,
    request: AuthenticatedRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { rawToken, session } = await this.sessions.create(userId, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });

    this.sessions.setCookie(reply, rawToken, session.expiresAt);
  }
}

/**
 * `/me` lives outside the auth controller because it is about the current user,
 * not about authenticating. The dashboard and profile endpoints will join it here.
 */
@ApiTags('me')
@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  @ApiCookieAuth()
  @ApiOperation({ summary: 'The signed-in user' })
  @ApiOkResponse({
    description: 'The current user.',
    schema: openApiSchema(userEnvelopeSchema, 'output'),
  })
  @ApiUnauthorizedResponse({
    description: 'No valid session.',
    schema: openApiSchema(errorSchema, 'output'),
  })
  async me(@CurrentUser() user: RequestUser): Promise<{ user: PublicUser }> {
    // Re-read rather than echoing the guard's slice: /me must return the same
    // user shape as login and register, or the generated client ends up with
    // two different User types for one concept. It also means a profile edit
    // is reflected immediately instead of at next sign-in.
    const fresh = await this.auth.findById(user.id);

    if (!fresh) {
      throw new UnauthorizedException('Your account is no longer available.');
    }

    return { user: AuthService.toPublicUser(fresh) };
  }
}
