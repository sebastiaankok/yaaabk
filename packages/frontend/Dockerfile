# syntax=docker/dockerfile:1
# Build on the builder's native platform: the output is pure JS, and SvelteKit's
# build crashes under QEMU amd64 emulation (exit 132). Only the runtime stage
# targets the cluster's amd64.
# Bun 1.4: @sveltejs/adapter-bun refuses to start the built server on older Bun.
FROM --platform=$BUILDPLATFORM oven/bun:1.4-alpine AS build
WORKDIR /app
# Install from manifests first so source edits do not invalidate the dependency
# layer. The cache mount keeps Bun's package cache across builds; a cold install
# dominates image build time.
COPY --parents package.json bun.lock packages/*/package.json ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY . .
# `prepare` ran above without the project files, so regenerate SvelteKit's
# generated types now that the source is present.
RUN bun run --filter '@yaaabk/frontend' prepare
# PUBLIC_API_BASE_URL is NOT inlined here: SvelteKit resolves `$app/env/public`
# from the server process env at startup (src/env.ts holds the dev fallback),
# so the deploy value belongs in the frontend Deployment's env (deploy/frontend.yaml).
RUN bun run --filter '@yaaabk/frontend' build

FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/packages/frontend/build ./build
EXPOSE 3000
USER bun
CMD ["bun", "build/index.js"]
