# syntax=docker/dockerfile:1
# Image for the per-issue agent Job. See PLAN.md section 3.4.
# Build on the builder's native platform: the output is pure JS; only the
# runtime stage targets the cluster's amd64 (see frontend Dockerfile).
FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter '@yaaabk/agent' build

FROM oven/bun:1.3-alpine AS runtime
# git, the GitHub CLI and kubectl are required to clone, commit, open pull
# requests, and debug the Project's running workloads via the mounted
# `yaaabk-agent` ServiceAccount token.
RUN apk add --no-cache git github-cli ca-certificates && \
    KUBECTL_VERSION="$(wget -qO- https://dl.k8s.io/release/stable.txt)" && \
    wget -qO /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" && \
    chmod +x /usr/local/bin/kubectl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/agent/dist ./dist
# The implement-issue skill the agent loads, and the working directory the
# attempt's PVC is mounted at.
COPY --from=build /app/packages/agent/skills ./skills
RUN mkdir -p /work && chown bun:bun /work
ENV YAAABK_SKILL_PATH=/app/skills/implement-issue/SKILL.md
USER bun
CMD ["bun", "dist/index.js"]
