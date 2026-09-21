/**
 * Create an invite. Compiled into dist/ so it runs in the production image.
 *
 *   npm run invite -- someone@example.com
 *   npm run invite -- someone@example.com --admin --days 30
 *
 * There is no invite UI and deliberately will not be one until there is a
 * second learner (Overall Plan §8.1). The README has been telling people to
 * "create invites from a script" since Phase 0, so here is the script rather
 * than an instruction to go and write raw SQL.
 *
 * The token is printed once and never again: only its SHA-256 is stored, so a
 * database dump cannot be turned into working invites. Lose it and revoke the
 * row, then make another.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

function usage(message: string): never {
  console.error(`${message}\n`);
  console.error('Usage: npm run invite -- <email> [--admin] [--days N]');
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args
    .find((a) => !a.startsWith('--'))
    ?.trim()
    .toLowerCase();

  if (!email) {
    usage('An email address is required.');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    usage(`"${email}" does not look like an email address.`);
  }

  const role = args.includes('--admin') ? 'admin' : 'learner';

  const daysAt = args.indexOf('--days');
  const days = daysAt === -1 ? 14 : Number(args[daysAt + 1]);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    usage('--days must be a whole number of days between 1 and 365.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && !existing.deletedAt) {
      usage(`${email} already has an account. They can just sign in.`);
    }

    // An invite is issued by someone. With no invite UI there is no "current
    // user", so it is attributed to an admin — which is also the only role
    // that could have created one through an API.
    const admin = await prisma.user.findFirst({ where: { role: 'admin', deletedAt: null } });
    if (!admin) {
      usage('No admin user exists to issue the invite. Run `npm run db:seed` first.');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await prisma.invite.create({
      data: {
        email,
        tokenHash: createHash('sha256').update(token).digest('base64url'),
        invitedById: admin.id,
        role,
        expiresAt,
      },
    });

    const appOrigin = process.env.APP_ORIGIN ?? 'http://localhost:3100';

    console.log(`\nInvite created for ${email} as ${role}.`);
    console.log(`Expires ${expiresAt.toISOString()} (${days} days).\n`);
    console.log('Send them this link:\n');
    console.log(`  ${appOrigin}/register?invite=${token}\n`);
    console.log('Or the token on its own, for POST /auth/register:\n');
    console.log(`  ${token}\n`);
    console.log('This is the only time it is shown — only its hash is stored.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('\nCould not create the invite:', error instanceof Error ? error.message : error);
  process.exit(1);
});
