import type { Role } from '@prisma/client';
import type { FastifyRequest } from 'fastify';

/** The slice of the user that guards resolve and controllers actually need. */
export interface RequestUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface RequestSession {
  /** The hashed session id, i.e. the AuthSession primary key. Never the cookie value. */
  id: string;
  expiresAt: Date;
  idleExpiresAt: Date;
}

/**
 * FastifyRequest is augmented in src/types/fastify.d.ts with `user` and
 * `budSession`; this alias just names the intent at call sites.
 */
export type AuthenticatedRequest = FastifyRequest;

/** Shape returned by /me and by the auth endpoints. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarUrl: string | null;
  timezone: string;
  createdAt: Date;
}
