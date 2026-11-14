# syntax=docker/dockerfile:1
# Build on the builder's native platform: the output is pure JS, and SvelteKit's
# build crashes under QEMU amd64 emulation (exit 132). Only the runtime stage
# targets the cluster's amd64.
# Bun 1.4: @sveltejs/adapter-bun refuses to start the built server on older Bun.
FROM --platform=$BUILDPLATFORM oven/bun:1.4-alpine AS build
WORKDIR /app
COPY . .
# PUBLIC_API_BASE_URL is inlined into the client bundle at build time, so the
# deploy value must be set here; the repository .env (copied above) must not
# win. Process env takes precedence over .env files.
ARG PUBLIC_API_BASE_URL=http://localhost:3000
ENV PUBLIC_API_BASE_URL=$PUBLIC_API_BASE_URL
RUN bun install --frozen-lockfile
RUN bun run --filter '@yaaabk/frontend' build

FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/packages/frontend/build ./build
EXPOSE 3000
USER bun
CMD ["bun", "build/index.js"]
