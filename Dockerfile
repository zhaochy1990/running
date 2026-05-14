# ---- Stage 1: Build frontend ----
FROM node:24-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install
COPY frontend/ ./

ARG VITE_AUTH_BASE_URL
ARG VITE_AUTH_CLIENT_ID
ARG VITE_APPLICATIONINSIGHTS_CONNECTION_STRING
# AMap (高德地图) JS API 2.0 — both values bake into the bundle (key + the
# pairing securityJsCode). Domain whitelist on the AMap console is what
# protects the key, NOT obscurity. Sourced from stride-kv-common AKV in CI.
ARG VITE_AMAP_KEY
ARG VITE_AMAP_SECURITY_CODE
ENV VITE_AUTH_BASE_URL=$VITE_AUTH_BASE_URL
ENV VITE_AUTH_CLIENT_ID=$VITE_AUTH_CLIENT_ID
ENV VITE_APPLICATIONINSIGHTS_CONNECTION_STRING=$VITE_APPLICATIONINSIGHTS_CONNECTION_STRING
ENV VITE_AMAP_KEY=$VITE_AMAP_KEY
ENV VITE_AMAP_SECURITY_CODE=$VITE_AMAP_SECURITY_CODE

RUN npm run build

# ---- Stage 2: Python runtime ----
FROM python:3.13-slim
WORKDIR /app

# pyproject.toml + src must be present BEFORE the editable install. The
# editable install (PEP 660) writes a .pth file pointing at /app/src, so
# Path(__file__) on every package resolves to /app/src/<pkg>/<file>.py at
# runtime — keeping PROJECT_ROOT / USER_DATA_DIR / FRONTEND_DIR computations
# correct (they walk up from __file__ to /app/).
COPY pyproject.toml ./
COPY src/ ./src/

# Copy admin / one-shot scripts (backfill, schedule inspection, etc.).
# Invoked manually via `az containerapp exec` against the running revision —
# they are not part of the request-serving path.
COPY scripts/ ./scripts/

# Single source of truth for deps: pyproject.toml [project.optional-dependencies].
# Editable install (-e) keeps /app/src as the import location — no file copy
# into site-packages, so __file__-based path resolution stays correct.
RUN pip install --no-cache-dir -e ".[web,analysis]"

# Copy built frontend from stage 1
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Copy training plans as defaults (Azure Files mount may overlay at runtime)
COPY data/ ./data/

# Strength illustration library — ships baked into the image (image data,
# not per-user data; not affected by the data/ Azure Files mount).
COPY strength_illustrations/ ./strength_illustrations/

# Editable install adds /app/src via .pth so PYTHONPATH is redundant. Keep
# it as a defensive backstop in case any subprocess / spawned helper reads
# sys.path before the .pth file is processed.
ENV PYTHONPATH=/app/src

# Data directory (Azure Files mount point at runtime)
RUN mkdir -p /app/data

EXPOSE 8080
CMD ["uvicorn", "stride_server.main:app", "--host", "0.0.0.0", "--port", "8080"]
