# Single `stride-sync` binary, registry-selected provider; adapters under `internal/provider/{coros,garmin}`

> **Revised by ADR 0016:** the standalone `stride-sync` binary is now the
> `stride watch` subcommand group of the unified `stride` binary
> (`stride watch login|import-creds|sync|status`). The one-binary,
> registry-selected-provider decision below is unchanged; only the invocation
> moved from `stride-sync <verb>` to `stride watch <verb>` (the `sync` verb is
> kept: `stride watch sync`).

Adding Garmin means the Go watch-sync tool now serves two data sources. We keep
**one `stride-sync` binary** that resolves the provider per user from a registry,
and we regroup the adapters so COROS and Garmin are visible siblings under the
`internal/provider` contract package. This refines the `internal/coros` layout
that ADR 0004/0005 assumed when COROS was the only adapter.

## Decision

- **One binary, registry-selected provider.** `login` takes an explicit
  `-provider coros|garmin` (a brand-new user has nothing to resolve yet, and the
  login writes the binding). `sync` / `status` / `resync` take **no** provider flag —
  they resolve the user's single bound source via a registry. This mirrors the Python
  one-source-per-user model (`stride_core.registry`) and CONTEXT.md's "每个用户绑定唯一
  一个数据源".
- **Binding source of truth migrates.** Read the binding from the local
  `data/{uid}/config.json` `provider` field **now**; the end-state home is the
  `provider_credentials.provider` column (MySQL). The registry swaps its read source
  from file to MySQL without changing callers.
- **Folder structure.** The `provider.Provider` contract stays in `internal/provider`.
  Adapters nest under it: `internal/provider/coros` (moved from `internal/coros`) and
  `internal/provider/garmin` (new). Adapters import the parent contract package; the
  contract never imports an adapter (no cycle) — the binary wires concrete adapters.
- **Glossary.** `provider` / `adapter` are accepted vocabulary for 手表数据源
  (CONTEXT.md updated); the Go contract package is named `provider` deliberately.

## Considered options

- **`-provider` on every command.** Rejected: no registry needed, but diverges from
  the Python model and is error-prone — the wrong flag silently syncs the wrong /
  empty source.
- **Auto-detect from whichever credentials exist.** Rejected: ambiguous for a user
  bound to a source that has no credentials yet, and can't express intent.
- **Keep the flat `internal/coros` + add sibling `internal/garmin`.** Rejected: not
  really the requested restructure, and the adapters aren't visibly grouped under the
  contract.
- **Rename the contract package `provider` → `source`.** Considered to match the
  canonical term; rejected to avoid churn on every `provider.` reference — the
  glossary was relaxed to allow `provider` instead.

## Consequences

- `cmd/stride-sync` stops hard-coding `coros.New(...)`; it constructs the adapter the
  registry names for the user. A future worker job handler resolves the same way.
- Moving `internal/coros` → `internal/provider/coros` updates the import paths that
  ADR 0004/0005 referenced; those ADRs' `internal/coros` mentions are historical.
- Until the binding lives in MySQL, a user with a `provider_credentials` row but no
  (or a stale) `config.json` can't be resolved by `sync` — acceptable during the
  author-run shadow phase, closed out when the registry reads MySQL.
