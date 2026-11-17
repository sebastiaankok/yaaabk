# syntax=docker/dockerfile:1
# Shared OpenCode runtime for per-issue agent Jobs and interactive grill
# sessions. See PLAN.md section 3.4.
# Build on the builder's native platform: the output is pure JS; only the
# runtime stage targets the cluster's amd64 (see frontend Dockerfile).
FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS build
WORKDIR /app
# Install from manifests first so source edits do not invalidate the dependency
# layer. The cache mount keeps Bun's package cache across builds; a cold install
# dominates image build time.
COPY --parents package.json bun.lock packages/*/package.json ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY . .
RUN bun run --filter '@yaaabk/agent' build
RUN bun run --filter '@yaaabk/grill-mcp' build

FROM oven/bun:1.3-alpine AS runtime
# Pin the terminal and agent runtime. Sessions and Agent Jobs share this image,
# so there is one OpenCode version to upgrade and verify. The versions live in
# runtime-versions.env, which the backend's local session stage reads too.
ARG TARGETARCH
COPY --from=build /app/packages/agent/runtime-versions.env /tmp/runtime-versions.env
# git, the GitHub CLI and kubectl are required to clone, commit, open pull
# requests, and debug the Project's running workloads via the mounted
# `yaaabk-agent` ServiceAccount token. ttyd owns the PTY for grill sessions.
# OpenCode ships a musl build that runs on this Alpine image.
# The pinned OpenCode binary is a Bun standalone executable. Running it under
# QEMU during an emulated amd64 build can segfault, so the build does not
# execute it; the container runs it natively on the target host.
RUN . /tmp/runtime-versions.env && \
    apk add --no-cache git github-cli ca-certificates && \
    case "${TARGETARCH}" in \
      amd64) KUBECTL_ARCH=amd64; TTYD_ARCH=x86_64; OPENCODE_ARCH=x64;; \
      arm64) KUBECTL_ARCH=arm64; TTYD_ARCH=aarch64; OPENCODE_ARCH=arm64;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1;; \
    esac && \
    KUBECTL_VERSION="1.34.1" && \
    wget -qO /usr/local/bin/kubectl "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${KUBECTL_ARCH}/kubectl" && \
    chmod +x /usr/local/bin/kubectl && \
    wget -qO /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${TTYD_ARCH}" && \
    chmod +x /usr/local/bin/ttyd && \
    wget -qO /tmp/opencode.tar.gz "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${OPENCODE_ARCH}-musl.tar.gz" && \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode && \
    chmod +x /usr/local/bin/opencode && \
    rm -f /tmp/opencode.tar.gz /tmp/runtime-versions.env
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/agent/dist ./dist
# The agent skills and the image-baked grill skills. Sessions load their skill
# from the grill-skills directory rather than from the backend's filesystem.
COPY --from=build /app/packages/agent/skills ./skills
COPY --from=build /app/packages/grill-me/skills/grill-me ./grill-skills/grill-me
COPY --from=build /app/packages/grill-me/skills/to-prd ./grill-skills/to-prd
COPY --from=build /app/packages/grill-me/skills/to-issues ./grill-skills/to-issues
# The reporting MCP server OpenCode starts for a session. Sessions load their
# OpenCode config through OPENCODE_CONFIG so Agent Jobs never register a server
# whose report token they do not have.
COPY --from=build /app/packages/grill-mcp/dist ./grill-mcp
COPY --from=build /app/packages/agent/opencode-session.json ./opencode-session.json
RUN mkdir -p /work && chown bun:bun /work
ENV YAAABK_SKILL_PATH=/app/skills/implement-issue/SKILL.md
ENV YAAABK_SESSION_OPENCODE_CONFIG=/app/opencode-session.json
USER bun
CMD ["bun", "dist/index.js"]
