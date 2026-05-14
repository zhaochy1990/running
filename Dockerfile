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

# Copy source
COPY pyproject.toml ./
COPY src/ ./src/

# Copy admin / one-shot scripts (backfill, schedule inspection, etc.).
# Invoked manually via `az containerapp exec` against the running revision —
# they are not part of the request-serving path.
COPY scripts/ ./scripts/

# Install dependencies directly (avoid pip install . which copies to site-packages
# and breaks Path(__file__) resolution for USER_DATA_DIR and FRONTEND_DIR).
#
# IMPORTANT: keep this list in sync with pyproject.toml's [project.optional-dependencies].web
# block. The coach package imports langchain / langgraph / langchain-azure-ai
# at module top level (routes/coach.py loads them via langchain_core.messages),
# so missing any of these at build time causes app boot to fail and ACA falls
# back to the prior revision — silent prod regression.
RUN pip install --no-cache-dir \
    "fastapi>=0.115" \
    "uvicorn[standard]>=0.30" \
    "pyjwt[crypto]>=2.8" \
    "click>=8.1" \
    "httpx>=0.27" \
    "platformdirs>=4.0" \
    "rich>=13.0" \
    "openai>=1.40" \
    "langchain>=1.0,<2.0" \
    "langchain-openai>=1.0,<2.0" \
    "langchain-azure-ai>=1.0,<2.0" \
    "langgraph>=1.0,<2.0" \
    "azure-identity>=1.17" \
    "azure-keyvault-secrets>=4.8" \
    "azure-storage-blob>=12.20" \
    "azure-data-tables>=12.5" \
    "garth>=0.5" \
    "garminconnect>=0.2"

# Copy built frontend from stage 1
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Copy training plans as defaults (Azure Files mount may overlay at runtime)
COPY data/ ./data/

# Strength illustration library — ships baked into the image (image data,
# not per-user data; not affected by the data/ Azure Files mount).
COPY strength_illustrations/ ./strength_illustrations/

# Source code stays at /app/src, PYTHONPATH makes it importable
ENV PYTHONPATH=/app/src

# Data directory (Azure Files mount point at runtime)
RUN mkdir -p /app/data

EXPOSE 8080
CMD ["uvicorn", "stride_server.main:app", "--host", "0.0.0.0", "--port", "8080"]
