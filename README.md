# Bud API

The backend for **Bud**, the learning platform. It is deployed separately from the
Next.js shell, and the two talk over JSON with an httpOnly session cookie.

Planning lives in [`../Planning`](../Planning). This service implements
`Tech-Information.md` §4 (Backend), §5 (Data model) and §6 (API surface).

---

## Status: Phase 0 (version 0)

| Block | What | State |
|---|---|---|
| 1 | Skeleton: NestJS + Fastify, config validated on boot, Prisma schema v1 | ✅ |
| 2 | Auth: register (invite-gated), login, logout, `/me`, change password, sessions, guards | ✅ |
| 3 | Docker: production and dev images, compose stack, initial migration, seed | ✅ |
| 4 | CI: checks → e2e against real Postgres → image build, scan, push | ✅ |

**Phase 0 exit criteria** (Overall Plan §7): *log in on a public URL, and CI builds
the image.* The code side is done. What is left is deploying it to a host, which
needs your accounts (Railway / Fly / Render + Neon).

---

## Quick start

Requires Node 22+ and Docker.

```bash
cp .env.example .env              # then set SEED_ADMIN_PASSWORD
npm install
docker compose up -d postgres     # just the database
npx prisma migrate deploy         # apply migrations
npm run db:seed                   # create the admin user
npm run start:dev                 # http://localhost:3102
```

API docs (non-production only): <http://localhost:3102/docs>
OpenAPI JSON: <http://localhost:3102/docs/openapi.json>

To run the whole stack in containers instead:

```bash
docker compose up -d
docker compose exec api npx prisma migrate deploy
docker compose exec api npm run db:seed
```

| Service | URL |
|---|---|
| API | http://localhost:3102 |
| Postgres | `postgresql://bud:bud@localhost:5434/bud` (host port 5434, see compose.yaml) |
| MinIO console | http://localhost:9001 (`minioadmin` / `minioadmin`) |
| Mailpit | http://localhost:8025 |

### Try it

```bash
# sign in as the seeded admin; the cookie lands in cookies.txt
curl -c cookies.txt -X POST http://localhost:3102/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@bud.local","password":"<SEED_ADMIN_PASSWORD>"}'

curl -b cookies.txt http://localhost:3102/me
```

---

## Scripts

| Script | Does |
|---|---|
| `npm run start:dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled build |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `format` | ESLint / Prettier |
| `npm run prisma:migrate` | Create a new migration from schema changes (dev) |
| `npm run prisma:deploy` | Apply migrations (what CI and deploys run) |
| `npm run prisma:studio` | Browse the database |
| `npm run db:seed` | Create the admin user (refuses to run in production) |

---

## Layout

```
src/
├── main.ts                  bootstrap: Fastify, helmet, cookies, rate limit, CORS, Swagger
├── app.module.ts            wiring; SessionGuard + RolesGuard registered globally
├── config/                  env schema (zod), typed AppConfigService
├── prisma/                  PrismaService (driver adapter), global module
├── auth/                    sessions, passwords, guards, decorators, controllers
├── health/                  /health (liveness), /ready (readiness)
├── common/                  zod validation pipe, global exception filter
└── types/fastify.d.ts       request augmentation (user, budSession, cookies)
prisma/
├── schema.prisma            data model v1
├── migrations/              committed SQL migrations
└── seed.ts
docker/                      Dockerfile (prod), Dockerfile.dev
compose.yaml                 local stack: api, postgres, minio, mailpit
.github/workflows/ci.yml
```

---

## API (Phase 0)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | public | Liveness. Checks nothing external |
| `GET` | `/ready` | public | Readiness. Checks the database |
| `POST` | `/auth/register` | public | Invite token required while `SIGNUP_MODE=invite_only`. Signs you in |
| `POST` | `/auth/login` | public | Sets the session cookie. Throttled per email + IP |
| `POST` | `/auth/logout` | session | Revokes the session server-side |
| `POST` | `/auth/change-password` | session | Signs out every other session |
| `GET` | `/me` | session | The signed-in user |

Every route requires a session unless it is marked `@Public()`. A new controller
cannot leak by omission.

Errors always have the same shape:

```json
{ "statusCode": 400, "error": "Bad Request", "message": "Validation failed",
  "errors": [{ "path": "email", "message": "Must be a valid email address", "code": "invalid_format" }],
  "path": "/auth/login", "timestamp": "2026-09-18T01:00:00.000Z" }
```

---

## Security notes

- **Sessions**: 256-bit random id in an httpOnly, `SameSite=Lax` cookie. Only the
  SHA-256 of the id is stored, so a database dump cannot be replayed as logins.
  Absolute expiry (30 days) plus sliding idle expiry (14 days). Revocable.
- **Passwords**: argon2id, OWASP baseline parameters. Hashes made with weaker
  parameters are upgraded on the next successful login.
- **No account enumeration**: login spends the same time and returns the same
  error whether the email exists or not.
- **Invites**: only the SHA-256 of the token is stored. Invites are bound to an
  email and claimed atomically, so two racing signups cannot both use one.
- **Config**: boot fails if `COURSES_ORIGIN` equals `APP_ORIGIN` (that would
  break the course sandbox), if cookies are insecure in production, or if a seed
  password is set in production.
- **Logs**: cookies, auth headers, passwords and invite tokens are redacted.

---

## Where this differs from Tech-Information.md, and why

The planning doc predates the current releases of several dependencies. These
are deliberate choices, not drift:

| Doc says | Here | Why |
|---|---|---|
| NestJS | **NestJS 12, ESM** | Nest 12 ships as ES modules only. The project is `"type": "module"`, so relative imports end in `.js` |
| `nestjs-zod` | **In-repo `ZodValidationPipe`** (`src/common/validation`) | `nestjs-zod` still peers on Nest 10/11. Zod 4 emits JSON Schema natively, so the pipe plus OpenAPI generation is ~50 lines |
| Prisma | **Prisma 7 + `@prisma/adapter-pg`** | Prisma 7 removed the Rust engine and the schema `url`. The CLI reads the URL from `prisma.config.ts`; the app passes a driver adapter |
| — | `prisma@^7`, not `latest` | npm's `latest` tag for `prisma` currently points at an 8.0 release candidate |
| Postgres 16 | **Postgres 17** in compose and CI | 16 was not pullable on the build machine; nothing in the schema is version-specific. Set `POSTGRES_TAG=16-alpine` to match the doc |
| `email citext` | Plain `text`, lower-cased at the edge | Avoids needing the `citext` extension on managed Postgres |
| `auth_sessions.id` = random id | **SHA-256 of the random id** | The raw id lives only in the cookie |
| — | `fastify` pinned via `overrides` | Nest's platform package pinned a different patch; two copies break plugin types |

---

## Known gaps (intentional for Phase 0)

- **GitHub OAuth** — env vars and the `oauth_accounts` table exist; the routes do
  not yet. Everything is in place to add them without schema changes.
- **Admin invite endpoint** — `AuthService.createInvite` exists but has no route,
  and now deliberately will not get one for a while: the owner decided
  (Overall Plan §8.1, 20 Sep 2026) that there is no learner two yet, so **no
  multi-user UI gets built** — no invite screens, no admin user list, no
  per-learner stats. `SIGNUP_MODE=invite_only` stays as the closed front door.
  Create an invite from a script or Prisma Studio if you ever need one. The
  schema is ready for the day this reverses.
- **Login throttle is in-memory**, so it is per-instance. Exact at the Small tier
  (one instance); move it to Redis alongside sessions when a second replica
  appears. See `src/auth/login-throttle.service.ts`.
- **Object storage and mail** are configured but not used until Phase 1 (course
  upload) and Phase 2 (invites by email).
- **Sentry** — `SENTRY_DSN` is read but not wired.
