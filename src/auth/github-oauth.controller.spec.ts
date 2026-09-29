import { describe, expect, it, vi } from 'vitest';

import type { AppConfigService } from '../config/app-config.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthService } from './auth.service.js';
import type { AuthenticatedRequest } from './auth.types.js';
import { GithubOAuthController } from './github-oauth.controller.js';
import { GithubOAuthService } from './github-oauth.service.js';
import type { SessionService } from './session.service.js';

/**
 * The state cookie has to come back.
 *
 * It is a CSRF check, so a cookie the browser declines to send is not a
 * degraded sign-in — it is a sign-in that cannot succeed, ever, and the failure
 * looks exactly like the tampering it exists to catch. The path it is scoped to
 * has to be the path the *browser* visits, which is `API_ORIGIN` plus this
 * route, and hard-coding `/auth/github` made that true only for deployments
 * where `API_ORIGIN` has no path of its own.
 *
 * The invariant is asserted against the real `callbackUrl` rather than against a
 * hard-coded string, because those two are the things that have to agree.
 */

const CONFIG: Record<string, unknown> = {
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  APP_ORIGIN: 'https://bud.example',
  APP_SIGN_IN_PATH: '/login',
  API_ORIGIN: 'https://api.bud.example',
  COOKIE_SECURE: true,
};

function harness(apiOrigin: string) {
  const config = {
    get: (key: string) => ({ ...CONFIG, API_ORIGIN: apiOrigin })[key],
    githubOAuthEnabled: true,
  } as unknown as AppConfigService;

  const github = new GithubOAuthService({} as PrismaService, config);

  const cookies: { name: string; value: string; options: { path?: string } }[] = [];
  const cleared: { name: string; options: { path?: string } }[] = [];
  const redirects: string[] = [];

  const reply = {
    setCookie: vi.fn((name: string, value: string, options: { path?: string }) => {
      cookies.push({ name, value, options });
      return reply;
    }),
    clearCookie: vi.fn((name: string, options: { path?: string }) => {
      cleared.push({ name, options });
      return reply;
    }),
    redirect: vi.fn((url: string) => {
      redirects.push(url);
      return reply;
    }),
  };

  const controller = new GithubOAuthController(
    github,
    {} as SessionService,
    {} as AuthService,
    config,
  );

  return { controller, github, reply, cookies, cleared, redirects };
}

describe('the OAuth state cookie', () => {
  it.each([
    ['an API on its own host', 'https://api.bud.example', '/auth/github'],
    ['an API behind the shell proxy', 'https://bud.example/api', '/api/auth/github'],
    ['a nested prefix', 'https://bud.example/api/v1', '/api/v1/auth/github'],
    // A trailing slash reaches neither this controller nor GitHub: the env
    // schema canonicalises the origin settings, because the doubled path it
    // produces also makes `redirect_uri` match no OAuth app — which no cookie
    // path can fix. Pinned in env.schema.spec.ts. Here it is simply mirrored,
    // which is the point of deriving the path from the callback URL: the two
    // agree even on input that should not exist.
    ['an un-canonicalised trailing slash', 'https://bud.example/api/', '/api//auth/github'],
  ])('is scoped to the public path for %s', (_case, apiOrigin, expected) => {
    const { controller, reply, cookies } = harness(apiOrigin);

    controller.start(reply as never);

    expect(cookies).toHaveLength(1);
    expect(cookies[0].options.path).toBe(expected);
  });

  it.each([
    ['https://api.bud.example'],
    ['https://bud.example/api'],
    ['https://bud.example/api/'],
    ['https://bud.example/api/v1'],
  ])('is on a path the callback URL matches, for %s', (apiOrigin) => {
    // The bug, stated as the property it broke: a cookie only comes back if the
    // URL being visited is under its path. This is what no local test could
    // see, because locally the shell and the API differ by port and the
    // callback path really is /auth/github/callback.
    const { controller, github, reply, cookies } = harness(apiOrigin);

    controller.start(reply as never);

    const callbackPath = new URL(github.callbackUrl).pathname;
    expect(callbackPath.startsWith(`${cookies[0].options.path}/`)).toBe(true);
  });

  it('is cleared from the same path it was set on', async () => {
    // A mismatched path on the clear leaves the cookie behind, so the next
    // sign-in verifies against a stale state.
    const { controller, reply, cookies, cleared } = harness('https://bud.example/api');

    controller.start(reply as never);
    await controller.callback(
      undefined,
      undefined,
      'access_denied',
      { cookies: {} } as unknown as AuthenticatedRequest,
      reply as never,
    );

    expect(cleared).toHaveLength(1);
    expect(cleared[0].options.path).toBe(cookies[0].options.path);
  });

  it('sends a declined sign-in back to the shell, not to the API', async () => {
    const { controller, reply, redirects } = harness('https://bud.example/api');

    await controller.callback(
      undefined,
      undefined,
      'access_denied',
      { cookies: {} } as unknown as AuthenticatedRequest,
      reply as never,
    );

    expect(redirects).toEqual(['https://bud.example/login?error=github_declined']);
  });
});
