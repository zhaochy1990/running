# ---- Stage 1: Build frontend ----
FROM node:24-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install
COPY frontend/ ./

ARG VITE_AUTH_BASE_URL
ARG VITE_AUTH_CLIENT_ID
ARG VITE_APPLICATIONINSIGHTS_CONNECTION_STRING
ENV VITE_AUTH_BASE_URL=$VITE_AUTH_BASE_URL
ENV VITE_AUTH_CLIENT_ID=$VITE_AUTH_CLIENT_ID
ENV VITE_APPLICATIONINSIGHTS_CONNECTION_STRING=$VITE_APPLICATIONINSIGHTS_CONNECTION_STRING

RUN npm run build

# ---- Stage 2: Python runtime ----
FROM python:3.13-slim
WORKDIR /app

# Copy source
COPY pyproject.toml ./
COPY src/ ./src/

# Install dependencies directly (avoid pip install . which copies to site-packages
# and breaks Path(__file__) resolution for USER_DATA_DIR and FRONTEND_DIR)
RUN pip install --no-cache-dir \
    "fastapi>=0.115" \
    "uvicorn[standard]>=0.30" \
    "pyjwt[crypto]>=2.8" \
    "click>=8.1" \
    "httpx>=0.27" \
    "platformdirs>=4.0" \
    "rich>=13.0" \
    "openai>=1.40" \
    "azure-identity>=1.17" \
    "azure-keyvault-secrets>=4.8"

# Copy built frontend from stage 1
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Copy training plans as defaults (Azure Files mount may overlay at runtime)
COPY data/ ./data/

# Source code stays at /app/src, PYTHONPATH makes it importable
ENV PYTHONPATH=/app/src

# Data directory (Azure Files mount point at runtime)
RUN mkdir -p /app/data

EXPOSE 8080
CMD ["uvicorn", "stride_server.main:app", "--host", "0.0.0.0", "--port", "8080"]
