# Go current season-plan read cutover

## Goal

Make Go/MySQL the only data source used by Web to display the active 赛季训练计划, regardless of whether its content is Markdown or structured JSON. Do not migrate or modify Python APIs or inactive generation/editing workflows.

## Unified API

`GET /api/users/me/master-plan/current` returns one of two envelopes:

```ts
type CurrentSeasonPlan =
  | {
      content_version: 1
      status: 'active'
      plan_id: string
      goal_id: string
      revision: null
      created_at: string
      updated_at: string
      plan: string
    }
  | {
      content_version: 2
      status: 'active'
      plan_id: string
      goal_id: string
      revision: number
      created_at: string
      updated_at: string
      plan: SeasonPlanContent
    }
```

- Query all rows for the user where `active_flag=1 OR status='active'`; require exactly one candidate and require both markers to agree. This exposes either direction of marker drift instead of misreporting it as absence.
- Return 404 only when no canonical current row exists.
- Return 500 for database failure, status/flag inconsistency, empty `plan_id`/`goal_id`, empty Markdown, invalid JSON, missing required structured fields, invalid revision, or missing timestamps.
- Never fallback to Python, Azure, files, or SQLite.
- For JSON, overwrite nested goal ID from the row when needed and log drift. Remove resource metadata from `plan`; the envelope is authoritative.
- Preserve the current structured response enrichment for phase/week position and weekly actuals.

## Storage

- Rename the Go model and physical MySQL column from `version` to `revision`.
- Enforce:
  - `content_version IN (1,2)`
  - `(content_version=1 AND revision IS NULL) OR (content_version=2 AND revision>=1)`
  - `(status='active' AND active_flag=1) OR (status<>'active' AND active_flag IS NULL)`
  - one active row per athlete across both formats through the nullable unique index.
- Use an explicit DDL migration, not GORM AutoMigrate, for the destructive rename and check replacement.

## Frontend

- Replace the current `MasterPlan | null` API result with the strict `CurrentSeasonPlan | null` union.
- `/plan` makes only the unified current request for active-plan display. Remove unconditional draft, training-goal, profile, and legacy training-plan reads from this load path.
- Render structured content with the existing season overview and Markdown with the existing Markdown renderer.
- A 404 enters the existing creation screen. Any other error renders a dedicated read-error state and must not be interpreted as absence.
- Do not display revision to athletes.
- Keep legacy `MasterPlan` types for Python draft/by-ID flows. Old writing pages unwrap the new current envelope only enough to compile; runtime compatibility is explicitly unsupported.

## Legacy Endpoint Removal

Remove `GET /api/{user}/training-plan` from:

- official Web API wrappers and callers
- BFF manifest and tests
- Go router, tests, E2E coverage, Swagger artifacts, and store port
- mobile client/model
- production probe logic, replacing its format check with unified `content_version`
- public frontend/auth/API documentation

Do not modify or delete the Python endpoint. Do not add a BFF deny rule; official clients simply stop calling it.

## Migration CLI

- Read both Azure sources and the MySQL target during dry-run.
- Bind every action to one selected STRIDE user UUID. The Azure partition owner, source JSON `user_id` and `plan_id`, manifest user/plan IDs, and target MySQL `user_id`/`plan_id` must agree; any mismatch is a conflict.
- Structured JSON supersedes Markdown when both source forms exist.
- Classify every selected real user as missing, identical, insert, or conflict. Target discovery uses `active_flag=1 OR status='active'`; multiple candidates or either direction of marker drift is a conflict. A different existing MySQL current is always a conflict and is never overwritten.
- Emit a redacted structured manifest containing source kind, source/target plan IDs, content hashes, content version, revision, goal ID, action, validation/conflict reason, and post-commit hash. Never include content, athlete names, credentials, or tokens. The manifest has a stable hash.
- Commit accepts the reviewed manifest, re-reads source and target, and refuses to proceed if their identities or hashes differ from that manifest. Manual approval remains outside the tool; hash binding only guarantees that the approved inputs are the committed inputs.
- Map legacy source `version` to canonical `revision`; do not mutate Azure source data.
- Commit each user in a transaction and verify exactly one valid current row plus the expected hash after commit.
- Add an idempotent schema-upgrade operation:
  - only `version` exists: rename and replace checks
  - only `revision` exists: validate and no-op
  - both or neither exist: conflict and stop
- On migration failure, leave the Go API stopped and fix/re-run. Do not automatically reverse the schema.

## Release Procedure

1. Run target-aware dry-run and manually review the manifest.
2. Build and publish the new Go API and Web images without rolling them out.
3. Start a full Go-API maintenance window: remove the service from traffic and stop every old Go API instance. All Web features already routed to Go are unavailable during this window.
4. Run the schema/data commit and post-commit verification.
5. Start and verify the new Go API.
6. Deploy Web with the Dockerfile route default set to Go.
7. Do not roll back to the old Go image unless the database schema is manually reversed first.

No deploy-workflow readiness gate is added.

## Testing

- Go authenticated HTTP seam: Markdown envelope, JSON envelope and enrichment, 404, malformed content, invariant failures, auth, and storage errors.
- Go storage seam: format-agnostic current read, tenant isolation, identity checks, both directions of active/status drift, revision checks, and active uniqueness.
- Migration CLI seam: target-aware dry-run, user/partition/row identity binding, redacted manifest, v2 precedence, two-way active-marker conflicts, identical/insert/conflict classifications, transactions, explicit schema states, idempotency, and post-commit verification.
- Frontend/BFF seam: strict union routing/rendering, one-request load path, 404 creation path, 5xx error path, route manifest, Docker default, and removal of legacy calls.
- Browser seam through local BFF: structured display, Markdown display, no-plan creation screen, and read-error state.
- Run Go tests/vet, migration tests, frontend/BFF tests/builds, required `smoke:web:local`, focused `/plan` smoke, and independent code review.

## Out Of Scope

- Any Python API or Python storage change.
- Migrating or disabling draft, by-ID, generation, review, confirm, adjustment, or Coach write APIs.
- Making legacy writing pages function with the new read contract beyond compiling.
- Adding deploy-workflow readiness automation.
- Removing direct `TRAINING_PLAN.md` reads used by commentary, local authoring, or migration source ingestion.
