# syntax=docker/dockerfile:1
FROM oven/bun:1.3-alpine AS build
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
