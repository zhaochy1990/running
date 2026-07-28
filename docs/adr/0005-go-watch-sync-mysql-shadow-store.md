# Rewrite watch sync in Go, writing to MySQL as a dev-first shadow store

We are migrating the platform's watch-data path (and later the API + Worker
layers) from Python to Go. The COROS sync tool is the **tracer bullet**: a new
Go binary `stride-sync` (single module at `src/go/`, path
`github.com/zhaochy1990/stride`, `cmd/` + `internal/`) that reproduces the
Python `run_sync` write set and writes it to **MySQL** instead of per-user
SQLite — fast-forwarding the repo's dormant MySQL migration. For this first
step the tool writes MySQL **only** and **nobody reads it yet** (a "shadow
store"); the production Python server keeps reading its SQLite unchanged. We
prove correctness by running both and diffing (see `cmd/reconcile`).

## Considered Options

- **Self-contained Go binary writing SQLite** (byte-compatible with today's
  Python reader). Rejected: keeps us on SQLite and doesn't advance the MySQL
  end-state the Go worker + API both need.
- **Dual-write (MySQL primary + SQLite mirror)** so the server stays served.
  Deferred: doubles the Go storage surface for the first bite; adopt later via
  the pre-designed `dual_write_enabled` flag.
- **Full cutover** (port the Python MySQL read path + point the server at it)
  now. Rejected: drags the running app and unmerged infra into a tracer bullet.
- **Run the Go tool in-VNet against prod MySQL** now. Rejected: prod MySQL is
  VNet-private/TLS-only and this drops the self-contained local-dev goal.

## Consequences

- The tracer bullet targets a **local Docker MySQL 8**; VNet/prod cutover,
  dual-write, and the server-side MySQL read path are separate later steps.
- This builds on the Go async-job worker foundation (module + `cmd/`+`internal/`
  layout, `x/viper` config, GORM storage — ADR 0004). The sync core lives in
  shared `internal/` packages (`internal/coros`, `internal/provider`,
  `internal/storage`) and is invoked by **both** a `cmd/stride-sync` CLI
  (author-side, now) **and** a future worker **job handler** (production async) —
  not one or the other.
- The Python stack is untouched and remains the source of truth during the
  shadow phase; divergence is caught by reconciliation, not by users.
