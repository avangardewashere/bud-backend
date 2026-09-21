/**
 * Create the first admin on a fresh database — production included.
 *
 *   node dist/cli/create-admin.js you@example.com
 *   node dist/cli/create-admin.js you@example.com --name "Your Name"
 *
 * A new deployment otherwise has no way in. The seed refuses production on
 * purpose (a known admin password in production is worse than none), and the
 * invite script needs an admin to issue invites as. This closes that gap
 * without reopening the one the seed guards: there is no password to set, so
 * none can end up in an environment variable, a shell history or a repo.
 * A strong one is generated, printed once, and only its hash is stored.
 *
 * Bootstrap only. It refuses to run once any admin exists — every later admin
 * arrives through `npm run invite -- <email> --admin`, which leaves a trail of
 * who invited whom.
 *
 * Lives in src/ rather than scripts/ so it is compiled into dist/ and ships in
 * the production image, which has no tsx and no dev dependencies.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { PasswordService } from '../auth/password.service.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  console.error('Usage: node dist/cli/create-admin.js <email> [--name "Your Name"]');
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const nameAt = args.indexOf('--name');
  const name = nameAt === -1 ? 'Bud Admin' : args[nameAt + 1]?.trim();
  if (!name) {
    fail('--name needs a value.');
  }

  // Skip --name and its value. Guarded: with no --name, nameAt + 1 is 0 and an
  // unguarded filter would drop the email itself.
  const email = args
    .filter((_, i) => nameAt === -1 || (i !== nameAt && i !== nameAt + 1))
    .find((a) => !a.startsWith('--'))
    ?.trim()
    .toLowerCase();

  if (!email) {
    fail('An email address is required.');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fail(`"${email}" does not look like an email address.`);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail('DATABASE_URL is not set.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 15_000 }),
  });

  try {
    const admin = await prisma.user.findFirst({
      where: { role: 'admin', deletedAt: null },
      select: { email: true },
    });
    if (admin) {
      fail(
        `An admin already exists (${admin.email}), so this bootstrap step is done.\n` +
          `Add more admins with: npm run invite -- <email> --admin`,
      );
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      fail(`${email} already has an account. Choose an address that does not.`);
    }

    // 24 random bytes: 32 characters of base64url, ~192 bits.
    const password = randomBytes(24).toString('base64url');
    const passwordHash = await new PasswordService().hash(password);

    const user = await prisma.user.create({
      data: { email, name, passwordHash, role: 'admin' },
    });

    console.log(`\nAdmin created: ${user.email}\n`);
    console.log('Password (shown once — only its hash is stored):\n');
    console.log(`  ${password}\n`);
    console.log('Save it in a password manager. It is strong enough to keep as it is.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('\nCould not create the admin:', error instanceof Error ? error.message : error);
  process.exit(1);
});
