# ADR 0047: Explicit historical-metrics recompute — staged publication and consistent vintage

Status: accepted for engineering implementation; execution stays default-off
and production backfills remain unauthorized (extends ADR 0045/0046, epic
devops#1004 T08 / devops#1012).

## What is implemented

An independent, auditable, operator-dispatched job type
`historical_metrics_recompute` plus two tables
(`historical_metrics_recompute_runs`,
`historical_metrics_recompute_staged`). Every run pins its analysis as-of day,
the 365-day target window, the binding revision, the calibration policy
version + revision, a full-history input-data digest (the PB stage reads
beyond the window), and — the vintage marker — the **frozen calibration
bundle** it consumes: the run id and bundle fingerprint of the newest
completed `historical_calibration_recompute` run (ADR 0046). The trigger is
the same explicit internal jobs-API dispatch as T07 — never a GET, a sync
pipeline step or a listener; a user without a completed calibration run gets
a permanent `calibration_bundle_missing`, not a retry.

The rebuild follows the ADR 0045 order through five phases, each yielding
between bounded chunks (chained jobs under stable idempotency keys, no
per-user lease held between chunks):

1. **activity** — per-activity load/classification/zones over the window, at
   most 20 activities per chunk (逐活动每 20 条). An activity whose Shanghai
   day has no calibration bundle stages an explicit skip marker; its existing
   production rows are preserved untouched.
2. **daily** — the PMC chain over the window in 30-day chunks (PMC 每 30 日),
   seeded explicitly: a provenance-verifiable prior daily row (frozen seed),
   a legacy row (`legacy_seed_lineage_unavailable`), or an explicit zero
   anchor at the window start. The chunk's doses come from the staged load
   ledger — the exact rows the publication promotes, so the PMC chain is
   derived from what actually publishes.
3. **pb** — the full-history PB scan in 20-activity chunks (PB 每 20 条),
   using the canonical `pb.Scanner` checkpoint/resume form; race-recognition
   results participate through the canonical classification evidence the
   loaders read.
4. **l1** — per-activity L1 over the window (20-activity chunks), recomputed
   rather than only filled (a rebuilt baseline legitimately changes values);
   no HRMax for an activity's day is an honest skip, never today's value.
5. **publish** — ONE transaction promotes the whole staged set in the ADR
   0045 order (load → zones → daily → PB → L1; PB replaces the whole set,
   everything else upserts only staged keys), then — separately, after L1 is
   published — the as-of day's four-layer ability snapshot is refreshed
   through the ordinary ability path (当天四层 ability 收口). No plan or
   watch-push record is touched.

## Visibility and consistency

Staged rows live in a table ordinary API/Coach reads never touch, so until
the publication transaction commits, the previous consistent derived results
keep serving — a half-finished run cannot mix a new PMC chain with an old
baseline or vice versa (不混用 PMC 链和基线). Inside the publication
transaction the cheap fence invariants are re-verified (run still active,
pinned binding revision, pinned policy revision, calibration run still
terminal with the pinned bundle fingerprint); the full data digest is
re-verified immediately before it, mirroring T07's publish gate. Publication
is idempotent (upserts / per-key replaces / whole-set PB replace), so a crash
between promotion and finalize re-runs cleanly. At finalize the whole staged
ledger is frozen into one output fingerprint with honest gap accounting:
skipped activities, HRMax-unavailable L1 rows or an unavailable ability
refresh terminalize `completed_with_gaps` — raw history may be complete while
the analysis honestly is not.

## Known limitations

- Day-granularity gaps: when a day's activities were all skipped (no day
  bundle), the published daily row's coverage derives from the staged loads
  and health rows only — the run-level `completed_with_gaps` plus the staged
  skip markers are the honest gap record; the daily row itself carries no
  per-day skip annotation (the schema has no such column).
- Vintage reads: the derivation reads the published per-day calibration rows
  (the as-of keyed natural-key rows), not a byte-frozen copy of the T07
  bundle. The claim refuses while a calibration run is still ACTIVE, and the
  pinned calibration-window digest (row count, max update, source CRC sum)
  supersedes the metrics run the moment any window day is rewritten — before
  any further staging and again inside the publication fence. Within a single
  chunk, T07's own per-day atomic publication keeps each row individually
  consistent (its visibility argument), so no mixed-vintage row can publish.

## Revision isolation

Before every chunk and again at publication the run re-verifies its pinned
binding revision, policy revision, data digest and calibration bundle; any
change supersedes the run (`binding_revision_changed` /
`policy_revision_changed` / `data_revision_changed` /
`calibration_bundle_changed`) and old chunks refuse to publish. Claims are
atomic create-or-merge on the pinned identity: at most one active run per
user, repeat requests under the same revision merge, a different revision
supersedes first. A newer T07 run replacing the consumed bundle (a changed
bundle fingerprint) supersedes the metrics run — derived rows are never
promoted against a baseline that moved underneath them.

## Single algorithm

There is no second computation: the executor derives through the canonical
seams the ordinary paths use (`trainingloadsource.Load`,
`trainingload.ComputeActivityLoad`, the zones classifier, the daily PMC
series, the pb detector's resumable Scanner, `ability.ComputeL1Quality`, the
ability snapshot path), refactored into exported derivation helpers
(`handlers/compute` derive exports) so the ordinary and explicit paths share
one loop body. The staged daily phase maps the staged load rows back onto the
series' inputs — the same rows publication promotes.

## Explicit boundaries (what this ADR does NOT authorize)

- Production execution. `runtime.historical-metrics-recompute.enabled` is
  DEFAULT OFF; a stray job on a flag-off worker fails permanently
  (`historical_metrics_disabled`). Turning it on authorizes execution of
  operator-dispatched runs, not a fleet-wide backfill.
- Scope beyond V1: load/zones/L1/PMC target the 365-day window only; no
  multi-year daily ability or L1 backfill (the PB stage is the only
  full-history consumer). Missing day baselines stay honest gaps.
- Plan/push rewriting, race re-detection, or a new algorithm/baseline path.

## Verification

Real isolated MySQL tests drive a completed T07 calibration run first, then
the metrics run: same-input/same-seed single-segment vs chunked equivalence
(load/PMC/PB/L1 rows byte-identical minus timestamps), mid-run read-only
visibility (production rows unchanged while staged rows exist), input-change
supersede (a new activity changes the digest; the run supersedes and nothing
publishes), interruption recovery (continuation resume from the staged
ledger), and the current-ability closure (four-layer snapshot rows for the
as-of day after publication).
