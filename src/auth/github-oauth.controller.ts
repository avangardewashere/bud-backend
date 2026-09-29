import { Controller, Get, HttpStatus, NotFoundException, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { AppException } from '../common/errors/app-exception.js';
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
 * Every value this API can put in `?error=` on the shell's sign-in URL.
 *
 * **This is a published contract, exactly like `ERROR_CODES`, and it is easy to
 * miss because it does not travel in a JSON envelope.** The shell maps each of
 * these to a sentence a person reads, and its own test suite asserts that every
 * value it knows about becomes one — so renaming a value here does not break a
 * type anywhere, it just produces an unexplained failure on someone's sign-in
 * screen. Adding one is a change the shell has to make too: an unmapped value
 * has no sentence.
 *
 * Frozen once published. Add, never rename.
 */
export const SHELL_SIGN_IN_ERRORS = [
  /** The person pressed "Cancel" on GitHub's authorise screen. */
  'github_declined',
  /** A forged callback, or a tab left open past the state cookie's ten minutes. */
  'github_state_mismatch',
  /** GitHub sent us back without a code, which should not happen. */
  'github_no_code',
  /** The identity is fine, but this deployment does not accept new accounts. */
  'signup_closed',
  /**
   * The identity is fine and signup is open, but GitHub has no *verified*
   * address to register, and an unverified one must never be matched onto a Bud
   * account. Mapped by the shell before this was added, not after.
   */
  'github_no_verified_email',
  /** Anything else: the token exchange, the profile fetch, the database. */
  'github_failed',
] as const;

export type ShellSignInError = (typeof SHELL_SIGN_IN_ERRORS)[number];

/**
 * Whether an error code is also one of the sentences the shell can render.
 *
 * Two lists overlap by design — `signup_closed` and `github_no_verified_email`
 * are both `ERROR_CODES` and reasons here — and this is the seam. Anything else
 * a service throws becomes `github_failed`, because the shell has no sentence
 * for it.
 */
function isShellSignInError(code: string): code is ShellSignInError {
  return (SHELL_SIGN_IN_ERRORS as readonly string[]).includes(code);
}

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
      path: this.statePath,
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
    reply.clearCookie(STATE_COOKIE, { path: this.statePath });

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
      // On the code, not on the message. This used to read
      // `cause.message.includes('Signup is not open')`, so rewording a sentence
      // in github-oauth.service.ts would have quietly turned "signup is
      // invite-only" into a generic failure on the shell's sign-in screen —
      // exactly the coupling the frozen error codes exist to avoid.
      const reason: ShellSignInError =
        cause instanceof AppException && isShellSignInError(cause.code)
          ? cause.code
          : 'github_failed';

      return this.backToShell(reply, reason);
    }
  }

  /**
   * The path to scope the state cookie to — the **public** one.
   *
   * A browser matches a cookie's `Path` against the URL it is visiting, and that
   * URL is `API_ORIGIN` plus this route, not this route alone. Hard-coded as
   * `/auth/github`, it was right only where `API_ORIGIN` has no path — and the
   * one topology that can have GitHub sign-in on the $0 deploy is exactly the
   * other kind: the env schema refuses `GITHUB_CLIENT_ID` while `API_ORIGIN` and
   * `COURSES_ORIGIN` share a host, and its own message says to point
   * `API_ORIGIN` at the shell's `/api` proxy. Then the cookie sat at
   * `/auth/github` on the shell's host while GitHub sent the browser to
   * `/api/auth/github/callback`, the browser withheld it, `verifyState` saw
   * nothing, and **every** sign-in ended at `?error=github_state_mismatch` —
   * whose sentence tells the person to start again, which could never work.
   *
   * Invisible locally, because there the shell and the API differ by port and
   * the callback path really is `/auth/github/callback`. Reported from the shell
   * repo, which reads the failure from the other end.
   */
  private get statePath(): string {
    // Derived from the callback URL rather than rebuilt from API_ORIGIN, so the
    // cookie's path and the URL GitHub sends the browser to cannot disagree —
    // whatever shape API_ORIGIN turns out to have. The env schema canonicalises
    // it, and this holds even if it stops.
    return new URL(this.github.callbackUrl).pathname.replace(/\/callback$/, '');
  }

  private backToShell(reply: FastifyReply, reason: ShellSignInError): void {
    const url = new URL(this.config.get('APP_SIGN_IN_PATH'), this.config.get('APP_ORIGIN'));
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
