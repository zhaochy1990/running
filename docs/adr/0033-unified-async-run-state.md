# Unify async pipeline and plan-job state on one Go-owned contract

Status: accepted

## Context

The system runs two parallel async state stores that operators see as "the
same thing" but which are invisible to each other:

- **Go pipeline runs** (`pipeline_runs` → `jobs`, both in the `stride` MySQL db,
  written only by `src/go/internal/storage/`; ADR 0003 / 0012). A pipeline is a
  linear sequence of Go jobs; the worker runs Go handlers. Names: `onboarding`,
  `data_sync`.
- **TS plan jobs** (`plan_jobs` in the `coach_agent` MySQL db, written by
  `src/coach_agent_worker/src/storage/planJobs.ts`; ADR 0030). A plan job is one
  long-running TS LangGraph kernel execution (generate / adjust × season /
  weekly). Names: `generate_master_plan`, `generate_weekly_plan`.

The two execution engines cannot merge — Go runs Go job handlers, the TS worker
runs LangGraph kernels — so execution necessarily stays split. But **state does
not have to be split**: the admin surface (ADR 0032) already wants one place to
see "what is running / what ran", and today a plan job is invisible to the
`pipeline_runs` view.

Two facts make unification cheap right now:

- The Go `jobs` row and the TS `plan_jobs` row are nearly the same shape
  (job_type, status queued/running/done/failed, attempts, stage, progress_pct,
  input_json, result_json, error_code, error_message, idempotency_key with a
  `(user_id, idempotency_key)` unique key). TS adds only `heartbeat_at`.
- `plan_jobs` has **no production data** — the TS worker has only ever run
  tests — and a breaking change to the TS worker is approved. No backfill is
  needed.

## Decisions

1. **One contract: the Go `jobs` row is the shared leaf-state contract.** A plan
   job is a `jobs` row with `job_type` ∈ {`generate_weekly_plan`,
   `generate_master_plan`} and `pipeline_run_id = NULL`. A pipeline run remains a
   `pipeline_runs` row owning its step jobs. Add one column to `jobs` —
   `heartbeat_at TIMESTAMP(6) NULL` — for the TS stale-running reconcile; every
   other field already exists.

2. **One store, single writer preserved.** All async state lives in Go-owned
   tables (`jobs` + `pipeline_runs`) written only by `src/go/internal/storage/`
   (ADR 0006, SQL ownership rule unchanged in spirit). The TS worker does not
   write these tables directly.

3. **TS worker participates through the Go internal API.** Add
   `POST /api/internal/jobs/{job_id}/transition` (X-Internal-Token) and
   `GET /api/internal/jobs/{job_id}` (the full row, including `input_json`). The
   worker therefore never opens a connection to the `jobs` database — not even to
   read. This is the same dependency class the worker already has for draft
   insert (`draftClient`), so it is incremental, not a new coupling. The worker
   batches transition calls (one per stage / per N% progress, ~10–20 per job).

   The transition body is the shared CAS contract, not a raw row write:
   `{to, from?, attempts_delta?, attempts_lt?, stage?, progress_pct?,
   error_code?, error_message?, clear_error?, result_json?, heartbeat_at?,
   completed_at?}`. Three fields exist because the worker's state machine needs
   them and a naive payload could not express them safely: `attempts_delta`
   (`attempts = attempts + 1`) keeps claim/reclaim an atomic expression instead
   of a racy read-modify-write; `attempts_lt` re-checks the redelivery budget in
   SQL so two concurrent redeliveries cannot both pass; `clear_error` is explicit
   because `*string` cannot distinguish "absent" from "set to null". A guard miss
   is `409 job_state_changed`, which the worker treats as losing a race, not as
   an error.

4. **Enqueue goes through Go too.** The coach API enqueues by calling
   `POST /api/internal/jobs` (store-first, idempotent on `(user_id,
   idempotency_key)`, mirroring Go's `StoreEnqueuer`) and then publishes the
   pointer to the existing `plan.jobs.*` queue. `MySqlPlanJobStore` /
   `PlanJobEnqueuer` are replaced, not duplicated. The `create` response
   distinguishes `201` (created) from `200` (idempotency key resolved to an
   existing row); on `200` no pointer is published, so a retried client call
   cannot double-run the kernel.

5. **Queues stay separate.** RabbitMQ is a transport, not state. The Go worker's
   queues and `plan.jobs.*` remain as they are; the worker that consumes a
   pointer is unchanged.

6. **Execution stays split.** Go runs Go handlers; `stride-coach-worker`
   consumes `plan.jobs.*`, runs the LangGraph kernel, and reports every state
   change through the Go transition endpoint. The draft still lands through the
   existing Go internal insert endpoint.

7. **`plan_jobs` is retired.** With no production rows, the cutover is: stop
   writing it, switch enqueue/poll to Go, then drop the table. No migration
   backfill. This supersedes ADR 0030's "worker owns the plan-job status table"
   clause for *state*; ADR 0030's queue ownership and draft-single-writer clauses
   are unchanged.

8. **Admin surface converges on Go.** `GET /api/admin/async-runs` merges
   `pipeline_runs` with standalone `jobs` (`pipeline_run_id IS NULL`) into one
   newest-first, paginated list, replacing the coach-API poll hop for plan jobs.
   The dashboard's swap to it is a read-layer change and lands separately; the
   store is Go either way.

## Consequences

- One operational view: onboarding / data_sync / create-weekly-plan all appear in
  one list with one contract and one lifecycle policy to converge on.
- TS worker availability now depends on the Go API for every state transition —
  already true for draft insert; transitions are retried/buffered and the Go API
  is the same deployment family.
- AGENTS.md SQL ownership section is updated to note the TS worker writes job
  state *through the Go internal API*, never directly — the rule's letter is
  untouched.
- The change is bounded: one additive column, three internal Go endpoints (create,
  get, transition) plus the stale-running reconcile and the admin list, a
  worker-store swap, one dropped table. The admin frontend swap is a separate,
  read-layer change.
- The `heartbeat_at` column arrives through the existing `store.AutoMigrate`
  (GORM), so there is no hand-written migration. Dropping `plan_jobs` from the
  `coach_agent` database is a one-off operator step — nothing in the TS runtimes
  creates or writes it any more.
