import { Controller, Get, HttpStatus, NotFoundException, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import type { AuthenticatedRequest } from './auth.types.js';
import { AuthService } from './auth.service.js';
import { Public } from './decorators/public.decorator.js';
import { GithubOAuthService } from './github-oauth.service.js';
import { SessionService } from './session.service.js';
import { AppConfigService } from '../config/app-config.service.js';

/** Short-lived, and only has to survive the round trip to GitHub. */
const STATE_COOKIE = 'bud_oauth_state';
const STATE_TTL_SECONDS = 600;

/**
 * The GitHub sign-in round trip.
 *
 * These two routes are browser redirects rather than JSON, which is why they
 * are excluded from the OpenAPI document — a generated client would produce
 * fetch calls for endpoints that must be navigated to, not fetched. The shell
 * links to /auth/github; everything after that is redirects until the session
 * cookie is set and the browser lands back on the shell.
 */
@ApiTags('auth')
@Controller('auth/github')
export class GithubOAuthController {
  constructor(
    private readonly github: GithubOAuthService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Start signing in with GitHub',
    description:
      'A redirect, not a fetch: navigate the browser here. Returns 404 when ' +
      'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not configured.',
  })
  start(@Res() reply: FastifyReply): void {
    this.assertEnabled();

    const { state, cookieValue } = this.github.createState();

    reply.setCookie(STATE_COOKIE, cookieValue, {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE'),
      // Lax, not Strict: the callback is a cross-site top-level navigation back
      // to us, and Strict would drop this cookie exactly when it is needed.
      sameSite: 'lax',
      path: '/auth/github',
      maxAge: STATE_TTL_SECONDS,
    });

    void reply.redirect(this.github.authorizeUrl(state), HttpStatus.FOUND);
  }

  @Public()
  @Get('callback')
  @ApiExcludeEndpoint()
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    this.assertEnabled();

    const cookie = request.cookies?.[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/auth/github' });

    // The user declined on GitHub's screen. Not an error worth logging.
    if (error) {
      return this.backToShell(reply, 'github_declined');
    }

    if (!this.github.verifyState(state, cookie)) {
      // Either a forged callback or a stale tab. Both end the same way.
      return this.backToShell(reply, 'github_state_mismatch');
    }

    if (!code) {
      return this.backToShell(reply, 'github_no_code');
    }

    try {
      const token = await this.github.exchangeCode(code);
      const profile = await this.github.fetchProfile(token);
      const user = await this.github.resolveUser(profile);

      const { rawToken, session } = await this.sessions.create(user.id, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });
      this.sessions.setCookie(reply, rawToken, session.expiresAt);
      await this.auth.recordLogin(user.id);

      void reply.redirect(this.config.get('APP_ORIGIN'), HttpStatus.FOUND);
    } catch (cause) {
      // Redirect rather than render: the browser is mid-navigation and the
      // person is looking at the shell, not at an API response.
      const reason =
        cause instanceof Error && cause.message.includes('Signup is not open')
          ? 'signup_closed'
          : 'github_failed';

      return this.backToShell(reply, reason);
    }
  }

  private backToShell(reply: FastifyReply, reason: string): void {
    const url = new URL('/sign-in', this.config.get('APP_ORIGIN'));
    url.searchParams.set('error', reason);
    void reply.redirect(url.toString(), HttpStatus.FOUND);
  }

  /**
   * Unconfigured OAuth is a route that does not exist, rather than one that
   * exists and fails: a "Sign in with GitHub" button that 500s is worse than
   * one the shell knows not to render.
   */
  private assertEnabled(): void {
    if (!this.github.enabled) {
      throw new NotFoundException('GitHub sign-in is not configured.');
    }
  }
}
