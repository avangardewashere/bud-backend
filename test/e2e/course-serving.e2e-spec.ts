import { beforeAll, describe, expect, it } from 'vitest';

import { ApiClient, apiIsUp, COURSES_BASE, ensureTestUser } from './client.js';

/**
 * Course content served from its own origin.
 *
 * This is the security boundary the whole product rests on, so it is checked
 * against a running listener rather than only in unit tests: the CSP, the
 * bridge injection and the path handling all have to survive the real HTTP
 * path, not just the function that builds them.
 *
 * Skips unless E2E_COURSES_BASE is set, because in local development the shell
 * serves courses itself and the two would fight over the port.
 */

const enabled = Boolean(COURSES_BASE) && (await apiIsUp());
const base = COURSES_BASE ?? '';

describe.skipIf(!enabled)('course serving', () => {
  /**
   * Resolved from the catalog rather than hardcoded: which version is current
   * depends on what has been ingested, and a hardcoded one turns into a 404
   * the moment someone uploads a new version — a failure that says nothing
   * about course serving.
   */
  let prefix: string;
  let worksheet: string;

  beforeAll(async () => {
    const api = new ApiClient();
    await ensureTestUser('e2e-serving@bud.local', 'e2e-serving-password-123');
    await api.login('e2e-serving@bud.local', 'e2e-serving-password-123');

    const detail = await api.get<{
      version: string;
      sessions: { entryPath: string }[];
    }>('/courses/docker-fundamentals');

    prefix = `/docker-fundamentals/${detail.body.version}`;
    worksheet = `${prefix}/${detail.body.sessions[0].entryPath}`;
  });
  it('serves a worksheet', async () => {
    const response = await fetch(`${base}${worksheet}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('injects the bridge after the charset meta, since worksheets have no head', async () => {
    const html = await (await fetch(`${base}${worksheet}`)).text();

    const charsetAt = html.search(/<meta[^>]+charset/i);
    const bridgeAt = html.indexOf('/bridge.js');

    expect(bridgeAt).toBeGreaterThan(-1);
    // A charset declared late is a charset ignored.
    expect(charsetAt).toBeLessThan(bridgeAt);
  });

  it('injects the bridge exactly once', async () => {
    const html = await (await fetch(`${base}${worksheet}`)).text();

    expect(html.split('/bridge.js').length - 1).toBe(1);
  });

  it('sends a policy that keeps the frame from reaching anything', async () => {
    const csp = (await fetch(`${base}${worksheet}`)).headers.get('content-security-policy') ?? '';

    expect(csp).toContain("default-src 'none'");
    // The one that matters most: a course cannot make network requests at all,
    // so it cannot exfiltrate what a learner types. Its only way out is the bridge.
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Only the shell may frame a course.
    expect(csp).toMatch(/frame-ancestors http/);
    // A sandboxed frame has an opaque origin, so 'self' would match nothing.
    expect(csp).not.toContain("'self'");
  });

  it('refuses to let the browser sniff a type', async () => {
    const response = await fetch(`${base}${worksheet}`);

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('caches a version forever, because a version is immutable', async () => {
    const response = await fetch(`${base}${worksheet}`);

    expect(response.headers.get('cache-control')).toMatch(/immutable/);
  });

  it('serves the outline as markdown', async () => {
    const response = await fetch(`${base}${prefix}/docker-10-session-course.md`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/markdown/);
  });

  describe('path handling', () => {
    it('refuses traversal', async () => {
      // fetch normalises `../` out of the URL before it leaves the process, so
      // this asserts the normalised path is refused too. The encoded case below
      // is the one that actually reaches the server with traversal intact.
      const response = await fetch(`${base}${prefix}/../../../etc/passwd`);

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('refuses traversal that only appears after decoding', async () => {
      const response = await fetch(`${base}${prefix}/..%2f..%2fetc%2fpasswd`);

      expect(response.status).toBe(403);
    });

    it('refuses a type the course spec does not allow', async () => {
      // Serving it would mean serving something the validator never inspected.
      const response = await fetch(`${base}${prefix}/tool.exe`);

      expect(response.status).toBe(415);
    });

    it('404s an unknown course, version or file', async () => {
      for (const path of [
        '/no-such-course/1.0.0/index.html',
        '/docker-fundamentals/9.9.9/index.html',
        `${prefix}/missing.html`,
        '/',
      ]) {
        expect((await fetch(`${base}${path}`)).status).toBe(404);
      }
    });
  });
});
