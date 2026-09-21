import { get } from 'node:http';

import { describe, expect, it } from 'vitest';

import { isCoursePath } from '../../src/course-serving/courses-server.js';
import { API_BASE, apiIsUp } from './client.js';

/**
 * When course content shares the API's port, a request is routed by its path
 * alone, and course paths are checked first. An API route shaped like course
 * content would be shadowed — silently, since the course server would answer
 * it with a 404.
 *
 * isCoursePath's unit tests list today's routes by hand, which goes stale the
 * day someone adds one. This reads the routes from the running API instead, so
 * a new route that collides fails here rather than in production.
 */

const up = await apiIsUp();

/**
 * Values each known route param can actually hold, per its validation: slugs
 * are `^[a-z0-9]+(-[a-z0-9]+)*$`, session keys `^[A-Za-z0-9_-]+$`, ids UUIDs.
 * None can contain a dot, so none can look like a version.
 */
const KNOWN_PARAMS: Record<string, string> = {
  slug: 'docker-fundamentals',
  key: 'session-1',
  id: '0196f2a8-7c1e-7cc0-a2b1-0c9a9e1b2f3d',
};

/**
 * Request paths for the route. A param this file does not know could hold
 * anything, so it is tried as each shape a collision needs — a slug in one
 * position, a version in the next — in every combination. That is how a
 * future `/{thing}/{version}/…` route gets caught. Add a param to KNOWN_PARAMS
 * only once its validation rules a version out.
 */
function concrete(route: string): string[] {
  let paths = [route];
  for (const [placeholder, name] of route.matchAll(/\{([^}]+)\}/g)) {
    const known = KNOWN_PARAMS[name];
    const tries = known ? [known] : ['docker-fundamentals', '1.0.0'];
    paths = paths.flatMap((p) => tries.map((value) => p.replace(placeholder, value)));
  }
  return paths;
}

describe.skipIf(!up)('routing between the API and course content', () => {
  it('has no API route that could be mistaken for course content', async () => {
    const response = await fetch(`${API_BASE}/docs/openapi.json`);
    expect(response.status, 'OpenAPI document (served outside production)').toBe(200);

    const document = (await response.json()) as { paths: Record<string, unknown> };
    const routes = Object.keys(document.paths);

    // Guard the guard: an empty or truncated document would pass vacuously.
    expect(routes.length).toBeGreaterThan(20);

    const collisions = routes.filter((route) => concrete(route).some(isCoursePath));

    expect(collisions).toEqual([]);
  });
});

/**
 * A proxy in front of the API may cache anything it is not told not to —
 * Vercel's rewrite proxy caches upstream responses by default — and then one
 * learner's data is served to the next visitor.
 */
describe.skipIf(!up)('API responses and caches', () => {
  it('marks API responses uncacheable', async () => {
    for (const path of ['/health', '/courses', '/me', '/does-not-exist']) {
      const response = await fetch(`${API_BASE}${path}`);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });
});

/**
 * Behind a proxy that pools connections, the server must keep idle sockets
 * open longer than the proxy does, or the proxy reuses one just as it closes
 * and a request fails as an intermittent 502. A custom server factory loses
 * Fastify's own setting, so this pins the one main.ts applies.
 */
describe.skipIf(!up)('connection keep-alive', () => {
  it('holds idle connections for 120 s, not the 5 s Node defaults to', async () => {
    // Read raw: fetch implementations may hide hop-by-hop headers.
    const keepAlive = await new Promise<string | undefined>((resolve, reject) => {
      get(`${API_BASE}/health`, (res) => {
        res.resume();
        const header = res.headers['keep-alive'];
        resolve(Array.isArray(header) ? header.join(', ') : header);
      }).on('error', reject);
    });

    expect(keepAlive).toBe('timeout=120');
  });
});
