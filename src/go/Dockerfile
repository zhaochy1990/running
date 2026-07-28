# syntax=docker/dockerfile:1

# --- build ---
FROM golang:1.25-alpine AS build
WORKDIR /src
# Cache modules first.
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Static binary, stripped, reproducible.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/worker ./cmd/worker

# --- runtime ---
FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget && adduser -D -u 10001 worker
# zap's ISO8601 time encoder formats in the local zone; pin UTC so log lines
# read UTC (ADR 0002). MySQL timestamps are UTC regardless (forced via DSN).
ENV TZ=UTC
WORKDIR /app
COPY --from=build /out/worker /usr/local/bin/worker
# Non-secret config defaults; secrets come from STRIDE_WORKER_* env at runtime.
COPY config.yml ./config.yml

# Health endpoint (keep in sync with runtime.health-addr; default :8081).
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/health >/dev/null 2>&1 || exit 1

USER worker
ENTRYPOINT ["/usr/local/bin/worker"]
