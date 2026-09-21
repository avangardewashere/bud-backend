import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthSession } from '@prisma/client';
import type { FastifyReply } from 'fastify';

import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RequestSession, RequestUser } from './auth.types.js';

/**
 * Sessions are owned by the API, not the browser and not a JWT.
 *
 * The cookie holds a 256-bit random id. Only its SHA-256 lives in the database,
 * so a dump of auth_sessions cannot be replayed as live logins. Sessions carry
 * both an absolute expiry (never extended) and an idle expiry (slides forward),
 * and can be revoked server-side at any time — the thing JWTs cannot do.
 */
@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionService.name);

  /**
   * Expired rows are dead weight: every sign-in adds one and nothing removed
   * them, so the table only ever grew. `resolve()` deletes the expired row it
   * happens to touch, but a session nobody comes back to is never touched
   * again — which is exactly the case that accumulates.
   */
  private static readonly PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  /** Long enough that boot is not competing with a delete on a cold database. */
  private static readonly PRUNE_DELAY_MS = 60_000;

  private pruneTimer?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;

  /**
   * Writing lastUsedAt on every single request would turn every read into a
   * write. Slide the idle window at most this often instead.
   */
  private static readonly TOUCH_INTERVAL_MS = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    const prune = () => {
      void this.pruneExpired()
        .then((count) => {
          if (count > 0) {
            this.logger.log(`Pruned ${count} expired session${count === 1 ? '' : 's'}`);
          }
        })
        // Housekeeping failing must never take the process with it.
        .catch((error: unknown) => this.logger.warn({ err: error }, 'Session prune failed'));
    };

    this.startupTimer = setTimeout(prune, SessionService.PRUNE_DELAY_MS);
    this.pruneTimer = setInterval(prune, SessionService.PRUNE_INTERVAL_MS);

    // Neither timer should keep the process alive: a container that will not
    // exit on SIGTERM gets killed instead, and in tests it would hang the run.
    this.startupTimer.unref();
    this.pruneTimer.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.startupTimer);
    clearInterval(this.pruneTimer);
  }

  /** Hash a raw cookie value into the database key. */
  private static hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('base64url');
  }

  /**
   * Creates a session row and returns the raw token for the cookie.
   * The raw token is never stored and never logged.
   */
  async create(
    userId: string,
    meta: { userAgent?: string; ip?: string },
  ): Promise<{ rawToken: string; session: AuthSession }> {
    const rawToken = randomBytes(32).toString('base64url');
    const now = Date.now();

    const session = await this.prisma.authSession.create({
      data: {
        id: SessionService.hashToken(rawToken),
        userId,
        expiresAt: new Date(now + this.config.sessionAbsoluteTtlMs),
        idleExpiresAt: new Date(now + this.config.sessionIdleTtlMs),
        userAgent: meta.userAgent?.slice(0, 512),
        ip: meta.ip,
      },
    });

    return { rawToken, session };
  }

  /**
   * Resolves a cookie value to a live session and its user, or null.
   * Returns null for every failure mode — expired, revoked, deleted user —
   * so callers cannot accidentally distinguish them.
   */
  async resolve(rawToken: string): Promise<{ user: RequestUser; session: RequestSession } | null> {
    const id = SessionService.hashToken(rawToken);

    const session = await this.prisma.authSession.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, email: true, name: true, role: true, deletedAt: true },
        },
      },
    });

    if (!session || session.revokedAt || session.user.deletedAt) {
      return null;
    }

    const now = new Date();
    if (session.expiresAt <= now || session.idleExpiresAt <= now) {
      // Expired sessions are dead weight; drop the row rather than leave it.
      await this.prisma.authSession.delete({ where: { id } }).catch(() => undefined);
      return null;
    }

    await this.touch(session, now);

    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role: session.user.role,
      },
      session: {
        id: session.id,
        expiresAt: session.expiresAt,
        idleExpiresAt: session.idleExpiresAt,
      },
    };
  }

  /** Slides the idle window, but only occasionally — see TOUCH_INTERVAL_MS. */
  private async touch(session: AuthSession, now: Date): Promise<void> {
    if (now.getTime() - session.lastUsedAt.getTime() < SessionService.TOUCH_INTERVAL_MS) {
      return;
    }

    const idleExpiresAt = new Date(now.getTime() + this.config.sessionIdleTtlMs);

    await this.prisma.authSession
      .update({
        where: { id: session.id },
        // Never push idle expiry past the absolute expiry.
        data: {
          lastUsedAt: now,
          idleExpiresAt: idleExpiresAt > session.expiresAt ? session.expiresAt : idleExpiresAt,
        },
      })
      .catch((error: unknown) => {
        // A failed touch must not fail the request the user actually made.
        this.logger.warn({ err: error }, 'Failed to touch session');
      });

    await this.prisma.user
      .update({ where: { id: session.userId }, data: { lastSeenAt: now } })
      .catch(() => undefined);
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.authSession.delete({ where: { id: sessionId } }).catch(() => undefined);
  }

  /** Used when a password changes: every other session for that user dies. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    const { count } = await this.prisma.authSession.deleteMany({
      where: {
        userId,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
    });
    return count;
  }

  /** Housekeeping. Safe to call from a cron or a deploy step. */
  async pruneExpired(): Promise<number> {
    const now = new Date();
    const { count } = await this.prisma.authSession.deleteMany({
      where: {
        OR: [{ expiresAt: { lte: now } }, { idleExpiresAt: { lte: now } }],
      },
    });
    return count;
  }

  // ── cookie plumbing ───────────────────────────────────────────────────────

  get cookieName(): string {
    return this.config.get('SESSION_COOKIE_NAME');
  }

  setCookie(reply: FastifyReply, rawToken: string, expiresAt: Date): void {
    reply.setCookie(this.cookieName, rawToken, {
      ...this.cookieOptions(),
      expires: expiresAt,
    });
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(this.cookieName, this.cookieOptions());
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE'),
      // Lax, not Strict: the GitHub OAuth callback is a cross-site top-level
      // navigation back to us, and Strict would drop the cookie on arrival.
      sameSite: 'lax' as const,
      path: '/',
      domain: this.config.get('COOKIE_DOMAIN'),
    };
  }

  /** Constant-time compare, for anywhere a token is checked outside the DB lookup. */
  static safeEqual(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) {
      return false;
    }
    return timingSafeEqual(bufferA, bufferB);
  }
}
