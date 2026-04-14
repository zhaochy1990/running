# ---- Stage 1: Build frontend ----
FROM node:24-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install
COPY frontend/ ./

ARG VITE_AUTH_BASE_URL=https://auth-backend.delightfulwave-240938c0.southeastasia.azurecontainerapps.io
ARG VITE_AUTH_CLIENT_ID=app_62978bf2803346878a2e4805
ENV VITE_AUTH_BASE_URL=$VITE_AUTH_BASE_URL
ENV VITE_AUTH_CLIENT_ID=$VITE_AUTH_CLIENT_ID

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
    "click>=8.1" \
    "httpx>=0.27" \
    "platformdirs>=4.0" \
    "rich>=13.0"

# Copy built frontend from stage 1
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Source code stays at /app/src, PYTHONPATH makes it importable
ENV PYTHONPATH=/app/src

# Data directory (Azure Files mount point at runtime)
RUN mkdir -p /app/data

EXPOSE 8080
CMD ["uvicorn", "coros_sync.api:app", "--host", "0.0.0.0", "--port", "8080"]
