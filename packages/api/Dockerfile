# Retale API — Bun runs TypeScript directly, so there is no build step.
# Build with context = repo root (the workspace install needs the root lockfile):
#   docker build -f packages/api/Dockerfile .
FROM oven/bun:1.3

WORKDIR /app

# Workspace install: every npm workspace member's package.json must be present
# for --frozen-lockfile to resolve (the Flutter packages have none and don't
# participate). Installing inside the image gets linux-x64 builds of the native
# deps (sharp, @node-rs/argon2).
COPY package.json bun.lock bunfig.toml ./
COPY packages/api/package.json packages/api/
COPY packages/catalog/package.json packages/catalog/
COPY packages/console/package.json packages/console/
COPY packages/shared/package.json packages/shared/
RUN bun install

COPY packages/shared packages/shared
COPY packages/api packages/api

ENV NODE_ENV=production
WORKDIR /app/packages/api
EXPOSE 3000

# Apply migrations (programmatic drizzle migrator — the drizzle-kit CLI hangs,
# see CLAUDE.md), then start. `exec` so bun receives signals as PID 1.
CMD ["sh", "-c", "bun run scripts/migrate.ts && exec bun run src/index.ts"]
