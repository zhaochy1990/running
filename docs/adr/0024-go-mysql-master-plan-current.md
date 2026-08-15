# Go serves one content-versioned current season plan

The athlete has one active 赛季训练计划 that may be stored as Markdown (`content_version=1`) or structured JSON (`content_version=2`). Go reads both formats through `GET /api/users/{user_id}/master-plan/current`, backed only by canonical MySQL. The original `GET /api/users/me/master-plan/current` remains a compatibility alias for user-facing Web clients. Python APIs are unchanged and are not a fallback for the Go contract.

## Decision

- `master_plan` remains one content-versioned table. A single format-agnostic current query loads every row marked current by either `active_flag=1` or `status='active'`, requires exactly one row whose two markers agree, and dispatches by `content_version`.
- The response is a discriminated envelope with `content_version`, `status`, `plan_id`, `goal_id`, `revision`, `created_at`, `updated_at`, and `plan`. Markdown returns `plan` as a non-empty string and `revision=null`; structured content returns an object and a positive `revision`.
- Resource metadata belongs to the envelope. For structured content, `plan_id`, `user_id`, `status`, `version`, `created_at`, and `updated_at` are removed from the stored JSON projection. The nested goal ID is retained, checked against the row, and corrected to the row value with a warning on drift.
- Structured responses retain the existing Go enrichment: current phase, current week, next milestone, expanded weeks, actual running summaries, and STRIDE training-dose summaries.
- The canonical relational field is `revision`, not `version`. Markdown requires `revision IS NULL`; structured content requires `revision >= 1`. `status` and `active_flag` must agree, and the existing unique index continues to enforce at most one active row per athlete across formats.
- The Web `/plan` active path makes one request to the unified endpoint. A 404 alone enters the existing creation UI; transport failures, malformed content, invariant violations, and storage errors render an explicit read error.
- The path-scoped endpoint accepts three caller classes: a user JWT may read only the path matching its `sub`; a JWT on the separately configured admin audience with `role=admin` may read any user; and `X-Internal-Token` may read any user. User cross-tenant reads return 403. Admin authority is not inferred from `role` on the normal user audience, and the two configured audiences must differ. The admin tier is denied by default on every existing user/internal route and admitted explicitly only on this path-scoped read.
- The `/me` compatibility alias continues to require a user JWT and resolves the target only from `sub`; it does not accept the internal token. Both routes share the same response builder and enrichment implementation.
- Draft, by-ID, generation, review, confirm, adjustment, and Coach write APIs are not migrated or disabled. Based on the product owner's operational knowledge, these flows currently have no users; the explicit product decision is to give them only the minimum frontend type adaptation needed to compile, with no compatibility acceptance criterion.
- Python APIs are not modified and Python must not read MySQL. If the BFF is misrouted back to Python, the envelope mismatch is allowed to fail visibly.

## Migration And Cutover

- The Node master-plan migration becomes target-aware. Dry-run binds Azure partition, embedded identity, selected user, manifest identity, and MySQL row to the same STRIDE user/plan; any mismatch is a conflict. It reads both Azure source and MySQL target, detects current rows through either active marker, emits a redacted per-user manifest with a stable manifest hash, treats structured content as superseding Markdown, and refuses to overwrite a different existing MySQL current row. Commit re-reads source and target and aborts if either identity or hash no longer matches the reviewed manifest.
- Commit writes each user transactionally and verifies the row and content hash after commit. The manifest is reviewed manually; it is not an automated deployment gate.
- The schema change is a planned outage for the entire Go API, including every Web route already cut to Go: remove it from traffic, stop the old process, use the migration CLI to rename `version` to `revision` and replace the checks, migrate/verify data, then start the new Go API before restoring traffic. The migration is idempotent for old-only and new-only schema states; dual-column or missing-column states are conflicts. Old Go images cannot be restarted or rolled back without first reversing the schema migration.
- Web compatibility routing remains declared in `Dockerfile.web` with `STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_CURRENT=go`. Consumers of the path-scoped endpoint need an explicit front-door route to Go. No deploy-workflow readiness gate is added; release ordering and manifest review are manual operational controls.

## Consequences

- `content_version` identifies the representation; `revision` identifies a structured plan mutation. They are different concepts and must not be called versions interchangeably.
- MySQL absence or failure never falls back to Azure, files, SQLite, or Python.
- Python compatibility APIs remain untouched; unmatched requests still follow the BFF's default Python behavior, but official clients expose only the unified current-plan route.
- The old Python write system may continue using its legacy `version` model internally because it is outside this read migration.
- The migration CLI's destructive DDL is a narrow, one-time exception to ADR 0006's single Go schema-owner rule. The final Go GORM model remains the canonical steady-state schema; the CLI only performs the rename that AutoMigrate intentionally cannot express.
