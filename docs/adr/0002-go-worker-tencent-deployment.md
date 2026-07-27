# Go async-job worker: Tencent Cloud deployment

The Go worker deploys to mainland China on Tencent Cloud, independently from the Azure-hosted Python stack. This ADR records the deployment shape and the China-specific constraints behind it.

## Decision

- **Compute: a CVM running Docker Compose.** The Go worker container and the self-hosted RabbitMQ container are co-located on one CVM; MySQL is managed **TencentDB (CDB)**. Lowest cost/ops for a single always-on worker, full control over RabbitMQ persistence/networking, and an easy later split (RabbitMQ → TDMQ managed, worker → TKE) if scale demands.
- **Config & secrets: a committed `config.yml` (non-secret defaults) + `STRIDE_WORKER_*` env overrides**, loaded by the `github.com/zhaochy1990/x` viper loader (`x/viper.MustLoadConfig`) into a typed struct validated with `validator/v10`; it panics (fail-fast) on a missing/invalid value. **Secrets (MySQL DSN, AMQP URL) are supplied only via env** (from a git-ignored `.env` read by Docker Compose), never committed. Loader is swappable for Tencent Secrets Manager later. (Revised from the original env-only design: `x/viper` is file-first, so non-secret defaults live in `config.yml`.)
- **Build & deploy: GitHub Actions → GHCR → CVM pull.** CI is path-filtered to `src/go/`, builds the image, pushes to GHCR; the CVM pulls and `docker compose up -d`.
- **Observability & liveness:** structured JSON logs to stdout via the `x/logger` zap logger (`logger.MustGetLogger`, injected as `*zap.Logger`) + a Docker `HEALTHCHECK` hitting loopback `/healthz`, which reflects RabbitMQ + MySQL connectivity so a wedged consumer auto-restarts. The image sets `TZ=UTC` because zap's ISO8601 encoder formats in the local zone. Metrics/alerting deferred (ship to Tencent CLS / Cloud Monitor later without touching the worker core).

## Considered options

- **Compute — TKE (Kubernetes):** rejected for phase 1 as heavier ops for a single worker (RabbitMQ would need a StatefulSet + PVC). **CloudBase Run / managed container:** rejected because self-hosting RabbitMQ alongside is awkward. **SCF (serverless):** rejected — a persistent RabbitMQ consumer isn't event-function-shaped.
- **Secrets — Tencent Secrets Manager + CAM instance role:** more secure and centrally rotatable, but overkill for a single CVM now; deferred.
- **Config loader — hand-rolled 12-factor env-only loader:** the initial implementation; replaced by `x/viper` to reuse the operator's shared config library (`github.com/zhaochy1990/x`). Trade-off accepted: `x/viper` is file-first and `panic`-based (less unit-testable than an injectable env loader), mitigated by testing via temp YAML files.
- **Logger — stdlib `log/slog`:** the initial implementation; replaced by `x/logger` (zap) to reuse the shared library. Packages take an injected `*zap.Logger` (default: the global `logger.L()` or a no-op) so tests stay quiet.
- **Registry — Tencent TCR** was recommended for fast in-region pulls; the operator chose **GHCR** to keep one registry. See Consequences.

## Consequences

- **Cross-border pull risk:** pulling images from GHCR into mainland China is slow/flaky. Mitigate with a registry mirror/proxy on the CVM side, or reconsider TCR if pulls become a deploy bottleneck. This is a conscious trade-off.
- Secrets sit in a file on the CVM (`.env`); keep it `chmod 600`, off git, and rotate manually until SSM is adopted.
- The worker has no HTTP ingress, so liveness comes from the Docker `HEALTHCHECK`, not an external probe.
- **Log timestamps are UTC only because the image sets `TZ=UTC`** — zap's `ISO8601TimeEncoder` uses the process local zone, not forced UTC. This is operational logging (not persisted domain data), so the HARD timezone rule doesn't apply, but the `TZ=UTC` env is load-bearing for readable logs.
- `x/viper.MustLoadConfig` requires a readable config file and panics if absent, so `config.yml` must ship in the image (it is `COPY`d in the Dockerfile) or be mounted; `CONFIG_PATH` can point elsewhere.
