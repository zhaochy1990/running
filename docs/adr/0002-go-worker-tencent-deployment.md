# Go async-job worker: Tencent Cloud deployment

The Go worker deploys to mainland China on Tencent Cloud, independently from the Azure-hosted Python stack. This ADR records the deployment shape and the China-specific constraints behind it.

## Decision

- **Compute: a CVM running Docker Compose.** The Go worker container and the self-hosted RabbitMQ container are co-located on one CVM; MySQL is managed **TencentDB (CDB)**. Lowest cost/ops for a single always-on worker, full control over RabbitMQ persistence/networking, and an easy later split (RabbitMQ → TDMQ managed, worker → TKE) if scale demands.
- **Config & secrets: 12-factor env vars from a git-ignored `.env`** read by Docker Compose. MySQL DSN + AMQP URL + tunables (retry limit, backoff, prefetch, queue names) load into a typed config struct at startup, fail-fast on any missing required key. `.env.example` documents the keys. Loader is swappable for Tencent Secrets Manager later.
- **Build & deploy: GitHub Actions → GHCR → CVM pull.** CI is path-filtered to `src/worker/`, builds the image, pushes to GHCR; the CVM pulls and `docker compose up -d`.
- **Observability & liveness:** `slog` structured logs to stdout (captured by Docker) + a Docker `HEALTHCHECK` backed by a small liveness signal (loopback `/healthz` or a heartbeat file) reflecting RabbitMQ + MySQL connectivity, so a wedged-but-not-crashed consumer auto-restarts. Metrics/alerting deferred (can ship to Tencent CLS / Cloud Monitor later without touching the worker core).

## Considered options

- **Compute — TKE (Kubernetes):** rejected for phase 1 as heavier ops for a single worker (RabbitMQ would need a StatefulSet + PVC). **CloudBase Run / managed container:** rejected because self-hosting RabbitMQ alongside is awkward. **SCF (serverless):** rejected — a persistent RabbitMQ consumer isn't event-function-shaped.
- **Secrets — Tencent Secrets Manager + CAM instance role:** more secure and centrally rotatable, but overkill for a single CVM now; deferred.
- **Registry — Tencent TCR** was recommended for fast in-region pulls; the operator chose **GHCR** to keep one registry. See Consequences.

## Consequences

- **Cross-border pull risk:** pulling images from GHCR into mainland China is slow/flaky. Mitigate with a registry mirror/proxy on the CVM side, or reconsider TCR if pulls become a deploy bottleneck. This is a conscious trade-off.
- Secrets sit in a file on the CVM (`.env`); keep it `chmod 600`, off git, and rotate manually until SSM is adopted.
- The worker has no HTTP ingress, so liveness comes from the Docker `HEALTHCHECK`, not an external probe.
