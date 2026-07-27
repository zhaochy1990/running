# Go code: one module at `src/go`, `cmd/` + `internal/`

The Go side of this repo will ship **several binaries** — `worker` (async-job worker), `stride-sync` (watch-data sync, rewrite of the Python `coros-sync`/`garmin-sync`), and a future `server` — that share substantial code (storage, config, domain types, sync logic). We use a **single Go module** rooted at `src/go`, with binaries under `cmd/` and all shared code under `internal/`. Supersedes the "`src/worker/` with its own `go.mod`" bullet in ADR 0003.

## Decision

- **One module**, path `github.com/zhaochy1990/stride`, `go.mod` at `src/go/`.
- **`src/go/cmd/<name>/main.go`** per binary (`worker`, `stride-sync`, `server`, …), each kept thin: parse config, wire dependencies, run.
- **`src/go/internal/<domain>/`** for all shared code, organized by capability (e.g. `internal/job`, `internal/storage`, `internal/config`), **not** by consuming binary. `internal/` is compiler-enforced private to `src/go`.
- Use a top-level `pkg/` only if code must be imported from **outside** this repo (not anticipated).

## Considered options

- **Per-binary `go.mod` (multi-module repo):** rejected. Sharing code across modules needs `replace` directives (fragile) or published versioned tags (ceremony), invites dependency-version drift, and breaks repo-wide `go test ./...` / gopls. Multi-module is only justified when a subtree needs its own external release cadence — which none of these binaries do. Split out later if that ever changes.
- **Module at repo root or `src/`:** rejected to keep all Go under one clearly-scoped directory, cleanly separated from the Python/TS trees.
- **Module path aligned to the on-disk path (`…/running/src/go`):** viable but rejected for longer imports; the subtree is never `go get`-ed at its path, so a short vanity path is free.

## Consequences

- The worker built earlier at `src/worker/` moved to `src/go/cmd/worker` + `src/go/internal/job`.
- **`.dockerignore` must exclude `src/go/`** so `Dockerfile:34` (`COPY src/ ./src/`) doesn't sweep Go code into the Python image (required follow-up).
- The in-flight `stride-sync` rewrite must land in `src/go/cmd/stride-sync` sharing `internal/` — it must **not** create a competing `go.mod`.
- Python tooling is unaffected: hatch's wheel allowlist, pytest (`tests/`-only), and importlinter all ignore `src/go`.
