import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type Role, type User } from '@prisma/client';

import { AppConfigService } from '../config/index.js';
import { PrismaService } from '../prisma/index.js';
import type { PublicUser } from './auth.types.js';
import type { ChangePasswordInput, LoginInput, RegisterInput } from './dto/auth.schemas.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly config: AppConfigService,
  ) {}

  static toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: user.avatarUrl,
      timezone: user.timezone,
      createdAt: user.createdAt,
    };
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('base64url');
  }

  // ── registration ──────────────────────────────────────────────────────────

  async register(input: RegisterInput): Promise<User> {
    const signupMode = this.config.get('SIGNUP_MODE');

    if (signupMode === 'closed') {
      throw new ForbiddenException('Signup is closed.');
    }

    const invite =
      signupMode === 'invite_only'
        ? await this.consumeInvitePrecheck(input.inviteToken, input.email)
        : null;

    const passwordHash = await this.passwords.hash(input.password);

    try {
      // One transaction so a valid invite is never burned by a failed insert,
      // and never usable twice by two requests racing each other.
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: input.email,
            name: input.name,
            passwordHash,
            role: invite?.role ?? 'learner',
          },
        });

        if (invite) {
          const { count } = await tx.invite.updateMany({
            // The acceptedAt guard is what makes this safe under concurrency:
            // the second writer updates zero rows and the transaction aborts.
            where: { id: invite.id, acceptedAt: null, revokedAt: null },
            data: { acceptedAt: new Date(), acceptedById: user.id },
          });

          if (count !== 1) {
            throw new ConflictException('That invite has already been used.');
          }
        }

        await tx.progressEvent.create({
          data: { userId: user.id, type: 'user.registered', payload: { signupMode } },
        });

        return user;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Unique violation on email. Same message either way — see the note in login().
        throw new ConflictException('That email address is already registered.');
      }
      throw error;
    }
  }

  /**
   * Validates the invite before any expensive work, and returns it so the
   * transaction can claim it. Returns the row, never the token.
   */
  private async consumeInvitePrecheck(token: string | undefined, email: string) {
    if (!token) {
      throw new ForbiddenException('Signup is invite-only. An invite token is required.');
    }

    const invite = await this.prisma.invite.findUnique({
      where: { tokenHash: AuthService.hashToken(token) },
    });

    if (!invite || invite.revokedAt || invite.acceptedAt || invite.expiresAt <= new Date()) {
      throw new ForbiddenException('That invite is invalid or has expired.');
    }

    // The invite is addressed to a person; it is not a transferable signup code.
    if (invite.email.toLowerCase() !== email) {
      throw new ForbiddenException('That invite was issued for a different email address.');
    }

    return invite;
  }

  // ── login ─────────────────────────────────────────────────────────────────

  async validateCredentials(input: LoginInput): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });

    // No account, a soft-deleted account, or an OAuth-only account: spend the
    // same time as a real verify and return the same error. Anything else turns
    // this endpoint into an account-existence oracle.
    if (!user || user.deletedAt || !user.passwordHash) {
      await this.passwords.verifyDummy(input.password);
      throw new UnauthorizedException('Invalid email or password.');
    }

    const valid = await this.passwords.verify(user.passwordHash, input.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    if (this.passwords.needsRehash(user.passwordHash)) {
      await this.rehash(user.id, input.password);
    }

    return user;
  }

  private async rehash(userId: string, password: string): Promise<void> {
    try {
      const passwordHash = await this.passwords.hash(password);
      await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
      this.logger.log(`Upgraded password hash parameters for user ${userId}`);
    } catch (error) {
      // Never fail a valid login because the opportunistic upgrade failed.
      this.logger.warn({ err: error }, 'Password rehash failed');
    }
  }

  async recordLogin(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } }),
      this.prisma.progressEvent.create({ data: { userId, type: 'user.logged_in' } }),
    ]);
  }

  // ── account ───────────────────────────────────────────────────────────────

  async findById(userId: string): Promise<User | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user?.deletedAt ? null : user;
  }

  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    keepSessionId: string,
  ): Promise<{ revokedSessions: number }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user?.passwordHash) {
      throw new BadRequestException('This account has no password set.');
    }

    const valid = await this.passwords.verify(user.passwordHash, input.currentPassword);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect.');
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });

    // A password change is the user's lever for "log everyone else out".
    const revokedSessions = await this.sessions.revokeAllForUser(userId, keepSessionId);

    await this.prisma.progressEvent.create({
      data: { userId, type: 'user.password_changed', payload: { revokedSessions } },
    });

    return { revokedSessions };
  }

  // ── invites ───────────────────────────────────────────────────────────────

  /**
   * Returns the raw token exactly once, for the invite link. Only its hash is
   * stored, so a leaked database cannot be turned into working invites.
   */
  async createInvite(
    invitedById: string,
    email: string,
    role: Role = 'learner',
    ttlDays = 14,
  ): Promise<{ token: string; id: string; expiresAt: Date }> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing && !existing.deletedAt) {
      throw new ConflictException('That email address already has an account.');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    const invite = await this.prisma.invite.create({
      data: {
        email,
        tokenHash: AuthService.hashToken(token),
        invitedById,
        role,
        expiresAt,
      },
    });

    return { token, id: invite.id, expiresAt: invite.expiresAt };
  }
}
