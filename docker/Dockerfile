# Bud API — production image.
#
# Multi-stage so the runtime layer carries no compiler, no dev dependencies and
# no source. Node 22 LTS to match the base image the Docker course uses.

# ── deps ──────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Copy only the manifests first: this layer is cached until dependencies change,
# which is the single biggest win in day-to-day rebuilds.
COPY package.json package-lock.json ./
RUN npm ci

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

# The Prisma client is generated code; it must exist before tsc runs.
RUN npx prisma generate
RUN npm run build

# Drop dev dependencies from the tree we are about to copy into the runtime.
RUN npm prune --omit=dev

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Fail fast and loudly rather than restarting into a broken state.
ENV NODE_OPTIONS=--enable-source-maps

# tini reaps zombies and forwards SIGTERM, so graceful shutdown actually works.
RUN apk add --no-cache tini

# Run unprivileged. The node image ships a `node` user; use it rather than root.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --chown=node:node package.json prisma.config.ts ./

USER node

EXPOSE 3102

# Compose and orchestrators use /health; this is for plain `docker run`.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3102/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# Migrations are NOT run here. They are a separate step in the deploy pipeline
# (Tech-Information.md section 10, rule 3): never auto-migrate on boot in prod.
CMD ["node", "dist/main.js"]
