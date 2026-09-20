// Importing @fastify/cookie for its side effect pulls in the plugin's own
// declaration merging (reply.setCookie, request.cookies). Without this the
// types exist at runtime but not at compile time.
import '@fastify/cookie';
// Brings request.file() / request.parts() into the types for the upload route.
import '@fastify/multipart';

import type { RequestSession, RequestUser } from '../auth/auth.types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by SessionGuard on authenticated routes. */
    user?: RequestUser;
    /** The session behind `user`. Named to avoid colliding with fastify session plugins. */
    budSession?: RequestSession;
  }
}
