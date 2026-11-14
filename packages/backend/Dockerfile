# syntax=docker/dockerfile:1
# Build on the builder's native platform: the output is pure JS; only the
# runtime stage targets the cluster's amd64 (see frontend Dockerfile).
FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter '@yaaabk/backend' build

FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/packages/backend/dist ./dist
EXPOSE 3000
USER bun
CMD ["bun", "dist/index.js"]
