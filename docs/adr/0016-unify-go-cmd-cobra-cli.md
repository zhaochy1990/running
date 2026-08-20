# Unify the Go `cmd` binaries into one cobra `stride` CLI

The Go module shipped four separate binaries — `cmd/worker`, `cmd/api`,
`cmd/reconcile`, `cmd/stride-sync` — each with its own `main`, and each parsing
flags differently (stdlib `flag` for `reconcile`, a hand-rolled `os.Args`
subcommand dispatch for `stride-sync`, none for the two servers). We consolidate
them into **one `stride` binary** whose services are subcommands built with
[`github.com/spf13/cobra`](https://github.com/spf13/cobra). This revises the
"several binaries under `cmd/<name>`" layout of ADR 0004, refines ADR 0010 (the
`stride-sync` binary becomes the `stride watch` subcommand group), and refines
ADR 0012 (the api stays a separate *process/container* but is now the same
binary invoked as `stride api`).

## Decision

- **One binary, `src/go/cmd/stride`, one `package main`.** Each service is a
  cobra subcommand, wired thin (parse flags, wire deps, run — the ADR 0004
  principle is unchanged):
  - `stride api` — HTTP API server (ADR 0012)
  - `stride worker` — async-job worker (ADR 0001/0002)
  - `stride reconcile` — Go-MySQL vs Python-SQLite diff dev tool (ADR 0005)
  - `stride watch` — watch-data sync group (ADR 0010/0011): `login`,
    `import-creds`, `sync`, `status`
- **`watch` names the provider domain; `sync` stays the fetch verb** →
  `stride watch sync`. Grouping the watch-provider operations under `watch`
  keeps them cohesive and lets the fetch verb keep its canonical name.
- **Deployment shape is unchanged.** Still two images — `Dockerfile` (worker)
  and `Dockerfile.api` (api) — but both now build the same binary and differ
  only by entrypoint (`stride worker` / `stride api`). The ADR 0012
  process/container isolation between the public ingress and the consumer is
  preserved.
- **cobra/pflag flag syntax.** Long flags are `--flag`; `--profile` keeps a
  `-P` shorthand to match the Python CLI convention in AGENTS.md
  (`--profile` / `-P`).
- **Swagger follows the binary.** The general API-info annotations move to
  `cmd/stride/main.go` (the `swag init -g` entry); the committed docs package
  (ADR 0014) moves `cmd/api/docs` → `cmd/stride/docs`; the tagged blank import
  in `internal/api/swagger.go` updates to match. Regeneration is zero-drift.
- **New dependency:** `github.com/spf13/cobra` (pulling
  `github.com/inconshreveable/mousetrap`; `spf13/pflag` bumped).

### Command → binary name mapping (for reading older ADRs)

| Older ADR reference        | Now                                   |
| -------------------------- | ------------------------------------- |
| `cmd/api`                  | `stride api`                          |
| `cmd/worker`               | `stride worker`                       |
| `cmd/reconcile`            | `stride reconcile`                    |
| `cmd/stride-sync <verb>`   | `stride watch <verb>` (`sync` verb kept: `stride watch sync`) |

## Considered options

- **Keep four separate binaries, adopt cobra inside each.** Rejected: the goal
  is a single binary; four `main`s duplicate wiring and the flag handling was
  inconsistent across them.
- **Flatten the watch verbs to top level** (`stride sync`, `stride login`,
  `stride status`, `stride import-creds`). Rejected: mixes watch-provider ops
  with the server/dev verbs (`api`/`worker`/`reconcile`) at one level.
- **Group named `sync` with the fetch verb also `sync`** (`stride sync sync`).
  Rejected: redundant. `watch` = the provider domain, `sync` = the action.
- **Unify to a single deployable container** too. Rejected: keeps ADR 0012's
  security/scaling isolation — one binary, two images/entrypoints.

## Consequences

- **Single-dash long flags no longer work** (pflag): `-profile` → `--profile`
  (`-P`), `-sqlite` → `--sqlite`, `-table` → `--table`, plus
  `--full`/`--content`/`--limit` and `--provider`/`--email`/`--password`/
  `--region`. Operators and any scripts must switch to `--`.
- **The `stride-sync` binary name is gone.** `login`, `import-creds`, `status`,
  and the `sync` fetch are now `stride watch <verb>`.
- **Verification / build commands move to the one package:**
  `go build ./cmd/stride`, `go run ./cmd/stride reconcile …`,
  `go build -tags swagger ./cmd/stride`; `make swagger` regenerates into
  `cmd/stride/docs`; `Dockerfile.api` points `swag -g` at `cmd/stride/main.go`.
- **Earlier ADRs' `cmd/api` / `cmd/worker` / `cmd/reconcile` / `cmd/stride-sync`
  path mentions are historical** — translate via the mapping above. (This
  mirrors how ADR 0010 treats the `internal/coros` → `internal/provider/coros`
  rename: the older mentions stand as written and are read historically.)
- The single-module, `cmd/` + `internal/` split (ADR 0004) and the
  registry-selected-provider design (ADR 0010) are otherwise unchanged.
