# syntax=docker/dockerfile:1

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN bun install

FROM deps AS build
COPY . .
RUN bun run build

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/web/build ./web/build
EXPOSE {{port}}
CMD ["bun", "server/src/index.ts"]
