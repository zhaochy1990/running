# Go owns the canonical MySQL schema via GORM models + AutoMigrate

Both the writer (Go worker) and the eventual reader (Go API server) are Go and
share one `internal/storage` package, so the watch-data MySQL schema is defined
in Go and is the single source of truth. We follow the persistence stack the Go
worker infra already established (ADR 0003 / ADR 0004): **GORM models with
`gorm:` struct tags + `AutoMigrate`**, `DATETIME(6)` UTC via a DSN forced to
`parseTime=true&loc=UTC&time_zone='+00:00'`, and domain-owns-time (GORM auto
timestamps disabled). The watch tables (`activities`, `sync_meta`, `laps`,
`timeseries`, `daily_health`, `dashboard`, `daily_hrv`, `race_predictions`,
`activity_watch_zones`, `provider_credentials`, and the confirmed activity-reference
projection `races`) are added as GORM models
alongside the existing `jobModel`/`pipelineRunModel`.

We keep the well-reasoned column decisions of the repo's dormant Python
`stride_storage/mysql/schema.py` — composite `(user_id, label_id)` identity,
`char(36)` UUID, `DATETIME(6)` naive-UTC, native JSON, Shanghai-day for calendar
queries — but express them as GORM models, which are canonical.

## Considered Options

- **Embedded `.sql` migrations (`go:embed`)** — the original plan. Rejected once
  the Go worker infra landed GORM + `AutoMigrate` as the persistence stack:
  two migration mechanisms in one module/`internal/storage` package is the
  duplication the repo forbids.
- **Extend Python's SQLAlchemy `stride_storage/mysql` first** — rejected: the
  end-state has no Python MySQL reader, so it would be a dead coupling.

## Consequences

- Python's `stride_storage/mysql/schema.py` is **demoted to reference**: borrow
  its column list, but it is no longer a live coupling.
- `shanghai_date` (a MySQL generated column in the Python design) has no direct
  GORM tag; declare it via a migration hook / raw DDL in `AutoMigrate`, or drop
  it in favour of computing the Shanghai day at query time — decide when the
  `activities` model lands.
- No cross-language schema-parity test. Shadow-phase validation is **data-level**
  (Go MySQL vs Python SQLite via `cmd/reconcile`), not schema-level.
- Schema + row types stay in the shared `internal/storage` package so the worker
  and the future API server import one definition.
