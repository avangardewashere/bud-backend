import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfigService } from '../config/app-config.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { GithubOAuthService, type GithubProfile } from './github-oauth.service.js';

/**
 * The parts of GitHub sign-in where a mistake is a security bug rather than a
 * broken button: the CSRF state, and the order in which a GitHub identity is
 * resolved to a Bud account.
 */

const CONFIG: Record<string, unknown> = {
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  API_ORIGIN: 'https://api.bud.test',
  APP_ORIGIN: 'https://app.bud.test',
  SIGNUP_MODE: 'invite_only',
};

function makeService(overrides: Partial<Record<string, unknown>> = {}, prisma: unknown = {}) {
  const config = {
    get: (key: string) => ({ ...CONFIG, ...overrides })[key],
    githubOAuthEnabled: true,
  } as unknown as AppConfigService;

  return new GithubOAuthService(prisma as PrismaService, config);
}

const profile: GithubProfile = {
  id: '12345',
  login: 'octocat',
  name: 'The Octocat',
  avatarUrl: 'https://avatars.example/octocat.png',
  email: 'octocat@bud.test',
};

describe('GithubOAuthService', () => {
  describe('the CSRF state', () => {
    it('accepts a state it issued', () => {
      const service = makeService();
      const { state, cookieValue } = service.createState();

      expect(service.verifyState(state, cookieValue)).toBe(true);
    });

    it('does not put the state itself in the cookie', () => {
      const service = makeService();
      const { state, cookieValue } = service.createState();

      // The cookie is an HMAC, so a leaked cookie cannot be replayed as a state.
      expect(cookieValue).not.toBe(state);
    });

    it('rejects a state that was not issued with this cookie', () => {
      const service = makeService();
      const mine = service.createState();
      const theirs = service.createState();

      expect(service.verifyState(theirs.state, mine.cookieValue)).toBe(false);
    });

    it('rejects a missing state or a missing cookie', () => {
      const service = makeService();
      const { state, cookieValue } = service.createState();

      expect(service.verifyState(undefined, cookieValue)).toBe(false);
      expect(service.verifyState(state, undefined)).toBe(false);
      expect(service.verifyState(undefined, undefined)).toBe(false);
    });

    it('rejects a state signed with a different secret', () => {
      // i.e. another deployment, or an attacker guessing at the signing key.
      const mine = makeService();
      const other = makeService({ GITHUB_CLIENT_SECRET: 'someone-elses-secret' });
      const issued = other.createState();

      expect(mine.verifyState(issued.state, issued.cookieValue)).toBe(false);
    });

    it('issues a different state every time', () => {
      const service = makeService();

      const states = new Set(Array.from({ length: 50 }, () => service.createState().state));
      expect(states.size).toBe(50);
    });
  });

  describe('the authorize URL', () => {
    it('carries the state, the callback and no signup invitation', () => {
      const service = makeService();
      const url = new URL(service.authorizeUrl('the-state'));

      expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(url.searchParams.get('state')).toBe('the-state');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://api.bud.test/auth/github/callback',
      );
      // Signup happens in Bud, on Bud's terms — not by way of a GitHub signup flow.
      expect(url.searchParams.get('allow_signup')).toBe('false');
      expect(url.searchParams.get('scope')).toContain('user:email');
    });
  });

  describe('resolving a GitHub identity to a Bud account', () => {
    let prisma: {
      oAuthAccount: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
      user: { findUnique: ReturnType<typeof vi.fn> };
      $transaction: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      prisma = {
        oAuthAccount: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
        user: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(),
      };
    });

    it('returns the already-linked user without touching anything else', async () => {
      const user = { id: 'user-1', deletedAt: null };
      prisma.oAuthAccount.findUnique.mockResolvedValue({ user });

      const resolved = await makeService({}, prisma).resolveUser(profile);

      expect(resolved).toBe(user);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('links to an existing account with the same verified email', async () => {
      // Otherwise someone who signed up with a password would silently end up
      // with a second account the first time they clicked "sign in with GitHub".
      const existing = { id: 'user-2', deletedAt: null };
      prisma.user.findUnique.mockResolvedValue(existing);

      const resolved = await makeService({}, prisma).resolveUser(profile);

      expect(resolved).toBe(existing);
      expect(prisma.oAuthAccount.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ providerAccountId: '12345', userId: 'user-2' }),
        }),
      );
    });

    it('ignores a soft-deleted account rather than resurrecting it', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-3', deletedAt: new Date() });

      // Falls through to registration, which invite_only then refuses.
      await expect(makeService({}, prisma).resolveUser(profile)).rejects.toThrow(
        /Signup is not open/,
      );
    });

    it('ignores a linked account whose user was deleted', async () => {
      prisma.oAuthAccount.findUnique.mockResolvedValue({
        user: { id: 'user-4', deletedAt: new Date() },
      });

      await expect(makeService({}, prisma).resolveUser(profile)).rejects.toThrow(
        /Signup is not open/,
      );
    });

    it('refuses to register a new user while signup is invite-only', async () => {
      // There is no invite flow through OAuth on purpose: an invite is bound to
      // an email, and letting GitHub vouch for one makes the invite the weaker
      // of the two checks.
      await expect(makeService({}, prisma).resolveUser(profile)).rejects.toThrow(
        /Signup is not open/,
      );
    });

    it('refuses to register when signup is closed', async () => {
      await expect(
        makeService({ SIGNUP_MODE: 'closed' }, prisma).resolveUser(profile),
      ).rejects.toThrow(/Signup is not open/);
    });

    it('registers a new user when signup is open', async () => {
      const created = { id: 'user-5' };
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          user: { create: vi.fn().mockResolvedValue(created) },
          oAuthAccount: { create: vi.fn() },
          progressEvent: { create: vi.fn() },
        }),
      );

      const resolved = await makeService({ SIGNUP_MODE: 'open' }, prisma).resolveUser(profile);

      expect(resolved).toBe(created);
    });

    it('refuses to register an account with no verified email', async () => {
      // An unverified address must never be matched onto a Bud account, so a
      // profile without a verified one has nothing to register against.
      await expect(
        makeService({ SIGNUP_MODE: 'open' }, prisma).resolveUser({ ...profile, email: null }),
      ).rejects.toThrow(/no verified email/);
    });

    it('does not match on email when GitHub gave none', async () => {
      await expect(
        makeService({}, prisma).resolveUser({ ...profile, email: null }),
      ).rejects.toThrow();

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });
});
