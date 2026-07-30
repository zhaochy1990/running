# Go async-job worker: HTTP API (`cmd/api`)

> **Revised by ADR 0016:** `cmd/api` is no longer a distinct binary — it is the
> `stride api` subcommand of the unified `stride` binary. The "separate
> process/container from the worker" decision below **still holds**: the api
> ships as its own image (`Dockerfile.api`, entrypoint `stride api`) and scales
> independently; only "separate *binary*" became "separate *container*, shared
> binary". The committed Swagger docs moved `cmd/api/docs` → `cmd/stride/docs`.

The async-job infra (ADR 0001) had no network entry point — jobs were created only by in-process enqueue, and the sole HTTP surface was a loopback `/healthz`. We add a standalone **`cmd/api`** gin binary (same Go module, its own Docker Compose container) exposing create/read for Async Jobs and Pipeline Runs, so both the Azure/Python backend (server-to-server) and the browser/mobile app (direct) can drive and poll background work. This introduces a **public HTTP ingress on the Tencent CVM**, which revises ADR 0002's "the worker has no HTTP ingress" consequence.

## Decision

- **Separate binary, not bolted onto the worker.** `cmd/api` reuses `internal/{job,storage,mq}`; it holds a MySQL connection (`Store`/`PipelineStore`) and a RabbitMQ **publisher** (via `job.StoreEnqueuer`) but runs **no consumer**. A public ingress has a different security/scaling profile than the at-least-once consumer, so it stays a distinct process/container.
- **Four endpoints, no list (yet):** `POST /jobs` → `{job_id}`, `GET /jobs/{partition_key}/{job_id}`, `POST /pipelines/{name}` → `{run_id}`, `GET /pipelines/{partition_key}/{run_id}`. Listing is deferred (would need a new `Store.List` port + index).
- **Two auth tiers.**
  - *Internal (server-to-server):* `X-Internal-Token` static shared secret (constant-time compare), delivered via `STRIDE_WORKER_API_INTERNAL_TOKEN` env. May create any cataloged type and pass any `partition_key`, including `Global`.
  - *User-facing (direct browser/app):* RS256 JWT verified against the **same in-house auth-service as the Azure stack** (matching issuer/audience/public key), via `github.com/golang-jwt/jwt/v5`. `partition_key` is **derived server-side from JWT `sub`**; any client-supplied value is ignored, so a user cannot target `Global` or another user's partition. May create only **user-initiable** cataloged types.
- **Job-type / pipeline-name authorization via a shared catalog.** A catalog of names (each flagged user-initiable vs internal-only) is imported by both `cmd/worker` and `cmd/api`. Unknown name → `400`. The API cannot consult the worker's live handler registry (different process), so the catalog is the API-side source of truth for "valid name".
- **Idempotency from day one, on both create endpoints.** An `Idempotency-Key` header is enforced by a unique index on `jobs(partition_key, idempotency_key)` and `pipeline_runs(partition_key, idempotency_key)`; a repeat key returns the existing `job_id`/`run_id` with `200` instead of creating a duplicate. (Schema ownership: ADR 0006.)
- **Config (ADR 0002 viper pattern).** Non-secret in `config.yml`: `api.addr`, `api.cors-origins`, `api.auth.issuer`, `api.auth.audience`, `api.auth.public-key-path` (the RS256 public key is public, not a secret), `api.swagger-enabled`. Secret via env: `STRIDE_WORKER_API_INTERNAL_TOKEN`.
- **gin everywhere.** Per the repo rule, `cmd/api` uses gin and `internal/health` is migrated from stdlib `net/http` to gin (no exception). New deps: `github.com/gin-gonic/gin`, `github.com/golang-jwt/jwt/v5`.
- **Auto-generated Swagger via `swaggo/swag` (v1, Swagger 2.0) + `gin-swagger`.** Handlers carry `// @...` annotations; `swag init` generates the OpenAPI spec + a `docs` Go package, served as Swagger UI at `/swagger/*any`. Both auth schemes are declared as `securityDefinitions` (an `apiKey`-in-header for `X-Internal-Token`, a bearer definition for the JWT). Exposure is **flag-gated** by `api.swagger-enabled`: on in dev/staging; in prod off or served only behind `X-Internal-Token`, so the internal surface is not advertised on the public ingress. The generated `docs` package is **generated at build (Dockerfile + CI), not committed** (`docs/` is git-ignored); a `make swagger` / `go generate` target runs `swag init`. New deps: `github.com/swaggo/swag`, `github.com/swaggo/gin-swagger`, `github.com/swaggo/files`. **(Superseded by ADR 0014: the `docs` package is now committed so `go mod tidy` resolves the tagged import on a fresh checkout.)**

## Considered options

- **Proxy user traffic through the Azure/Python backend** (Go stays internal-only, Python owns user identity and forwards `partition_key`): simpler on the Go side (one auth mechanism, no browser ingress into China), but rejected — we want the browser/app to call the Go API directly.
- **HTTP server inside `cmd/worker`** (like the health server): one fewer container, but welds a public ingress onto the consumer process. Rejected for isolation.
- **stdlib `net/http` router** for a 4-route surface: rejected in favor of the repo-wide gin standard.
- **No idempotency in v1** (rely on handler idempotency only): rejected — a browser double-submit of the onboarding pipeline would create duplicate Pipeline Runs, so `Idempotency-Key` ships from the start.
- **Swagger via a reflection framework** (huma/fuego, spec derived from Go structs, no annotations): rejected because handlers would leave the vanilla-gin style the repo standardized on. **Spec-first hand-authored `openapi.yaml`**: rejected — not auto-generated from the code. **OpenAPI 3.1 (swag v2):** deferred — swag v1 / Swagger 2.0 is the stable, best-supported path with `gin-swagger`; revisit if 3.x features are needed.
- **Committing the generated `docs` package + a `git diff` drift check**: rejected in favor of generate-at-build to keep generated artifacts out of the tree; the trade-off is weaker staleness detection (see Consequences). **(Later adopted — see ADR 0014 — because generate-at-build broke `go mod tidy` on a fresh checkout.)**

## Consequences

- **Cross-border ingress risk:** the Azure-served browser now calls a mainland-China service directly — added latency and a public attack surface in a new region. TLS, CORS allow-listing, and the two auth tiers are load-bearing.
- **The user tier couples the Tencent deployment to the Azure auth-service:** the RS256 public key + issuer/audience must track the auth-service; drift silently 401s every user request.
- **Schema change:** `jobs` and `pipeline_runs` gain an `idempotency_key` column + unique composite index (Go owns the canonical schema, ADR 0006).
- **Catalog/registry drift:** a name present in the shared catalog but not registered as a handler in `cmd/worker` passes the API's `400` check yet poisons at dispatch. The catalog must stay in sync with worker-registered handlers.
- **The worker binary now depends on gin** because `internal/health` (run inside `cmd/worker`) was migrated to gin.
- **Swagger UI is behind a `swagger` build tag, so the generated docs are only needed for that build.** The `gin-swagger` UI + the blank import of the generated `cmd/api/docs` package live in a `//go:build swagger` file; the default build has a no-op `mountSwagger`. So `go build`/`go vet`/`go test ./...` (what the Go CI runs) compile **without** the git-ignored `docs` package, while `make swagger` + `go build -tags swagger` (used by `Dockerfile.api`) regenerate and compile it. `Dockerfile.api` running `swag init` at image build is where annotation *errors* surface; staleness isn't detected (no committed baseline). Note: `go mod tidy` still needs the generated `docs` package present because it scans all build tags.
