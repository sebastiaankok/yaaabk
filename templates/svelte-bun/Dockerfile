# syntax=docker/dockerfile:1

# A YAAABK-published base image can carry the template's toolchain and
# node_modules; the default is the official Bun image, so the template works
# without that registry.
ARG BASE_IMAGE={{baseImage}}

FROM ${BASE_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
# The cache mount keeps Bun's package cache across builds; with the published
# base image the dependencies are often already present, so this is a no-op.
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run build

FROM ${BASE_IMAGE} AS runtime
ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.source="{{repoWebUrl}}" \
      org.opencontainers.image.revision="${GIT_REVISION}" \
      org.opencontainers.image.title="{{projectName}}"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/web/build ./web/build
EXPOSE {{port}}
CMD ["bun", "server/src/index.ts"]
