import { ForbiddenException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { User } from '@prisma/client';

import { AppException } from '../common/errors/app-exception.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const PROVIDER = 'github';
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const EMAILS_URL = 'https://api.github.com/user/emails';

export interface GithubProfile {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** Only ever a *verified* address. See emailFor(). */
  email: string | null;
}

/**
 * Sign in with GitHub — the other half of §5.1, and the last piece of Phase 0's
 * stated auth scope.
 *
 * The account model is already built for this: `oauth_accounts` keys on
 * (provider, providerAccountId), so a GitHub identity attaches to a Bud user
 * rather than being one.
 */
@Injectable()
export class GithubOAuthService {
  private readonly logger = new Logger(GithubOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.githubOAuthEnabled;
  }

  get callbackUrl(): string {
    return `${this.config.get('API_ORIGIN')}/auth/github/callback`;
  }

  /**
   * CSRF protection for the round trip.
   *
   * The state is random, and what goes in the cookie is an HMAC of it rather
   * than the value itself — so a state echoed back by GitHub can be verified
   * without the server storing anything, and a leaked cookie cannot be turned
   * into a usable state.
   */
  createState(): { state: string; cookieValue: string } {
    const state = randomBytes(32).toString('base64url');
    return { state, cookieValue: this.signState(state) };
  }

  verifyState(state: string | undefined, cookieValue: string | undefined): boolean {
    if (!state || !cookieValue) {
      return false;
    }

    const expected = Buffer.from(this.signState(state));
    const actual = Buffer.from(cookieValue);

    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private signState(state: string): string {
    // Keyed with the client secret: it is already the thing that must not leak,
    // and this avoids inventing another secret to configure and rotate.
    return createHmac('sha256', this.config.get('GITHUB_CLIENT_SECRET') ?? '')
      .update(state)
      .digest('base64url');
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.get('GITHUB_CLIENT_ID') ?? '',
      redirect_uri: this.callbackUrl,
      // read:user for the profile, user:email because the primary address is
      // often private and is not on the profile.
      scope: 'read:user user:email',
      state,
      allow_signup: 'false',
    });

    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Exchanges the one-time code for a token. The token is never stored. */
  async exchangeCode(code: string): Promise<string> {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.get('GITHUB_CLIENT_ID'),
        client_secret: this.config.get('GITHUB_CLIENT_SECRET'),
        code,
        redirect_uri: this.callbackUrl,
      }),
    });

    const body = (await response.json()) as { access_token?: string; error?: string };

    if (!response.ok || !body.access_token) {
      // GitHub answers 200 with an error body for a used or expired code.
      throw new AppException(
        'invite_invalid',
        'GitHub did not accept that sign-in attempt.',
        HttpStatus.BAD_REQUEST,
        body.error,
      );
    }

    return body.access_token;
  }

  async fetchProfile(token: string): Promise<GithubProfile> {
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'bud-api',
    };

    const response = await fetch(USER_URL, { headers });
    if (!response.ok) {
      throw new AppException(
        'invite_invalid',
        'Could not read your GitHub profile.',
        HttpStatus.BAD_GATEWAY,
      );
    }

    const user = (await response.json()) as {
      id: number;
      login: string;
      name: string | null;
      avatar_url: string | null;
    };

    return {
      id: String(user.id),
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
      email: await this.emailFor(headers),
    };
  }

  /**
   * The primary *verified* address, or none.
   *
   * Unverified addresses are ignored deliberately: an attacker who adds
   * someone else's address to their own GitHub account without verifying it
   * would otherwise be matched onto that person's Bud account.
   */
  private async emailFor(headers: Record<string, string>): Promise<string | null> {
    const response = await fetch(EMAILS_URL, { headers });

    if (!response.ok) {
      return null;
    }

    const emails = (await response.json()) as {
      email: string;
      primary: boolean;
      verified: boolean;
    }[];

    const usable = emails.filter((e) => e.verified);
    const primary = usable.find((e) => e.primary) ?? usable[0];

    return primary?.email.trim().toLowerCase() ?? null;
  }

  /**
   * Resolves a GitHub identity to a Bud user, in this order:
   *
   *   1. an already-linked account — the identity we have seen before
   *   2. an existing user with the same verified email — linked on the spot,
   *      so someone who signed up with a password can start using GitHub
   *      without ending up with two accounts
   *   3. a new user, but only when signup is open
   */
  async resolveUser(profile: GithubProfile): Promise<User> {
    const linked = await this.prisma.oAuthAccount.findUnique({
      where: { provider_providerAccountId: { provider: PROVIDER, providerAccountId: profile.id } },
      include: { user: true },
    });

    if (linked && !linked.user.deletedAt) {
      return linked.user;
    }

    if (profile.email) {
      const existing = await this.prisma.user.findUnique({ where: { email: profile.email } });

      if (existing && !existing.deletedAt) {
        await this.link(existing.id, profile.id);
        this.logger.log(`Linked GitHub ${profile.login} to existing user ${existing.id}`);
        return existing;
      }
    }

    return this.register(profile);
  }

  private async register(profile: GithubProfile): Promise<User> {
    const signupMode = this.config.get('SIGNUP_MODE');

    if (signupMode !== 'open') {
      // There is no invite flow through OAuth on purpose: an invite is bound to
      // an email address, and letting GitHub vouch for one would make the
      // invite the weaker of the two checks.
      throw new ForbiddenException(
        'Signup is not open. Ask for an invite and register with an email address first, ' +
          'then sign in with GitHub.',
      );
    }

    if (!profile.email) {
      throw new ForbiddenException(
        'Your GitHub account has no verified email address, so there is nothing to register.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: profile.email!,
          name: profile.name ?? profile.login,
          avatarUrl: profile.avatarUrl,
          // No passwordHash: this account can only ever sign in through GitHub
          // until its owner sets one.
          role: 'learner',
        },
      });

      await tx.oAuthAccount.create({
        data: { provider: PROVIDER, providerAccountId: profile.id, userId: user.id },
      });

      await tx.progressEvent.create({
        data: { userId: user.id, type: 'user.registered', payload: { via: PROVIDER } },
      });

      return user;
    });
  }

  private async link(userId: string, providerAccountId: string): Promise<void> {
    await this.prisma.oAuthAccount.upsert({
      where: { provider_providerAccountId: { provider: PROVIDER, providerAccountId } },
      create: { provider: PROVIDER, providerAccountId, userId },
      update: { userId },
    });
  }
}
