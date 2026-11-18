# syntax=docker/dockerfile:1
# Build context: templates/svelte-bun.
#
# Optional shared base for the SvelteKit + Bun template. It carries the
# template's node_modules so a project's Docker build starts with its
# dependencies already installed; the project Dockerfile still runs
# `bun install --frozen-lockfile`, which is a no-op when its lockfile matches.
FROM oven/bun:1.3-alpine
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY package.json bun.lock ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
