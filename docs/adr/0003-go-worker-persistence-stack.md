# Go async-job worker: persistence stack (GORM + AutoMigrate + DATETIME(6) UTC)

The Go worker persists job and pipeline-run state in MySQL (TencentDB). This ADR records the Go-side persistence choices, including two deliberate deviations from what a reviewer might otherwise assume.

## Decision

- **Access layer: GORM.** Struct models with GORM tags for the (small, fixed) `jobs` and `pipeline_runs` tables and their status transitions.
- **Schema management: GORM `AutoMigrate`.** Schema is derived from struct tags at startup; no separate migration tool.
- **Timestamps: `DATETIME(6)` columns holding UTC**, DSN `parseTime=true&loc=UTC`, and all Go times constructed in `time.UTC`. Microsecond precision, human-readable in raw TencentDB queries, no 2038 range limit, and no implicit driver-side conversion. This upholds the repo-wide "store UTC, convert only at the edge" discipline.
- **Code location: `src/worker/` with its own `go.mod`.** A nested Go module keeps the service next to the design docs and reference Python implementation while isolating the Go toolchain from the Python gates (hatch wheel allowlist, pytest `tests/`-only collection, and importlinter all ignore it).

## Considered options

- **Access layer — `sqlc`** (SQL-first, type-safe codegen) was recommended for auditable claim/transition SQL; **plain `database/sql`** is the zero-codegen option. Operator chose **GORM** for development speed on a small schema.
- **Schema — versioned SQL migrations (goose/golang-migrate)** or **gormigrate** were the safer options. Operator chose **`AutoMigrate` only**, acceptable here because the schema is greenfield, tiny, and has no back-compat constraint.
- **Timestamps — `BIGINT` epoch-millis** is the most zone-unambiguous, but not human-readable and needs custom GORM time types; rejected.
- **Location — separate Git repo** gives cleaner independence but splits code from the design docs and reference implementation; rejected.

## Consequences

- **`AutoMigrate` never drops or renames columns** and silently skips many destructive changes. Any non-additive schema change (drop/rename/type-narrow) must be done with **manual SQL** against TencentDB — do not expect `AutoMigrate` to perform it. Revisit versioned migrations if the schema starts evolving non-trivially.
- **Timezone footgun:** the DSN **must** pin `loc=UTC` and code must use `time.UTC`; a stray `time.Local` or a session `time_zone` mismatch would silently corrupt instants. Treat `loc=UTC` as non-negotiable.
- `Dockerfile:34` (`COPY src/ ./src/`) would copy the Go module into the **Python** image and bloat it — add `src/worker/` to `.dockerignore` (required follow-up).
