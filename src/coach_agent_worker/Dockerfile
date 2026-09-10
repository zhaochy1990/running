# Plan-job worker image (stride-coach-worker).
# pnpm monorepo-aware multi-stage build: install + build all workspace packages
# in the builder, then copy only compiled dist/ + runtime node_modules to the
# alpine runtime stage. Non-root user, UTC time, no public ingress.

FROM node:24-alpine AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10 --activate

# ---- Lockfile + workspace manifests first (cache layer) ----
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

COPY src/stride-common/package.json ./src/stride-common/package.json
COPY src/coach_contract/package.json ./src/coach_contract/package.json
COPY src/coach_agent/package.json ./src/coach_agent/package.json
COPY src/coach_agent_worker/package.json ./src/coach_agent_worker/package.json

RUN pnpm install --frozen-lockfile

# ---- All workspace source ----
COPY src/stride-common/ ./src/stride-common/
COPY src/coach_contract/ ./src/coach_contract/
COPY src/coach_agent/ ./src/coach_agent/
COPY src/coach_agent_worker/ ./src/coach_agent_worker/

# `...` also builds the workspace deps (@stride/common, @stride/contract,
# @stride/coach-agent) — tsc resolves their types from dist/.
RUN pnpm --filter @stride/coach-agent-worker... run build

# =============================================================================
FROM node:24-alpine AS runtime
WORKDIR /app

ENV TZ=UTC

RUN corepack enable && corepack prepare pnpm@10 --activate

RUN adduser -D -u 10001 worker

# ---- Workspace manifests for prod install ----
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

COPY src/stride-common/package.json ./src/stride-common/package.json
COPY src/coach_contract/package.json ./src/coach_contract/package.json
COPY src/coach_agent/package.json ./src/coach_agent/package.json
COPY src/coach_agent_worker/package.json ./src/coach_agent_worker/package.json

RUN pnpm install --prod --frozen-lockfile

# ---- Compiled output from build stage ----
COPY --from=build /repo/src/stride-common/dist ./src/stride-common/dist
COPY --from=build /repo/src/coach_contract/dist ./src/coach_contract/dist
COPY --from=build /repo/src/coach_agent/dist ./src/coach_agent/dist
COPY --from=build /repo/src/coach_agent_worker/dist ./src/coach_agent_worker/dist

# ---- Config files ----
COPY src/coach_agent_worker/config/ ./src/coach_agent_worker/config/
COPY config/ ./config/

ENV STRIDE_COACH_ENV=prod

USER worker

WORKDIR /app/src/coach_agent_worker

CMD ["node", "dist/src/main.js"]
