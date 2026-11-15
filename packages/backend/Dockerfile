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
# The scaffold pushes the template with git, so the binary must be present.
RUN apk add --no-cache git
COPY --from=build /app/packages/backend/dist ./dist
# The bundled template module resolves its default source relative to dist
# (which lands at /templates/svelte-bun, absent here); the image ships its own
# copy and the Deployment points YAAABK_TEMPLATE_DIR at it.
COPY --from=build /app/templates ./templates
EXPOSE 3000
USER bun
CMD ["bun", "dist/index.js"]
