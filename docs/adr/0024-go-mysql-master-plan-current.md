# Go `cmd/api`: `GET /master-plan/current` + `GET /{user}/training-plan` on one `master_plan` MySQL table

The athlete's overall/season training plan exists today in two forms: a **legacy markdown overview** (`TRAINING_PLAN.md`, one per user, in the Azure Blob content-store) that older users still see, and a **structured `MasterPlan`** (in Azure Table `stridemasterplan`) that migrated users have. The frontend `/plan` page already treats them as one thing via a fallback chain. ADR 0021 already ported the race goal to `race_goal`; this ADR ports the **read side of both representations** — `GET /api/users/me/master-plan/current` (#6, structured) and `GET /api/{user}/training-plan` (markdown) — to a **greenfield Go `cmd/api` + MySQL** design, storing both in **one `master_plan` table discriminated by `content_version`**. Per the ADR 0013 / 0021 precedent it ships `goReady:true` with the BFF routes left on Python — **the flip is deferred** (see Consequences). This is the first step of a full master-plan migration off Azure; the write and LLM-generation endpoints are out of scope.

## Decision

### Scope: two read endpoints, this task only
- **`GET /master-plan/current` (#6)** — the active *structured* plan (`content_version=2`), or `404`.
- **`GET /{user}/training-plan`** — the *markdown* overview (`content_version=1`), or an empty payload.
- Everything else stays on Python for now: the LLM-orchestration endpoints (`generate`, `review/messages`, `adjust/messages` — they depend on the `coach` graph subsystem that has no Go port), the writers (`review/apply`, `confirm`, `adjust/apply`, coach `master-plan/apply`), the other structured reads (`draft`, `{plan_id}`), and the two dead `versions` HTTP endpoints (no frontend consumer). **No `master_plan_version` table** — version snapshots are written only by the out-of-scope adjust flow.

### Storage: one `master_plan` MySQL table (ADR 0006, GORM AutoMigrate), content-versioned
The two representations are the **same logical artifact — the athlete's overall training plan — in two content formats**, so they share one table. `content` holds either markdown text (`content_version=1`) or `MasterPlan` JSON (`content_version=2`); a `v1→v2` upgrade is a row rewrite, not a cross-table move. The structured JSON stays an opaque blob (hybrid, not normalised): the app always whole-loads it and never queries an inner field, and normalising would force re-implementing all of `MasterPlan`'s Pydantic validation in Go/SQL for no query benefit.

```
master_plan
  plan_id         VARCHAR(36)  PK             -- v2: MasterPlan.plan_id (uuid4); v1: synthetic uuid4
  user_id         VARCHAR(64)  NOT NULL       -- JWT sub (same id space as user_profile / race_goal)
  content_version TINYINT      NOT NULL       -- 1 = markdown overview, 2 = structured MasterPlan JSON
  content         LONGTEXT     NOT NULL       -- v1: markdown text; v2: MasterPlan JSON (GORM serializer:json)
  goal_id         VARCHAR(36)  NOT NULL       -- soft reference to race_goal.goal_id (see below)
  status          VARCHAR(16)  NOT NULL       -- draft | active | archived; a markdown row is 'active'
  active_flag     TINYINT      NULL           -- storage constraint only: 1 on the current row, else NULL
  version         BIGINT       NULL           -- v2 MasterPlan.version; NULL for v1 (markdown has no plan version)
  created_at      DATETIME(3)  NULL           -- carried verbatim from the source (domain-owns-time)
  updated_at      DATETIME(3)  NULL
  UNIQUE KEY uidx_master_plan_active (user_id, active_flag)
  KEY idx_master_plan_goal (goal_id)
  CONSTRAINT ck_master_plan_content_version CHECK (content_version IN (1,2))
  CONSTRAINT ck_master_plan_v2_version      CHECK (content_version = 1 OR version IS NOT NULL)
```

- **`active_flag` is a storage-integrity lever only, never business logic, never in the API response.** `UNIQUE(user_id, active_flag)` with `active_flag=1` on the current row and `NULL` otherwise (MySQL unique indexes do not collide on `NULL`) enforces **at most one *current* plan per athlete across both formats** — the same nullable-unique mechanism as `race_goal` (ADR 0021; GORM AutoMigrate has no generated columns, MySQL no partial indexes). Because a markdown row is also `status='active'` + `active_flag=1`, "the athlete's current plan" is the **format-agnostic** query `WHERE user_id AND active_flag=1`. This must be spelled out in the model/store comments so nobody reads business meaning into `active_flag`.
- **`goal_id` is `NOT NULL` for both formats** — a *soft* reference to `race_goal.goal_id` (indexed, **no** MySQL `FOREIGN KEY`, matching the house standalone-table style). v2 copies `plan.goal.goal_id`; **v1 extracts the real goal from the markdown at migration time** (minting a `race_goal` row when needed). A hard FK would instead couple backfill ordering and reject any row whose goal has no `race_goal` peer.
- **`status` is `NOT NULL`**; a markdown overview is modelled as `active` (it *is* that user's current plan). `draft`/`archived` only ever occur for v2.
- **`version` is the only v2-only column** (markdown has no plan-version concept), so it stays nullable and is guarded by `ck_master_plan_v2_version`. (`goal_id`/`status` ended up globally `NOT NULL` via the two rules above, so no CHECK is needed for them.)
- **Timestamps: instants are `DATETIME(3)` carried verbatim** from the source (domain-owns-time, ADR 0003/0006); the authoritative v2 `created_at`/`updated_at` also remain inside the JSON. Calendar dates inside the plan stay strings in the blob, never tz-converted.

### Response fidelity
- **`#6` is not a verbatim passthrough.** Filtering `content_version=2 AND active_flag=1`, Go reproduces the Python shape exactly: the deserialised plan body; three **pure date-derived** fields from *today (Asia/Shanghai)* — `current_phase_id`, `current_week_number`, `next_milestone` (`days_until`) — via `internal/utils/timefmt` (ADR 0022); and per-week **actuals** on `weeks[].actual_*` (distance / pace / HR / count / duration / STRIDE dose + coverage + status). The actuals are aggregated per Shanghai-day week window (each week's end clamped to today) from the athlete's own MySQL data (ADR 0005/0006): the running rollup from `activities` (reusing the canonical `runningActivityPredicate`, duration-weighted pace/HR), and the dose rollup from `daily_training_load` at the live `trainingload.ModelVersion`. A "complete" dose for a not-yet-finished week is reported as "partial". `CompletedPhaseSummary` is already cached in the blob and served as-is.
- **The markdown endpoint** filters `content_version=1` and returns `{content, phases: [], current_phase: null}`. The old response's `phases` array is unused by the frontend, and `current_phase` came from a **hard-coded single-athlete `PHASE_DEFS` timeline** that is simply wrong for a general user — both are dropped in the greenfield port; the `/plan` lede degrades from "当前阶段 · X" to "训练总纲".

### Migration & flip (deferred — this task ships the plan + unrun tooling, not the cutover)
- **`goReady:true`, BFF routes stay on `python`.** The Go readers are dormant until a later task flips the writers; until then Python keeps writing Azure and `master_plan` is a backfilled snapshot.
- **Two one-shot backfills authored now but not run** (unit-tested against fixtures), added to the existing `src/migration/` Node project, **real users only** (`src/migration/src/users.js`), run **after** the goal backfill:
  - v2 from Azure Table `stridemasterplan` (reusing `masterplan-azure.js`), **`active` plans only**; `plan.goal.goal_id` is already the final UUID after ADR 0021's re-mint, copied verbatim into `goal_id`.
  - v1 from Azure Blob `TRAINING_PLAN.md`, one `active` row per markdown user; **parse the markdown to extract the goal and populate `goal_id`** (minting a `race_goal` row where absent).
- **`schema.sql` gets a `master_plan` DDL block** (byte-for-byte `SHOW CREATE TABLE` of the AutoMigrate output), per the migration-tooling convention.

## Consequences
- **Polymorphic table, deliberately.** `version` is nullable/v2-only and CHECK-guarded; `goal_id`/`status` are held globally `NOT NULL` by extracting v1 goals and modelling markdown as `active`. The payoff is one entity, one store, and a `content_version`-bump upgrade path instead of a cross-table move.
- **v1 backfill is non-trivial.** Extracting a real goal from free-form markdown to satisfy `goal_id NOT NULL` is parsing work with failure modes; a markdown user whose goal can't be parsed blocks the row and must be handled (manual seed or a fallback goal) at migration time.
- **Dual-store during coexistence + stale markdown.** While the routes stay on Python, `master_plan` is written by nothing in prod. The markdown is *externally authored* (`sync-data.yml` → Azure Files), so the MySQL copy is a frozen snapshot until the authoring pipeline is repointed — a flip-time concern.
- **Other Python readers of `TRAINING_PLAN.md`** (`commentary_ai.py`, `body_composition.py`) still read the blob; porting or dual-writing them is separable flip-time work (the ADR 0021 deferred-reader pattern).
- **`#6` parity has a cross-task data dependency** — its `weeks[].actual_*` need the athlete's activities + `daily_training_load` in MySQL (watch-sync / health migration). Those are already in prod, so the aggregation is implemented and verified read-only against prod data; it is required before the flip, not before this dormant endpoint ships.
- **Dropped from the Go surface:** the hard-coded `current_phase`/`PHASE_DEFS` logic, the dead `phases` array, and the `master_plan_version` table + `versions` endpoints.
```
