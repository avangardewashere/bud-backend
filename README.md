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
| `npm run admin:create -- <email>` | Create the **first** admin on any database, production included. Generates the password and prints it once; refuses once an admin exists. Needs `npm run build` |
| `npm run invite -- <email> [--admin]` | Invite someone. Prints the link once. Needs `npm run build` |
| `npm run course -- init <dir>` | Start a course: manifest, outline, and a first session with the bridge wired |
| `npm run course -- validate <path>` | Check a course package against the spec. Needs `npm run build`. See **Authoring a course** |
| `npm run course -- pack <dir>` | Check a directory, then write the `.zip` to upload |
| `npm run course:ingest -- <dir> [--publish]` | Upload a course from disk in development, through the same path an admin upload takes |

---

## Authoring a course

A course is a folder with a `bud.manifest.json` and the files it names. `bud-course` is the
toolkit for writing one, and it needs no database, no environment and no running Bud — whether a
package is valid is a property of the files.

```bash
npm run build
npm run course -- init ./my-course          # id from the folder name
npm run course -- validate ./my-course
npm run course -- pack ./my-course          # writes <id>-<version>.zip
```

`init` writes a manifest, an outline and a first session, then validates what it wrote with the same
code the upload route uses — a scaffold that needs fixing before it passes teaches the wrong thing.
It refuses to write into a directory that already has anything in it.

The session it writes is the actual point. Authoring friction lives almost entirely in the storage
bridge, so the template uses all of it correctly: `storage.get` resolving to `{ value }` rather than
the value (the detail everyone gets wrong first), `storage.delete` so "clear saved work" is not a
button that silently does nothing, `bud.height` so the frame grows to the content and the shell owns
scrolling, and `bud.ready`. It also falls back to `localStorage` when `window.storage` is absent, so
the file can be opened straight from disk while it is being written. `Overall Plan.md` §3 has the
frozen contract.

It takes a directory or an already-built `.zip`, and exits **0** when the package would be
accepted, **1** when it would be refused. Warnings never fail it: a missing cover image is worth
telling someone about and is no reason to refuse their work. `--json` prints the report verbatim —
the same shape `POST /admin/courses` returns — for a pre-commit hook or a CI step.

**It cannot disagree with the server.** It runs the same `CourseSpecService` the upload route runs,
over an archive built by the same packer, so "it validates locally" and "it will be accepted" are
the same sentence. A separate client-side checker would be a second implementation of these rules,
and an author would discover the difference at upload time; `Planning/Roadmap-Status.md` records
that decision.

Packing leaves out what is never part of a course — `.git`, `node_modules`, `.DS_Store`,
`Thumbs.db` and friends — and prints every one it left out, because silently dropping a file the
manifest points at would be worse than the error it avoids. The same packer builds the archive for
`course:ingest`, and it is deterministic: the same files twice produce the same bytes.

`pack` is `validate` plus a file. It writes nothing when the package would be refused — handing
over a package that will be rejected only moves the rejection to the one place the author is not
present to read it. The archive is named `<id>-<version>.zip` from the manifest, because that is
what identifies a package rather than whatever the folder is called, and it will not replace an
existing file without `--force`: a published version is supposed to be immutable, so overwriting one
is a decision. It prints a SHA-256, which means something precisely because packing is
deterministic — worth keeping beside "I uploaded this".

**Where this runs, honestly.** `bud-course` is a compiled entry point in this repo, so today an
author needs a clone and a `npm run build`. That is fine while the only author is whoever runs Bud;
it is not fine for a stranger, and publishing it as its own package is the obvious next step rather
than a solved problem. Nothing in the CLI assumes otherwise — it imports the spec and the validator
and touches nothing else — so moving it is packaging work, not a rewrite.

The machine-readable spec is `GET /course-spec/schema`: the manifest's JSON Schema, the archive
limits, the allowed extensions and the validation codes.
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
- **Who is calling**: rate limits and the sign-in brake key on the caller's
  address, so the API believes `X-Forwarded-For` only as far as a proxy it was
  told about. `TRUST_PROXY` names them — the default trusts a proxy on loopback
  or a private network and nothing else, and a hop count is refused, because
  Fastify reads a number as *trust nothing*. Every request log line carries
  `ip`, `remoteAddress` and `forwardedFor`, which is how you check the setting
  is right for a host rather than guessing: if `ip` is the proxy's own address
  while `forwardedFor` is populated, the peer is not in the trust list.

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

## Deploying

Everything below is written and verified except the parts that need your
accounts. The production image has been built and booted in `NODE_ENV=production`
against a real Postgres and a real MinIO; what has *not* happened is a push to a
remote, so **CI has never actually executed**.

### What only you can do

1. **Create the repositories and push.** Neither repo has a git remote, so
   `ci.yml` has never run. This is the single largest untested thing in the
   project — the pipeline meant to protect it is itself unproven.
2. **A VPS** (Hetzner CX22 class is plenty) with Docker installed, and DNS for
   `api.`, `courses.` and `app.` pointing at it.
3. **Object storage** — a Cloudflare R2 bucket and an access key.
4. **Repository secrets** for `deploy.yml`: `DEPLOY_HOST`, `DEPLOY_USER`,
   `DEPLOY_SSH_KEY`, `DEPLOY_PATH`, and a `BUD_DOMAIN` variable.

### What is already done

```bash
# On the server, once:
mkdir -p /srv/bud && cd /srv/bud
# copy compose.prod.yaml, infra/ and .env.prod.example from this repo
cp .env.prod.example .env    # then fill it in

docker compose -f compose.prod.yaml pull
docker compose -f compose.prod.yaml run --rm migrate
docker compose -f compose.prod.yaml up -d
```

After that, `deploy.yml` does it on every green build of `main`, and a rollback
is a manual dispatch with an older `sha-` tag.

| File | What it is |
|---|---|
| `compose.prod.yaml` | api + postgres + caddy. Postgres has **no published ports** — it is reachable only on the compose network |
| `infra/caddy/Caddyfile` | TLS and the three hostnames |
| `infra/backup.sh` | Nightly `pg_dump` to object storage, with pruning. Put it in cron |
| `.github/workflows/deploy.yml` | Pull, migrate, restart, wait for readiness, smoke-test through TLS |

### Things that are deliberate

- **Migrations are a separate one-shot container**, run before the new image
  serves. A container that migrates as it boots runs the migration once per
  replica, and a failed migration leaves a half-serving app instead of an old
  one that still works.
- **`/health` never checks the database.** If a dead database failed liveness,
  the orchestrator would restart the container — which fixes nothing and turns
  an outage into a crash loop.
- **`/ready` fails only on the database.** Object storage is reported but not
  fatal: without it course *content* cannot be served, while sign-in, the
  catalog, progress and the bridge all still work. It returns
  `{"status":"degraded"}` so monitoring sees it without the instance leaving
  rotation. Verified by pointing `S3_ENDPOINT` at nothing.
- **The API refuses to start misconfigured.** Verified in the production image:
  `COOKIE_SECURE=false` with `NODE_ENV=production` exits with
  `COOKIE_SECURE must be true in production` rather than serving insecure cookies.
- **`courses.` is a separate hostname, not a path or a port.** Cookies ignore
  ports, so serving course content anywhere under `app.` would hand
  author-controlled JavaScript the session cookie. Caddy deliberately does not
  touch the CSP those responses carry.

---

## Security review findings

Reviewed before the first deploy. Two were fixed; the third is a documented
limitation of one configuration.

| Finding | Status |
|---|---|
| **OAuth authorization codes were written to the logs.** `pino-http` logs `req.url` verbatim, so `/auth/github/callback?code=…&state=…` put a credential exchangeable for an access token into every log line — and logs reach more people and systems than the database does | **Fixed.** A request serializer redacts the values of sensitive query parameters while keeping their names, so `?cursor=` and `?limit=` still make list endpoints debuggable |
| **Unpublished course content stayed readable.** The catalog 404s a draft, but the content origin served any version ever uploaded to anyone who guessed a slug and a version number. Unpublishing hid a course while its files stayed public — a withdrawal that withdrew nothing | **Fixed.** The origin now serves only the version the catalog is serving, cached for 30s so an asset request is not a database round trip. A rollback is still a pointer change, because storage keeps every version |
| **`POST /auth/register` distinguishes a taken email** with a 409 | **Documented, not fixed.** Unreachable under `SIGNUP_MODE=invite_only` (the default and the deployed setting): an invite is bound to an email, so anyone who can reach that path already knows the address. Under `SIGNUP_MODE=open` it is a real enumeration vector, and the fix is to answer identically and send mail — which needs the mail flow that does not exist yet. **Do not set `SIGNUP_MODE=open` until it does.** |

Two things the review confirmed rather than changed: no endpoint takes a
user-supplied URL and fetches it, so there is no SSRF surface; and every `/me`
route scopes to the session's own user id, so there is no object reference to
tamper with.

---

## Known gaps (intentional for Phase 0)

- ~~GitHub OAuth~~ — **done.** `GET /auth/github` and its callback. Unconfigured,
  the route 404s rather than existing and failing, and `GET /auth/providers`
  tells the shell whether to render the button. A GitHub identity links to an
  existing account by *verified* email; it cannot register a new one unless
  `SIGNUP_MODE=open`, because an invite is bound to an email address and letting
  GitHub vouch for one would make the invite the weaker check.
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
- ~~Sentry~~ — **done.** Inert without `SENTRY_DSN`. Reports 5xx only: an error
  tracker full of 401s is one nobody reads. Cookies, auth headers and request
  bodies are stripped, and only a user *id* is attached — never an email.
