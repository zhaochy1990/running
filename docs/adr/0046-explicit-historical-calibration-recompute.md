# ADR 0046: Explicit historical calibration recompute — capability boundary

Status: accepted for engineering implementation; execution stays default-off
and production backfills remain unauthorized (extends ADR 0045, epic
devops#1004 T07 / devops#1011).

## What is implemented

An independent, auditable, operator-dispatched job type
`historical_calibration_recompute` plus two tables
(`historical_recompute_runs`, `historical_recompute_days`). Every run row
explicitly declares its `analysis_as_of_day`, the 365-day target window
(asOf-364 .. asOf) and its PINNED input revisions: watch binding revision,
calibration policy version + revision, and an input fingerprint hashed over
the run's whole evidence window (the earliest target day's 180-day activity
reach) via the same digest the onboarding analysis uses. The trigger is an
explicit internal jobs-API dispatch — never a GET, an ordinary calibration
step, a sync pipeline step or a listener.

Per target day D, the canonical seam `compute.RunCalibrationAsOfDay` loads the
activities of [D-179, D] and the daily-health rows of [D-89, D] (the
estimator's own as-of windows) and publishes under the SAME
(user, as_of_date, version) natural key as the ordinary same-day path — one
algorithm, one table set. A day with zero evidence in both windows records
`unavailable`/`no_evidence` and writes NO snapshot; evidence that yields no
center records `partial` with the honest nil-center snapshot. Neither is an
error: they are ledger outcomes, never retried as network faults. A same-day
row whose persisted fingerprint already matches the fresh computation is
recorded `verified_existing` (验证) instead of a rebuild.

One job run processes at most 7 target days, persists the day ledger, then
chains the next chunk as a NEW job under a stable idempotency key
(`histcal:<run>:c<n>`) and reports `in_progress`. Between chunks the run holds
no lease — new trainings and webhooks jump the queue. Job-level retries and
crash restarts resume from the ledger (settled days are never recomputed); the
run's ChunkSeq is bounded and a no-progress loop fails the run visibly.

## Visibility and the frozen bundle

Per-day snapshots are each individually consistent as-of their event cutoff,
so ordinary as-of reads stay honest at every intermediate point: a day either
has its fresh bundle, an older legal bundle, or an explicit
unavailable-historical gap — the derived-write gate of ADR 0045 still refuses
load/PMC when a load-window day lacks a bundle, so a half-finished run cannot
silently produce derived rows. At final publication the run freezes its whole
ledger into one `bundle_fingerprint` (sorted day|status|fingerprint triples)
stored with the pinned input revisions. That frozen bundle — not the mutable
per-day rows — is the set marker downstream derived recompute steps
(per-activity load/classification/zones → PMC from an explainable seed or
explicit zero anchor → daily ability and L1, per ADR 0045's order) must
consume as one consistent baseline of a known vintage.

## Revision isolation

Before every chunk publishes, and again at final publication, the run
re-verifies binding revision, policy revision and the data fingerprint against
current reality. Any change supersedes the run (`binding_revision_changed` /
`policy_revision_changed` / `data_revision_changed`): old chunks refuse to
publish and the terminal state records why. The claim is atomic
create-or-merge: at most one active run per user exists; a repeat request
under the same pinned revision merges into it (and merely observes while its
chained chunk job is still live), while a request under a different revision
supersedes the active run first. Already-published per-day rows from a
superseded run remain legal as-of rows of the old revision; a fresh explicit
request rebuilds the window under the new one.

## Explicit boundaries (what this ADR does NOT authorize)

- Production execution. `runtime.historical-recompute.enabled` is DEFAULT
  OFF; a stray job on a flag-off worker fails permanently
  (`historical_recompute_disabled`). Turning it on authorizes execution of
  operator-dispatched runs, not a fleet-wide backfill; each run is an explicit
  per-user dispatch decision.
- Policy changes. The run never touches active/candidate selection: it writes
  v3-model per-day rows only. An active policy whose version is not the v3
  model is refused (`policy_active_version_not_supported`) — candidate and
  active-v4 historical writes have no authorized path (ADR 0045 gates).
- Derived recomputation. Load/zones/PMC/PB/ability historical recomputation
  and the `pending_explicit_recompute` user-facing surfacing are later
  tickets; this capability only prepares and freezes the calibration baseline
  they consume.
- Strict as-known replay. Event dates are the cutoff; the semantics remain
  `event_date_retrospective` (ADR 0045) — a day's baseline uses everything
  dated on or before it, including data that only became available later.

## Verification

Real isolated MySQL tests cover event-date cutoff (future health rows that
WOULD move the estimator stay invisible), missing-evidence honesty, cross-
chunk resume with a crash-simulating re-execution, chained-chunk yield
(continuation exists as a queued job), policy-bump and rebind supersede with
publish refusal, merged dispatch, and racing claims collapsing onto one run.
