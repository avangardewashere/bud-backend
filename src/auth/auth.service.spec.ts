import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import type { AppConfigService } from '../config/app-config.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';
import type { PasswordService } from './password.service.js';
import type { SessionService } from './session.service.js';

/**
 * Registration, from the one angle where a mistake is a security bug: whether
 * the answer ever depends on the email address already having an account.
 *
 * The README has claimed since Phase 0 that this is unreachable under the
 * default `SIGNUP_MODE=invite_only`. It was true, and nothing held it true —
 * `AuthService` had no spec at all. These tests are that.
 *
 * The property is asserted structurally as well as by response: a refusal must
 * not read the user table, must not spend an argon2 hash, and must not open a
 * transaction. That survives every reword of every message, and it is what a
 * future refactor trips over. A test that only compared two 403 bodies would
 * pass happily on code that looked the account up first and then said nothing
 * about it — which is the same leak with better manners, because the timing
 * still answers.
 */

const TAKEN = 'taken@bud.local';
const FREE = 'free@bud.local';
const TOKEN = 'an-invite-token';
const TOKEN_HASH = AuthService.hashToken(TOKEN);

function invite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite-1',
    email: TAKEN,
    tokenHash: TOKEN_HASH,
    role: 'learner',
    acceptedAt: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    invitedById: 'admin-1',
    ...overrides,
  };
}

function makeService(
  options: {
    signupMode?: 'invite_only' | 'open' | 'closed';
    invite?: Record<string, unknown> | null;
    /** How many invite rows the claiming update touches. 1 is the happy path. */
    claimed?: number;
    /** Make the user insert fail the way a duplicate email does. */
    duplicateEmail?: boolean;
  } = {},
) {
  const created = { id: 'user-new', email: FREE, role: 'learner' };

  const tx = {
    user: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        options.duplicateEmail
          ? Promise.reject(
              new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
                code: 'P2002',
                clientVersion: 'test',
              }),
            )
          : Promise.resolve({ ...created, ...data }),
      ),
    },
    invite: { updateMany: vi.fn(() => Promise.resolve({ count: options.claimed ?? 1 })) },
    progressEvent: { create: vi.fn(() => Promise.resolve({})) },
  };

  const prisma = {
    // Answers honestly, so a test can tell "never asked" from "asked and
    // ignored the answer".
    user: {
      findUnique: vi.fn(({ where }: { where: { email?: string } }) =>
        Promise.resolve(
          where.email === TAKEN ? { id: 'user-taken', email: TAKEN, deletedAt: null } : null,
        ),
      ),
      update: vi.fn(() => Promise.resolve({})),
    },
    invite: {
      findUnique: vi.fn(() =>
        Promise.resolve(options.invite === undefined ? invite() : (options.invite ?? null)),
      ),
      create: vi.fn(() => Promise.resolve({ id: 'invite-new', expiresAt: new Date() })),
    },
    progressEvent: { create: vi.fn(() => Promise.resolve({})) },
    $transaction: vi.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  const passwords = {
    hash: vi.fn(() => Promise.resolve('$argon2id$fake')),
    verify: vi.fn(() => Promise.resolve(true)),
    verifyDummy: vi.fn(() => Promise.resolve(false as const)),
    needsRehash: vi.fn(() => false),
  };

  const sessions = { revokeAllForUser: vi.fn(() => Promise.resolve(0)) };

  const config = {
    get: (key: string) =>
      key === 'SIGNUP_MODE' ? (options.signupMode ?? 'invite_only') : undefined,
  } as unknown as AppConfigService;

  const service = new AuthService(
    prisma as unknown as PrismaService,
    passwords as unknown as PasswordService,
    sessions as unknown as SessionService,
    config,
  );

  return { service, prisma, passwords, tx };
}

/** What a caller sees, reduced to the parts the shell branches on. */
async function refusalFor(email: string, inviteToken?: string, signupMode?: 'closed') {
  const { service, prisma, passwords } = makeService({
    signupMode,
    invite: inviteToken === TOKEN ? undefined : null,
  });

  try {
    await service.register({
      email,
      password: 'a-password-of-some-length',
      name: 'A',
      inviteToken,
    });
  } catch (error) {
    const refused = error as { getStatus(): number; getResponse(): unknown };
    return {
      answer: { status: refused.getStatus(), body: refused.getResponse() },
      readUsers: prisma.user.findUnique.mock.calls.length,
      hashes: passwords.hash.mock.calls.length,
      transactions: prisma.$transaction.mock.calls.length,
    };
  }

  throw new Error(`register() did not refuse ${email}`);
}

describe('AuthService.register', () => {
  describe('cannot tell a taken address from a free one', () => {
    // Each case: the same request for an address that has an account and one
    // that does not. The answers must be indistinguishable, and the work done
    // must be none.
    it.each([
      ['no invite token at all', undefined, undefined],
      ['an invite token nobody issued', 'not-a-real-token', undefined],
      ['signup closed', undefined, 'closed' as const],
    ])('%s', async (_case, token, signupMode) => {
      const taken = await refusalFor(TAKEN, token, signupMode);
      const free = await refusalFor(FREE, token, signupMode);

      expect(taken.answer).toEqual(free.answer);
      expect(taken.answer.status).toBe(403);

      // The structural half. Nothing here could have known the answer.
      for (const outcome of [taken, free]) {
        expect(outcome.readUsers).toBe(0);
        expect(outcome.hashes).toBe(0);
        expect(outcome.transactions).toBe(0);
      }
    });

    it('refuses an invite issued for a different address without looking either up', async () => {
      const { service, prisma, passwords } = makeService();

      // The invite in this fixture is addressed to TAKEN.
      await expect(
        service.register({
          email: FREE,
          password: 'a-password-of-some-length',
          name: 'A',
          inviteToken: TOKEN,
        }),
      ).rejects.toMatchObject({ code: 'invite_invalid' });

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(passwords.hash).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('looks an invite up by token hash and nothing else', async () => {
      const { service, prisma } = makeService({ invite: null });

      await expect(
        service.register({
          email: TAKEN,
          password: 'a-password-of-some-length',
          name: 'A',
          inviteToken: TOKEN,
        }),
      ).rejects.toMatchObject({ code: 'invite_invalid' });

      // The whole anti-enumeration property in one assertion: the only thing the
      // database was asked about is a token the caller already holds.
      expect(prisma.invite.findUnique).toHaveBeenCalledWith({ where: { tokenHash: TOKEN_HASH } });
    });

    it.each([
      ['revoked', { revokedAt: new Date() }],
      ['already accepted', { acceptedAt: new Date() }],
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ])('refuses a %s invite the same way as an unknown one', async (_case, overrides) => {
      const { service } = makeService({ invite: invite(overrides) });
      const unknown = makeService({ invite: null });

      const answers = await Promise.all(
        [service, unknown.service].map(async (candidate) => {
          try {
            await candidate.register({
              email: TAKEN,
              password: 'a-password-of-some-length',
              name: 'A',
              inviteToken: TOKEN,
            });
          } catch (error) {
            const refused = error as { getStatus(): number; getResponse(): unknown };
            return { status: refused.getStatus(), body: refused.getResponse() };
          }
          throw new Error('did not refuse');
        }),
      );

      expect(answers[0]).toEqual(answers[1]);
    });
  });

  describe('the one case where a taken address is visible', () => {
    it('answers 409 email_taken to the holder of a valid invite for that address', async () => {
      // Deliberate, and the boundary of the claim above: whoever was issued this
      // invite already knew the address. Documented in README's security table.
      const { service, passwords } = makeService({ duplicateEmail: true });

      await expect(
        service.register({
          email: TAKEN,
          password: 'a-password-of-some-length',
          name: 'A',
          inviteToken: TOKEN,
        }),
      ).rejects.toMatchObject({ code: 'email_taken' });

      // And it cost a hash, i.e. the refusal happened at the insert rather than
      // by looking the address up first.
      expect(passwords.hash).toHaveBeenCalledOnce();
    });
  });

  describe('claiming the invite', () => {
    it('takes the invited role, not the requested one', async () => {
      const { service, tx } = makeService({ invite: invite({ role: 'admin' }) });

      await service.register({
        email: TAKEN,
        password: 'a-password-of-some-length',
        name: 'A',
        inviteToken: TOKEN,
      });

      expect(tx.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ role: 'admin' }) }),
      );
    });

    it('refuses when the claiming update touches no row, so two racing signups cannot share one invite', async () => {
      const { service, tx } = makeService({ claimed: 0 });

      await expect(
        service.register({
          email: TAKEN,
          password: 'a-password-of-some-length',
          name: 'A',
          inviteToken: TOKEN,
        }),
      ).rejects.toMatchObject({ code: 'invite_invalid' });

      // The guard is in the where clause, which is what makes it atomic.
      expect(tx.invite.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ acceptedAt: null, revokedAt: null }),
        }),
      );
    });

    it('records the registration with the mode it happened under', async () => {
      const { service, tx } = makeService();

      await service.register({
        email: TAKEN,
        password: 'a-password-of-some-length',
        name: 'A',
        inviteToken: TOKEN,
      });

      expect(tx.progressEvent.create).toHaveBeenCalledWith({
        data: {
          userId: expect.any(String),
          type: 'user.registered',
          payload: { signupMode: 'invite_only' },
        },
      });
    });
  });

  describe('with SIGNUP_MODE=open', () => {
    it('registers without an invite, and the 409 is then an oracle for anyone', async () => {
      // Pinned as the known cost of that mode rather than as desired behaviour:
      // boot refuses `open` unless SIGNUP_OPEN_ACK_ENUMERATION says the operator
      // accepts exactly this. See config/env.schema.ts.
      const free = makeService({ signupMode: 'open' });
      await expect(
        free.service.register({ email: FREE, password: 'a-password-of-some-length', name: 'A' }),
      ).resolves.toMatchObject({ email: FREE });
      expect(free.prisma.invite.findUnique).not.toHaveBeenCalled();

      const taken = makeService({ signupMode: 'open', duplicateEmail: true });
      await expect(
        taken.service.register({ email: TAKEN, password: 'a-password-of-some-length', name: 'A' }),
      ).rejects.toMatchObject({ code: 'email_taken' });
    });
  });
});

describe('AuthService.validateCredentials', () => {
  const input = { email: FREE, password: 'whatever-they-typed' };

  it('spends a verify on an address with no account, and says the same thing', async () => {
    // The other half of the README's "no account enumeration" claim, which was
    // also untested: a missing account must cost what a wrong password costs.
    const { service, passwords } = makeService();

    await expect(service.validateCredentials(input)).rejects.toMatchObject({
      message: 'Invalid email or password.',
    });

    expect(passwords.verifyDummy).toHaveBeenCalledWith(input.password);
    expect(passwords.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['soft-deleted', { deletedAt: new Date(), passwordHash: '$argon2id$real' }],
    ['OAuth-only, with no password set', { deletedAt: null, passwordHash: null }],
  ])('treats a %s account exactly like a missing one', async (_case, overrides) => {
    const { service, passwords, prisma } = makeService();
    prisma.user.findUnique = vi.fn(() =>
      Promise.resolve({ id: 'user-x', email: FREE, ...overrides }),
    ) as never;

    await expect(service.validateCredentials(input)).rejects.toMatchObject({
      message: 'Invalid email or password.',
    });

    expect(passwords.verifyDummy).toHaveBeenCalledOnce();
  });

  it('gives a wrong password the same error as a missing account', async () => {
    const { service, passwords, prisma } = makeService();
    prisma.user.findUnique = vi.fn(() =>
      Promise.resolve({
        id: 'user-x',
        email: FREE,
        deletedAt: null,
        passwordHash: '$argon2id$real',
      }),
    );
    passwords.verify = vi.fn(() => Promise.resolve(false));

    await expect(service.validateCredentials(input)).rejects.toMatchObject({
      message: 'Invalid email or password.',
    });
  });
});
