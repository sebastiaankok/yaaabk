# syntax=docker/dockerfile:1
# Image for the per-issue agent Job. See PLAN.md section 3.4.
FROM oven/bun:1.3-alpine AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter '@yaaabk/agent' build

FROM oven/bun:1.3-alpine AS runtime
# git and the GitHub CLI are required to clone, commit, and open pull requests.
RUN apk add --no-cache git github-cli ca-certificates
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
