# ---- Stage 1: Build frontend ----
FROM node:24-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install
COPY frontend/ ./
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
