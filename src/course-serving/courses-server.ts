import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfigService } from '../config/app-config.service.js';
import { contentTypeFor } from '../storage/content-types.js';
import type { StorageService } from '../storage/storage.service.js';

/**
 * Serves course content on its **own origin**, separate from both the shell and
 * the API.
 *
 * This is the load-bearing security boundary of the whole product. Course
 * JavaScript is author-controlled and we never review it; on a separate origin,
 * inside a frame sandboxed without `allow-same-origin`, it cannot read the
 * shell's cookies, DOM or storage. It can only talk through `postMessage`, which
 * the shell validates. Nothing else in the CSP matters as much as that.
 *
 * Mirrors the shell's development server (`Bud - frontend/tools/courses-server.mjs`)
 * deliberately: two implementations that disagree would mean a course works in
 * development and breaks in production, or the reverse.
 *
 * A separate listener rather than a route on the API, because a *different
 * port is not a different origin for cookies* — they ignore ports. In
 * production this is a different hostname (courses.bud.example); in development
 * it is 127.0.0.1 against the shell's localhost, which differ by host.
 */

/** `/{courseId}/{version}/{path}` — the storage prefix, exactly. */
const COURSE_PATH = /^\/([a-z0-9-]+)\/([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\/(.+)$/;

export function buildCoursesServer(
  storage: StorageService,
  config: AppConfigService,
): FastifyInstance {
  const appOrigin = config.get('APP_ORIGIN');
  const coursesOrigin = config.get('COURSES_ORIGIN');

  /**
   * A document sandboxed without `allow-same-origin` has an opaque origin, so
   * `'self'` matches nothing — every source has to be named outright.
   *
   * The worksheets carry inline <style> and <script>, so both need
   * 'unsafe-inline'. That is acceptable for an opaque-origin frame with no
   * cookie or storage access; hashing inline scripts at upload time is the
   * long-term fix.
   *
   * `connect-src 'none'` is the one worth noticing: a course cannot make network
   * requests at all, so it cannot exfiltrate what a learner types. Its only way
   * out is the bridge.
   */
  const csp = [
    `default-src 'none'`,
    `script-src ${coursesOrigin} ${appOrigin} 'unsafe-inline'`,
    `style-src ${coursesOrigin} 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src https://fonts.gstatic.com data:`,
    `img-src ${coursesOrigin} data:`,
    `connect-src 'none'`,
    `form-action 'none'`,
    `base-uri 'none'`,
    // Only the shell may frame a course.
    `frame-ancestors ${appOrigin}`,
  ].join('; ');

  const bridgeTag = `<script src="${appOrigin}/bridge.js"></script>`;

  const server = Fastify({ logger: false, bodyLimit: 1024 });

  server.get('/health', (_request, reply) => reply.type('text/plain').send('ok'));

  server.get('/*', async (request, reply) => {
    const path = new URL(request.url, coursesOrigin).pathname;
    const match = COURSE_PATH.exec(path);

    reply.header('x-content-type-options', 'nosniff');

    if (!match) {
      return reply.code(404).type('text/plain').send('not found');
    }

    const [, courseId, version, filePath] = match;

    // The regex already excludes `..` by construction, but decoding can
    // reintroduce it — check the decoded form before it reaches storage.
    let decoded: string;
    try {
      decoded = decodeURIComponent(filePath);
    } catch {
      return reply.code(400).type('text/plain').send('bad request');
    }

    if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('\0')) {
      return reply.code(403).type('text/plain').send('forbidden');
    }

    const contentType = contentTypeFor(decoded);
    if (contentType === 'application/octet-stream') {
      // Serving a type the course spec does not allow would mean serving
      // something the validator never inspected.
      return reply.code(415).type('text/plain').send('unsupported type');
    }

    const key = `courses/${courseId}/${version}/${decoded}`;

    let body: string | Uint8Array;
    try {
      body = contentType.startsWith('text/')
        ? await storage.getText(key)
        : await storage.getBytes(key);
    } catch {
      return reply.code(404).type('text/plain').send('not found');
    }

    reply.header('content-security-policy', csp);
    // A course version is immutable, so its files can be cached forever.
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    reply.type(contentType);

    if (!contentType.startsWith('text/html')) {
      return reply.send(body);
    }

    return reply.send(injectBridge(String(body), bridgeTag));
  });

  return server;
}

/**
 * The Docker worksheets are fragments: no <html> and no <head>, they open
 * straight with <meta charset>. Put the bridge after that meta when there is no
 * head to use, so the charset declaration stays first in the document — a
 * charset declared late is a charset ignored.
 */
export function injectBridge(html: string, bridgeTag: string): string {
  // `<head(\s...)?>` rather than `<head[^>]*>`, which would also match <header>.
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    return html.replace(head[0], `${head[0]}\n${bridgeTag}`);
  }

  const charset = /<meta[^>]+charset[^>]*>/i.exec(html);
  if (charset) {
    return html.replace(charset[0], `${charset[0]}\n${bridgeTag}`);
  }

  // No head and no charset: the bridge still has to load, so prepend it.
  return `${bridgeTag}\n${html}`;
}
