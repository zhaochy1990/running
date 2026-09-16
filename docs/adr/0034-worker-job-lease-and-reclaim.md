# Lease and reclaim a Go job stranded by a dead worker

Status: accepted

## Context

ADR 0033 unified async state on the Go-owned `jobs` + `pipeline_runs` tables and
added `heartbeat_at` "for the TS stale-running reconcile". That reconcile
(`POST /api/internal/jobs/stale-running`, called by `stride-coach-worker`) only
ever *failed* a stale row, and the Go dispatcher never stamped a heartbeat, so
the two engines' recovery paths did not overlap.

A Go worker that dies mid-job — deploy, OOM, node loss — leaves its job in
`running` forever:

- `Claim` only accepts `queued→running`, so the broker's redelivery of a
  `running` job is dropped by `Dispatch`.
- The Go handler only wrote `heartbeat_at` on progress callbacks (never), so the
  stale-running backstop could not see the row.
- SIGTERM tore the process down before the dispatcher persisted a retry, and its
  terminal write used the cancelled handler context.

Observed: a `stride-worker` deploy killed a full sync at 55%; the job never
resumed, and the same signature had been sitting in `running` since a month
earlier. The fix cannot live in the TS backstop: it must run where Go jobs are
claimed, and it must prefer **resuming** a job over failing it.

## Decisions

1. **The Go dispatcher owns a lease for every job it claims.** A background
   goroutine renews `heartbeat_at` at `claim-lease/3`, independent of handler
   progress, so a long silent fetch is still observably alive. A renewal is a
   `running→running` compare-and-set (`TransitionJob` with `From`/`To` = running);
   it can never resurrect a row another writer moved off `running`.

2. **The Go dispatcher reclaims expired-lease jobs.** On every replica, at boot
   and on `reclaim-interval`, `ReclaimStale` selects
   `status=running AND COALESCE(heartbeat_at, updated_at) < now - claim-lease`
   and, per row, a lease-guarded CAS:

   - `attempts < max-attempts` → `queued` + republish the pointer (resume).
   - `attempts >= max-attempts` → `failed` + `OnJobFailed` (fail the owning run).

   The `LeaseBefore` guard re-checks the lease at write time so a worker that
   renewed after the scan is never disturbed. Reclamation is scoped to job types
   this worker can run (`registry.Handler`), so it never touches a plan job.

3. **The two reconcilers are disjoint by job type.** The internal
   stale-running backstop takes an optional `job_types` filter, and
   `stride-coach-worker` passes its plan job types. Go-owned types are reclaimed
   by decision 2; plan types by the backstop. This supersedes ADR 0033's implicit
   "the backstop may fail any heartbeat-stamped row" reading, now that Go rows
   stamp a heartbeat too.

4. **Shutdown drains the in-flight job.** SIGTERM cancels the handler, and the
   worker waits (bounded by `drain-timeout`) for the dispatcher to record the
   requeue/terminal state before closing the broker. Terminal bookkeeping uses a
   context detached from the cancelled handler so it still persists. A hard kill
   that skips the drain is covered by decision 2.

## Consequences

- A deploy no longer strands an in-flight job: the new worker's boot sweep picks
  it up, or the lease expires and a peer reclaims it.
- A job that crashes its worker is retried up to `max-attempts`, then fails the
  run — bounded, never an infinite re-queue.
- `heartbeat_at` is now a general lease, not a plan-job-only field. The column
  and the `TransitionJob` CAS contract are unchanged (ADR 0033); only who writes
  them and with what policy is added.
- `stride-coach-worker` and `stride-worker` must be deployed from a revision that
  agrees on the `job_types` field. During the window where the Go API accepts the
  field but the TS worker does not send it, the backstop still matches every type;
  both outcomes (fail, requeue) are safe, and the CAS makes only one writer win.
- New config knobs: `runtime.claim-lease`, `runtime.reclaim-interval`,
  `runtime.drain-timeout`.
