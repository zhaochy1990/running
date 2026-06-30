"""stride_storage — unified data-access layer for STRIDE.

This package is the single home for all persistence: SQLite (watch-synced
running data), Azure Table / Blob stores (social signals, plans, notifications,
coach checkpoints), the markdown/JSON content store, and Key Vault secret
sourcing.

Import tiers (enforced by ``.importlinter`` Contract 5):

- **Tier A — ``stride_storage.interfaces``**: pure Protocols + frozen config
  dataclasses. No ``sqlite3``/``azure`` import. Safe for *any* package,
  including the pure ``coach`` runtime.
- **Tier B — ``stride_storage.sqlite`` / ``stride_storage.content``**: storage
  engines + implementations. Depend on ``sqlite3`` and ``stride_core`` domain
  types only.
- **Tier C — ``stride_storage.azure`` / ``.factories`` / ``.keyvault``**: Azure
  SDK only. ``coach`` must never import these.

This ``__init__`` deliberately performs **no eager import of Azure SDKs** so
that ``import stride_storage`` stays azure-free and cheap.
"""
