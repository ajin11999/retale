# Retale console — SvelteKit (adapter-node). Houdini codegen runs during
# `vite build` against the checked-in schema.graphql, so no running API is
# needed at build time. Build with context = repo root:
#   docker build -f packages/console/Dockerfile .
FROM oven/bun:1.3 AS build

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/api/package.json packages/api/
COPY packages/catalog/package.json packages/catalog/
COPY packages/console/package.json packages/console/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/console packages/console
RUN bun run --filter @retale/console build

# Runtime: adapter-node bundles app code into build/ but leaves package
# dependencies external, so install production deps fresh (linux binaries).
FROM oven/bun:1.3

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/api/package.json packages/api/
COPY packages/catalog/package.json packages/catalog/
COPY packages/console/package.json packages/console/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile --production

COPY --from=build /app/packages/console/build packages/console/build

# GRAPHQL_URL and the proxy origin headers (PROTOCOL_HEADER / HOST_HEADER) are
# provided at container start (compose).
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app/packages/console
EXPOSE 3000
CMD ["bun", "build/index.js"]
