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
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
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
  changePasswordSchema,
  loginSchema,
  registerSchema,
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
  @ApiForbiddenResponse({ description: 'Signup closed, or the invite is invalid/expired.' })
  @ApiConflictResponse({ description: 'That email address is already registered.' })
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
  @ApiUnauthorizedResponse({ description: 'Invalid email or password.' })
  @ApiTooManyRequestsResponse({ description: 'Too many failed attempts; try again later.' })
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
  @ApiUnauthorizedResponse({ description: 'Current password is incorrect.' })
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
  @Get()
  @ApiCookieAuth()
  @ApiOperation({ summary: 'The signed-in user' })
  @ApiOkResponse({ description: 'The current user.' })
  @ApiUnauthorizedResponse({ description: 'No valid session.' })
  me(@CurrentUser() user: RequestUser): { user: RequestUser } {
    return { user };
  }
}
