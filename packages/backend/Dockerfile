# syntax=docker/dockerfile:1
# Build on the builder's native platform: the output is pure JS; only the
# runtime stage targets the cluster's amd64 (see frontend Dockerfile).
FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter '@yaaabk/backend' build
RUN bun run --filter '@yaaabk/grill-mcp' build

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

# Development stage used by docker compose: the backend runs interactive grill
# sessions as local ttyd + OpenCode child processes, so both binaries and the
# image-baked skills are present here. Production uses the Kubernetes session
# runtime instead and keeps them out of the backend image.
FROM runtime AS dev
ARG TARGETARCH
ARG OPENCODE_VERSION=2.2.5
ARG TTYD_VERSION=1.7.7
USER root
RUN apk add --no-cache ca-certificates && \
    case "${TARGETARCH}" in \
      amd64) TTYD_ARCH=x86_64; OPENCODE_ARCH=x64;; \
      arm64) TTYD_ARCH=aarch64; OPENCODE_ARCH=arm64;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1;; \
    esac && \
    wget -qO /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${TTYD_ARCH}" && \
    chmod +x /usr/local/bin/ttyd && \
    wget -qO /tmp/opencode.tar.gz "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${OPENCODE_ARCH}-musl.tar.gz" && \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode && \
    chmod +x /usr/local/bin/opencode && \
    rm -f /tmp/opencode.tar.gz && \
    opencode --version
# Image-baked grill skills, matching the agent runtime.
COPY --from=build /app/packages/grill-me/skills ./skills
# The reporting MCP server and the session OpenCode config. compose sessions
# run on the loopback, so the MCP server reaches the backend at localhost.
COPY --from=build /app/packages/grill-mcp/dist ./grill-mcp
COPY --from=build /app/packages/agent/opencode-session.json ./opencode-session.json
ENV YAAABK_TTYD_BIN=/usr/local/bin/ttyd
ENV YAAABK_OPENCODE_BIN=/usr/local/bin/opencode
ENV YAAABK_GRILL_SKILL_PATH=/app/skills/grill-me/SKILL.md
ENV YAAABK_SESSION_API_URL=http://127.0.0.1:3000
ENV YAAABK_SESSION_OPENCODE_CONFIG=/app/opencode-session.json
USER bun
