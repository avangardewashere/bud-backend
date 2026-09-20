/**
 * Development seed. Creates the master admin described in Overall Plan section 2.
 *
 * Idempotent: running it twice changes nothing. It refuses to run against a
 * production database, because the one thing worse than no admin account is a
 * known admin password in production.
 */
import { existsSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { hash, Algorithm } from '@node-rs/argon2';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const { NODE_ENV, DATABASE_URL, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_NAME } =
  process.env;

async function main(): Promise<void> {
  if (NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set.');
  }

  const email = (SEED_ADMIN_EMAIL ?? 'admin@bud.local').trim().toLowerCase();
  const password = SEED_ADMIN_PASSWORD;

  if (!password) {
    throw new Error(
      'SEED_ADMIN_PASSWORD is not set. Add it to .env — the seed will not invent one.',
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });

  try {
    const passwordHash = await hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const admin = await prisma.user.upsert({
      where: { email },
      // Do not reset the password of an admin that already exists; someone may
      // have changed it deliberately.
      update: { role: 'admin' },
      create: {
        email,
        name: SEED_ADMIN_NAME ?? 'Bud Admin',
        passwordHash,
        role: 'admin',
      },
    });

    console.log(`✔ admin user ready: ${admin.email} (${admin.id})`);
    console.log('  Sign in at POST /auth/login with the SEED_ADMIN_PASSWORD from .env');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
