import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Algorithm, hash } from '@node-rs/argon2';

/**
 * A tiny HTTP client for the end-to-end suite.
 *
 * Everything asserted here goes through the real API over real HTTP. Prisma is
 * used only to create the suite's own fixtures, never to check them: a test
 * that reads the database to prove an endpoint worked can pass while the
 * endpoint returns nonsense.
 */

export const API_BASE = process.env.E2E_API_BASE ?? 'http://localhost:3102';
/** Only set when this process also serves course content; those tests skip otherwise. */
export const COURSES_BASE = process.env.E2E_COURSES_BASE;

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export class ApiClient {
  private cookie?: string;

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        // The shell always calls from its own origin; exercise the same path.
        origin: process.env.E2E_APP_ORIGIN ?? 'http://localhost:3100',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    // Node's fetch does not manage cookies, and the whole auth model is a
    // cookie, so keep it by hand rather than pretending with a header.
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      this.cookie = pair.endsWith('=') ? undefined : pair;
    }

    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      // Non-JSON bodies are a finding in themselves — hand back the raw text.
    }

    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  get = <T = unknown>(path: string) => this.request<T>('GET', path);
  post = <T = unknown>(path: string, body?: unknown) => this.request<T>('POST', path, body);
  put = <T = unknown>(path: string, body?: unknown) => this.request<T>('PUT', path, body);
  delete = <T = unknown>(path: string) => this.request<T>('DELETE', path);

  async login(email: string, password: string): Promise<void> {
    const response = await this.post('/auth/login', { email, password });
    if (response.status !== 200) {
      throw new Error(
        `Login failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`,
      );
    }
  }
}

/** True when there is an API to test against; the suite skips rather than fails otherwise. */
export async function apiIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The suite gets its own account.
 *
 * Deliberate: the seeded admin is shared with the shell's Playwright suite and
 * with whoever is poking at the API by hand, and a test that enrols, completes
 * sessions and writes state would race all of them. Fixtures belong to the
 * suite that needs them.
 */
export async function ensureTestUser(email: string, password: string): Promise<string> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  try {
    const passwordHash = await hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const user = await prisma.user.upsert({
      where: { email },
      update: { passwordHash, role: 'learner', deletedAt: null },
      create: { email, name: 'E2E Runner', passwordHash, role: 'learner' },
    });

    // Start from a known state: previous runs left state and progress behind.
    // Every table the suite writes to belongs here — adding one and forgetting
    // this is how a test starts passing or failing for reasons that have
    // nothing to do with the code it is testing.
    await prisma.courseState.deleteMany({ where: { userId: user.id } });
    await prisma.sessionProgress.deleteMany({ where: { userId: user.id } });
    await prisma.note.deleteMany({ where: { userId: user.id } });
    await prisma.deliverable.deleteMany({ where: { userId: user.id } });
    await prisma.enrollment.deleteMany({ where: { userId: user.id } });

    return user.id;
  } finally {
    await prisma.$disconnect();
  }
}
