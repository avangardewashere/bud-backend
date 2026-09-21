import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfigService } from '../config/app-config.service.js';
import { contentTypeFor } from '../storage/content-types.js';
import type { StorageService } from '../storage/storage.service.js';
import type { PublishedVersions } from './published-versions.js';

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
 * A separate Fastify instance rather than a route on the API, so none of the
 * API's plugins — helmet's headers, CORS, the rate limiter, multipart — ever
 * touch a course response, and this file's CSP is the only policy a course gets.
 *
 * Normally it also has its own listener: a *different port is not a different
 * origin for cookies*, so in production it sits on its own hostname. It can
 * instead share the API's port (COURSES_PORT = PORT), for hosts that expose
 * only one. That is still isolated where it matters — the thing course code
 * must not share an origin with is the *shell*, whose session cookie lives on
 * the app's origin — and main.ts documents why that holds.
 */

/**
 * The sandbox every course document runs in. Must match the player iframe's
 * `sandbox` attribute (Bud - frontend CoursePlayer.tsx) flag for flag: tighter
 * breaks courses in the player, looser is a hole. Never `allow-same-origin`.
 */
export const COURSE_SANDBOX_FLAGS = 'allow-scripts allow-forms allow-modals';

/** `/{courseId}/{version}/{path}` — the storage prefix, exactly. */
const COURSE_PATH = /^\/([a-z0-9-]+)\/([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\/(.+)$/;

/**
 * Whether a request URL is course content rather than an API call.
 *
 * Decides where a request goes when course content shares the API's port (see
 * main.ts). It is safe to check this first because the two shapes cannot
 * overlap: a course path's second segment is always a version (`1.0.0`), no
 * API route has one there, and a course slug cannot contain the dots a version
 * needs. The e2e suite holds every API route in the OpenAPI document to that.
 *
 * Parses the URL the same way the course handler does, dot segments and all,
 * so the two can never disagree about what a path is.
 */
export function isCoursePath(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    return false;
  }
  return COURSE_PATH.test(pathname);
}

export function buildCoursesServer(
  storage: StorageService,
  config: AppConfigService,
  published: PublishedVersions,
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
   *
   * `sandbox` makes every course document opaque-origin *however it is
   * reached*, not only inside the player's sandboxed iframe. Without it, a
   * document opened directly runs on whatever origin served it — and behind
   * the shell's /api proxy, that is the shell's own origin, where course
   * JavaScript could open a same-origin window and act as the learner. The
   * flags are exactly the player iframe's (CoursePlayer.tsx), so a course
   * behaves identically in both, and neither grants allow-same-origin.
   */
  const csp = [
    `sandbox ${COURSE_SANDBOX_FLAGS}`,
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

    // Only the version the catalog is serving. Without this the origin handed
    // out any version ever uploaded to anyone who guessed a slug and a version
    // number, so unpublishing a course 404'd the catalog while its files stayed
    // readable — a withdrawal that withdrew nothing.
    if (!(await published.isPublic(courseId, version))) {
      // 404 rather than 403: a draft should not be distinguishable from a
      // course that never existed, which is the same rule the catalog follows.
      return reply.code(404).type('text/plain').send('not found');
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
