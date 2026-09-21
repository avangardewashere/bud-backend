import { describe, expect, it } from 'vitest';

import { injectBridge, isCoursePath } from './courses-server.js';

const BRIDGE = '<script src="http://localhost:3100/bridge.js"></script>';

/**
 * Bridge injection has to match the shell's dev server exactly, or a course
 * works in development and breaks in production. The charset case is the one
 * that caught the shell out: the Docker worksheets are fragments with no
 * <head>, so there is nothing to inject into.
 */
describe('injectBridge', () => {
  it('injects into <head> when there is one', () => {
    const html = injectBridge('<html><head><title>x</title></head><body></body></html>', BRIDGE);

    expect(html).toContain(`<head>\n${BRIDGE}`);
    expect(html.indexOf(BRIDGE)).toBeLessThan(html.indexOf('<title>'));
  });

  it('keeps attributes on the head tag', () => {
    const html = injectBridge('<head lang="en"><title>x</title></head>', BRIDGE);

    expect(html).toContain('<head lang="en">');
    expect(html).toContain(BRIDGE);
  });

  it('is not fooled by <header>', () => {
    // `<head[^>]*>` would match <header> and inject into the body.
    const html = injectBridge('<body><header>nav</header></body>', BRIDGE);

    expect(html).not.toContain('<header>\n<script');
  });

  it('injects after the charset meta when there is no head', () => {
    // A worksheet, as the Docker course actually ships them.
    const html = injectBridge('<meta charset="utf-8">\n<title>Session 1</title>', BRIDGE);

    // The charset declaration must stay first: a charset declared late is a
    // charset ignored.
    expect(html.indexOf('charset')).toBeLessThan(html.indexOf(BRIDGE));
    expect(html.indexOf(BRIDGE)).toBeLessThan(html.indexOf('<title>'));
  });

  it('prepends when there is neither head nor charset', () => {
    const html = injectBridge('<p>bare fragment</p>', BRIDGE);

    expect(html.startsWith(BRIDGE)).toBe(true);
  });

  it('injects exactly once', () => {
    const html = injectBridge('<head></head><meta charset="utf-8">', BRIDGE);

    expect(html.split('bridge.js').length - 1).toBe(1);
  });
});

/**
 * When courses share the API's port, this alone decides which server gets a
 * request, before either has seen it. A false positive hands an API call to the
 * course server; a false negative sends course content through the API's
 * plugins with none of its CSP.
 */
describe('isCoursePath', () => {
  it.each([
    '/docker-fundamentals/1.0.0/docker-session-1-worksheet.html',
    '/docker-fundamentals/1.0.0/assets/cover.png',
    '/docker-fundamentals/2.10.3-beta.1/index.html',
    '/docker-fundamentals/1.0.0/index.html?v=2',
    // Traversal stays with the course server, whose handler refuses it with
    // 403 — it must not be bounced to the API as an unknown route instead.
    '/docker-fundamentals/1.0.0/..%2f..%2fetc%2fpasswd',
  ])('claims course content: %s', (url) => {
    expect(isCoursePath(url)).toBe(true);
  });

  it.each([
    '/health',
    '/ready',
    '/auth/login',
    '/me',
    '/me/dashboard',
    '/courses',
    '/courses/docker-fundamentals',
    '/courses/docker-fundamentals/enroll',
    '/me/courses/docker-fundamentals/state/progress',
    '/me/courses/docker-fundamentals/sessions/session-1/notes',
    '/admin/courses/0196f2a8-7c1e-7cc0-a2b1-0c9a9e1b2f3d/storage-keys',
    '/docs/openapi.json',
    // Two segments only: a version with no file is not content.
    '/docker-fundamentals/1.0.0',
    // A slug cannot hold the dots a version needs, so this is not a version.
    '/docker-fundamentals/latest/index.html',
  ])('leaves API routes to the API: %s', (url) => {
    expect(isCoursePath(url)).toBe(false);
  });

  it('resolves dot segments the way the course handler does', () => {
    // Climbs out of the version before any server sees it — so it is not a
    // course path, and the course handler would not have served it either.
    expect(isCoursePath('/docker-fundamentals/1.0.0/../../me')).toBe(false);
  });
});
