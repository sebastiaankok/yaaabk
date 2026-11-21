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

# Warm Bun's package cache with the Svelte/Bun template's dependencies. Every
# attempt clones a fresh repository and runs `bun install`, so the packages it
# needs are on disk instead of fetched from the registry on each Job. The
# stage deliberately targets the runtime platform: platform-specific packages
# such as Vite's native binaries must match the cluster, not the builder.
FROM oven/bun:1.3-alpine AS project-cache
WORKDIR /cache
COPY templates/svelte-bun/package.json templates/svelte-bun/bun.lock ./
COPY templates/svelte-bun/server/package.json server/package.json
COPY templates/svelte-bun/web/package.json web/package.json
RUN BUN_INSTALL_CACHE_DIR=/bun-cache bun install --frozen-lockfile

FROM oven/bun:1.3-alpine AS runtime-base
# Pin the terminal and agent runtime. Sessions and Agent Jobs share this image,
# so there is one OpenCode version to upgrade and verify. The versions live in
# runtime-versions.env, which the backend's local session stage reads too.
ARG TARGETARCH
COPY --from=build /app/packages/agent/runtime-versions.env /tmp/runtime-versions.env
# git, the GitHub CLI, kubectl and curl are required to clone, commit, open pull
# requests, debug the Project's running workloads via the mounted
# `yaaabk-agent` ServiceAccount token, and probe an endpoint. ttyd owns the PTY
# for grill sessions; tmux supervises OpenCode so a terminal client disconnect
# does not kill it.
# Node is required by the template's web unit tests: Vitest and jsdom drive
# worker threads and DOM APIs Bun does not implement, so running them under Bun
# fails with `child.channel?.unref is not a function`. The template's `check`
# script is what every Agent runs, so the runtime must provide Node.
# OpenCode ships a musl build that runs on this Alpine image.
# The pinned OpenCode binary is a Bun standalone executable. Running it under
# QEMU during an emulated amd64 build can segfault, so the build does not
# execute it; the container runs it natively on the target host.
RUN . /tmp/runtime-versions.env && \
    apk add --no-cache git github-cli ca-certificates curl nodejs tmux && \
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
# The template's dependency cache. `bun install --prefer-offline` in the
# attempt's clone resolves from here and only reaches the network for a
# dependency the scaffold does not already use.
COPY --from=project-cache /bun-cache /home/bun/.bun/install/cache
RUN mkdir -p /work && chown -R bun:bun /work /home/bun/.bun
ENV BUN_INSTALL_CACHE_DIR=/home/bun/.bun/install/cache
ENV YAAABK_SESSION_OPENCODE_CONFIG=/app/opencode-session.json
ENV KUBECONFIG=/app/kubeconfig.yaml

# Prove the bundled template passes its own checks in this image before any
# Agent Job runs them. The template's `check` script is the contract every
# attempt is judged by, so a template that needs a runtime this image lacks
# must fail the build here rather than half-way through a model run. The stage
# is not shipped; `runtime` depends on its marker file.
FROM runtime-base AS template-check
COPY --parents package.json bun.lock packages/*/package.json ./
RUN --mount=type=cache,target=/home/bun/.bun/install/cache bun install --frozen-lockfile
COPY packages ./packages
COPY templates ./templates
USER bun
RUN bun packages/template/scripts/check-template.ts && touch /tmp/template-check-ok

FROM runtime-base AS runtime
USER bun
COPY --from=build /app/packages/agent/dist ./dist
# The Agent skills and the image-baked Grill-Me skills. Both configs register
# the Agent skills; the session config also registers the Grill-Me directory.
COPY --from=build /app/packages/agent/skills ./skills
COPY --from=build /app/packages/grill-me/skills/grill-me ./grill-skills/grill-me
COPY --from=build /app/packages/grill-me/skills/to-prd ./grill-skills/to-prd
COPY --from=build /app/packages/grill-me/skills/to-issues ./grill-skills/to-issues
COPY --from=build /app/packages/grill-me/skills/simple-english ./grill-skills/simple-english
# Two OpenCode configs: Agent Jobs register only the image-baked Agent skills,
# while sessions also register the reporting MCP server. Splitting them keeps a
# Job from starting a server whose report token it does not have.
COPY --from=build /app/packages/grill-mcp/dist ./grill-mcp
COPY --from=build /app/packages/agent/opencode-agent.json ./opencode-agent.json
COPY --from=build /app/packages/agent/opencode-session.json ./opencode-session.json
# kubectl does not discover the mounted ServiceAccount by itself; this points it
# at the in-cluster API and lets the projected token authenticate every call.
COPY --from=build /app/packages/agent/kubeconfig.yaml ./kubeconfig.yaml
# Forces the template check above to run for every image build.
COPY --from=template-check /tmp/template-check-ok /tmp/template-check-ok
CMD ["bun", "dist/index.js"]
