# Coach Agent API image (stride-coach-api).
# pnpm monorepo-aware multi-stage build: install + build all workspace packages
# in the builder, then copy only compiled dist/ + runtime node_modules to the
# alpine runtime stage. Non-root user, UTC time, HEALTHCHECK on /health.

FROM node:24-alpine AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10 --activate

# ---- Lockfile + workspace manifests first (cache layer) ----
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

COPY src/stride-common/package.json ./src/stride-common/package.json
COPY src/coach_contract/package.json ./src/coach_contract/package.json
COPY src/coach_agent/package.json ./src/coach_agent/package.json
COPY src/coach_agent_api/package.json ./src/coach_agent_api/package.json

RUN pnpm install --frozen-lockfile

# ---- All workspace source ----
COPY src/stride-common/ ./src/stride-common/
COPY src/coach_contract/ ./src/coach_contract/
COPY src/coach_agent/ ./src/coach_agent/
COPY src/coach_agent_api/ ./src/coach_agent_api/

RUN pnpm --filter coach_agent_api run build:all

# =============================================================================
FROM node:24-alpine AS runtime
WORKDIR /app

ENV TZ=UTC

RUN corepack enable && corepack prepare pnpm@10 --activate

RUN adduser -D -u 10001 coach

# ---- Workspace manifests for prod install ----
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

COPY src/stride-common/package.json ./src/stride-common/package.json
COPY src/coach_contract/package.json ./src/coach_contract/package.json
COPY src/coach_agent/package.json ./src/coach_agent/package.json
COPY src/coach_agent_api/package.json ./src/coach_agent_api/package.json

RUN pnpm install --prod --frozen-lockfile

# ---- Compiled output from build stage ----
COPY --from=build /repo/src/stride-common/dist ./src/stride-common/dist
COPY --from=build /repo/src/coach_contract/dist ./src/coach_contract/dist
COPY --from=build /repo/src/coach_agent/dist ./src/coach_agent/dist
COPY --from=build /repo/src/coach_agent_api/dist ./src/coach_agent_api/dist

# ---- Config files ----
COPY src/coach_agent_api/config/ ./src/coach_agent_api/config/
COPY config/ ./config/

ENV STRIDE_COACH_ENV=prod

EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8888/health >/dev/null 2>&1 || exit 1

USER coach

WORKDIR /app/src/coach_agent_api

CMD ["node", "dist/src/server.js"]
