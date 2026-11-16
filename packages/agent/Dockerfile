# syntax=docker/dockerfile:1
# Shared OpenCode runtime for per-issue agent Jobs and interactive grill
# sessions. See PLAN.md section 3.4.
# Build on the builder's native platform: the output is pure JS; only the
# runtime stage targets the cluster's amd64 (see frontend Dockerfile).
FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter '@yaaabk/agent' build

FROM oven/bun:1.3-alpine AS runtime
# Pin the terminal and agent runtime. Sessions and Agent Jobs share this image,
# so there is one OpenCode version to upgrade and verify.
ARG TARGETARCH
ARG OPENCODE_VERSION=2.2.5
ARG TTYD_VERSION=1.7.7
# git, the GitHub CLI and kubectl are required to clone, commit, open pull
# requests, and debug the Project's running workloads via the mounted
# `yaaabk-agent` ServiceAccount token. ttyd owns the PTY for grill sessions.
# OpenCode ships a musl build that runs on this Alpine image.
RUN apk add --no-cache git github-cli ca-certificates && \
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
    rm -f /tmp/opencode.tar.gz && \
    opencode --version
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/agent/dist ./dist
# The agent skills and the image-baked grill skills. Sessions load their skill
# from here rather than from the backend's filesystem.
COPY --from=build /app/packages/agent/skills ./skills
COPY --from=build /app/packages/grill-me/skills ./skills
RUN mkdir -p /work && chown bun:bun /work
ENV YAAABK_SKILL_PATH=/app/skills/implement-issue/SKILL.md
ENV YAAABK_GRILL_SKILL_PATH=/app/skills/grill-me/SKILL.md
USER bun
CMD ["bun", "dist/index.js"]
