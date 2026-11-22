# ADR 0045: Calibration policy, consistent bundles and frozen lineage

Status: accepted for engineering implementation; candidate release remains blocked.

## Ownership and selection

Go `internal/compute/calibration` owns production baseline algorithms. Python
`stride_core/running_calibration` remains a frozen legacy comparison. This
supersedes only ADR 0015's Python-first development rule for baseline metrics.
Frozen v3 numerical files and golden/hash controls remain unchanged.

Go storage owns one MySQL `running_calibration_policy` record, keyed
`running_baseline`. Missing row means in-memory active3/candidate4/fallback3,
revision0; missing table or query failure is an error. Migration and reads do
not insert defaults. Only the explicit storage CAS operation changes policy;
no public policy route or startup write is provided. Supported versions derive
from the domain constants and the Go-tested TS JSON contract.

Every ordinary API/job/registry/Coach read selects `active`. Version precedes
date: latest preferred-version row with as_of_date <= Shanghai cutoff day,
then fallback3 only if that row is absent. A candidate `constraints_only` row
with nil centers remains candidate; fields are never supplemented from v3.
Selection exposes requested/effective version, revision, state and reason.
A candidate-not-configured state is explicit. Future rows cannot fill history.

Since #999 a per-user override (table `running_calibration_user_override`,
one row per user, CAS `revision`, status active|revoked, actor/note audit)
takes precedence for `active` reads of exactly that user: the active override
pins one (algorithm_version, algorithm_revision) identity that is read with
the revision in the WHERE clause, ahead of the global preferred and fallback
versions. When the pinned identity has no snapshot at/below the cutoff the
chain falls back to the global selection with reason
`override_snapshot_missing` — a today-published revision never backfills
history. Candidate reads never consult the override (they remain the explicit
global comparison channel). The Go resolver (`ReadEffectiveRunningCalibration`)
and the TS adapter (`MySqlDataProvider.getLatestRunningCalibration`) are the
two implementations of this one policy; the shared
`calibrationPolicyContract.json` pins the table/status/reason strings and a Go
test locks them against drift. Revoking flips status to revoked under a
revision CAS: reads immediately restore the global selection while the audit
row survives; re-activating bumps from the stored revision. The single-user
publish boundary is one transaction (`PublishUserCalibrationOverride`):
snapshot + both zone tables + the override commit together or not at all, and
an identical already-active identity is a no-op so a retried publish never
bumps the CAS counter. A user override authorizes active-v4 derived writes for
exactly that user (`checkActiveCalibrationWrite` honors
`selection.override`); the incomplete-baseline gate still applies.

## Publication and historical identity

Snapshot and both zone tables publish in one transaction. The natural key is
(user, day, version, algorithm_revision): since #995 (2026-11-16 no-v5
decision) the additive `algorithm_revision` column separates the in-place
evolved v4 outputs (`v4-rev2-2026-11`) from historical v4 rows (empty
revision), so a new-revision write can never overwrite an old v4 row.
Same-(user,day,version,revision) republish remains an idempotent overwrite,
preserving the original same-day recompute semantics; legacy writers that do
not know the column keep defaulting it to '' and stay on their previous
identity. Revision values are validated ([A-Za-z0-9._-], <= 64 chars) before
entering the key. Readers keep one connection and an explicit REPEATABLE READ
readonly transaction for policy, snapshot and zones, and the same
`as_of_date DESC, id DESC` deterministic tiebreak within a version; the
per-user revision preference landed with #999 (see Ownership and selection).
GORM AutoMigrate adds the column but
never widens an existing unique index, so `AutoMigrateWatch` additionally runs
an idempotent `migrateRunningCalibrationRevisionIndex` step (rebuild
`uq_run_cal` on the four columns when an older three-column variant is
detected). Deployment order: apply the column + index change before deploying
new revision writers. Atomic writes alone would not prevent a reader seeing
old centers with new zones.

SourceJSON stores schema1 typed summaries: method, parameter version, event
cutoff, support, measurement quality versus effort, actual evidence dates,
bounded source references, sensitivity ranges and explicit limitations. It
excludes raw observations, samples, coordinates and notes. Speed evidence day
with a center is the actual maximal anchor day; today's nonbinding easy run
cannot refresh it. HR uses selected protocol evidence day. A separate
`latest_rejected_evidence_date`, a distinct `latest_stale_evidence_date`, and bounded categorical rejection/quality reasons
retain stale or rejected protocol explanations. `reasons` describes the current
estimate; optional bounded `rejected_reasons` describes unselected historical
protocols. A current selected HR center/support/date is not marked stale because
an older rejected protocol is stale. Clients and the Coach tool label that
history as non-contributing. Missing current support still has its current
unavailable reason and retains separate rejection explanations.
A newer quality rejection cannot
overwrite the older stale-protocol date; these never contribute a center,
range, support count or selected-evidence freshness. v3 remains a legacy
training estimate and is not relabelled independent physiological detection.
Unknown old shape, nil and invalid JSON have explicit unavailable states.

Go fingerprints a fixed JSON projection of snapshot natural key and values,
sorted zones and typed source, excluding execution time and generated row IDs.
TS copies this persisted fingerprint. It is an identity check, not a complete
raw-data reproduction guarantee. Same-day ID rewrites are mutable, so five
nullable `calibration_provenance_json` columns freeze actual values, zones,
selection and source on activity load, daily PMC, ability snapshot, activity
ability and activity zones. Output digest includes computed_at and output
fields; old writers changing a row while retaining an unknown provenance
column yield `legacy_or_stale_provenance`. Missing metadata is never backfilled
by joining the mutable snapshot. Source and output write in the same row.

PMC records each day's canonical bundle, including RHR readiness on rest days,
and its actual previous
CTL/ATL seed, date and seed provenance digest. This is calibration lineage,
not an immutable full-history event log. Legacy seeds are explicitly marked
`legacy_seed_lineage_unavailable`; zero-start full recomputes identify their
explicit anchor. Policy rollback cannot recover previously overwritten PMC.

## Computation and unavailable history

Activity load, classification and zones share cached bundles keyed by user,
Shanghai activity day and selection mode within one computation. They use
persisted zones, rather than regenerating today's zone boundaries for history.
Ability snapshot reads its as-of baseline; historical L1 reads each activity's
own day. RHR freshness and daily readiness consume the same canonical persisted baseline.
Daily readiness never computes a second long-term RHR percentile from health
rows. Missing day/RHR history adds `rhr_baseline_unavailable`; it does not borrow
future/today's baseline. The day's available or unavailable bundle is frozen even
when it has no activity, independently of the actual PMC seed chain.

If any load-window activity lacks a historical bundle, compute returns
`unavailable_historical_calibration`, reason
`explicit_historical_calibration_required`, derived_rows_written=0, before
writing load/PMC/zones. This preserves existing historical results. Ability
with missing as-of HRmax preserves existing snapshot rows; historical L1 with
missing HRmax is skipped, never filled with today's value or 185. No ordinary
read or pipeline implicitly builds a sequence of historical calibration rows.
This means first full imports with only today's snapshot can require an
explicit historical calibration/recompute operation. It is a visible limitation,
not a reason to silently overwrite history with zero or future evidence.

As-of currently guarantees event-date retrospective semantics only. An event
date is not a proof of when data became available. Public SourceJSON says
`event_date_retrospective`; it does not claim strict historical as-known replay.
The independent evaluation manifest remains the stronger availability gate.

## Candidate safety, schema rollout and rollback

Production wiring calls `NewCalibration`, whose candidate persistence gate is
off. Explicit isolated callers may opt into `NewCalibrationWithOptions`. Candidate
intent requires `AllowCandidatePersistence` even when its configured version is3; persistence
also rejects a candidate version equal to active or fallback because it would
reuse their snapshot key. Read/preview policy still supports these configurations.
Candidate persistence writes only candidate snapshot/zones. The read-only
`PreviewCandidateCalibration` seam returns load/ability results in memory;
it has no writer methods. Compute/ability reject candidate pipeline payloads,
including with an active write capability. The five active derived tables have
no candidate namespace and must not be used for candidate comparison.

A distinct, explicit future activation capability is implemented without enabling
production: `CalibrationOptions.AllowActiveCandidate` permits an active-v4
calibration refresh; `NewComputeWithOptions` / `NewAbilityWithOptions` accept
`ActiveCalibrationOptions.AllowActiveCandidate` for actual active-v4 downstream
writes. Default constructors keep every capability off. Shadow permission alone
cannot refresh an active-v4 key, and active permission cannot bypass candidate
payload/collision checks. An active refresh preserves label/health echoes and
does not mark its result candidate-only. Candidate refresh alone uses
`calibrationsource.LoadCandidate`, preserving storage pause/source/binding/as-of
metadata. Full, historical and standalone v3 recalibrations use the original
loader. An incremental sync applies equivalent per-activity evidence to the
same rolling window, as described in [ADR 0020](0020-go-user-sync-endpoint.md).

Active-v4 derived writes require both threshold centers plus RHR/HRmax inputs.
An incomplete candidate bundle reports `unavailable_active_calibration` /
`candidate_baseline_incomplete` and preserves existing derived rows. It cannot
borrow v3 fields. Compute resolves all needed day inputs before its first derived
write. This is a conservative integration gate, not a changed scientific model.
Current ordinary storage metadata does not assert verified maximal protocols;
a successful active-v4 refresh can therefore honestly remain constraints-only.

Deployment sequence (not executed by this change):

1. Apply additive policy table and five nullable columns before new readers and
   writers. Verify schema readiness explicitly; pod AutoMigrate ordering alone
   does not establish a safe multi-pod rollout. The #995 revision-key change
   follows the same rule: `algorithm_revision` column plus the rebuilt
   `uq_run_cal` index land before any new-revision writer.
2. Deploy all Go and TS readers, retaining active3 and candidate persistence off.
   Old binaries select highest version: **do not persist candidate into shared
   production while any old reader exists**.
3. Only a later explicitly authorised rollout may enable production shadow
   persistence or change policy, after independent accuracy gates pass.

No production migration, policy change, candidate write or backfill is included.
Schema rollback may leave additive columns/table in place. Policy rollback to3
changes future reads and target resolution, not already-applied plans or raw
activities. After an explicitly opted-in activation writes v4-derived active rows,
rollback requires explicit v3 recomputation over the affected interval; changing
the pointer alone is not a derived-data rollback.

Explicit recompute order is historical calibration snapshots → per-activity
load/classification/zones → PMC from an explainable compatible seed or explicit
zero anchor → daily ability and per-activity L1. No default production history
recomputation is added. Existing plans and push records are not rewritten.
#999 ships this order as the internal `user_calibration` job (actions
publish/revoke/recompute) plus the operator CLI `stride calibration user
preview|publish|revoke|recompute`: recompute refreshes the effective snapshot,
then rebuilds load/zones/PMC/ability for a bounded window (default 30 days,
cap 365) seeded at the window edge — never a zero-seed full-history rewrite,
and each historical day resolves to its own as-of effective selection, so
today's new thresholds never backfill history. Revoking the override is not a
derived-data rollback; the executable recovery is revoke → recompute, which
rebuilds the affected rows under the restored selection. The job is
internal-only and part of no pipeline: it runs only when an authorized
operator enqueues it for one target user (three-gate discipline).

## Verification

Real disposable MySQL tests cover policy CAS/default/rollback, version-before-
date selection, nil centers, no/future history, atomic failed publication,
retry and concurrent bundle reads. A Go-owned fixture exports expected JSON;
real mysql2 reads compare Go and TS outputs under default3, active4 and rollback3.
Gin/registry tests compare the same effective ID and source. The controlled
FileStore + MySQL pipeline and read-only preview verify five derived tables
remain unchanged by candidate comparison. Engineering success does not change
release_ready=false or the independent accuracy insufficient result.


## Final review integration verification (2026-11-16)

Real isolated MySQL/FileStore tests now additionally exercise active4 refresh
intent and its original pipeline JSON echoes, explicit opt-in writes to all five
derived tables, and policy3 plus explicit recomputation restoring original v3
outputs. Positive centers come from declared **synthetic** verified protocols via
the existing evidence producer and publication API; ordinary storage job metadata
remains honestly unverified. This does not establish real accuracy or authorise
production activation. The same tests cover two-day canonical RHR readiness,
rest-day provenance/actual seeds/same-ID rewrite/old-writer detection, storage
pause counterevidence and persisted stale HR rejection explanations. See
[final review evidence](../calibration/evidence/final-review/README.md).
The original T8 first score/freeze and then-unsupported stack report remain
historical evidence; they do not claim to cover these later changes.

## Evolved v4 estimation contract (#993 / #995, 2026-11-16)

The v4 algorithm identity evolves in place (no v5). The estimation contract
(joint objective, conditional independence, HR bridge constraint, five-state
labels, runnable research priors, revision marker) is frozen in
[docs/calibration/estimation-contract-v2.md](../calibration/estimation-contract-v2.md)
with evaluation protocol v2 in
[docs/calibration/evaluation-protocol-v2.md](../calibration/evaluation-protocol-v2.md).
Nothing in this ADR changes: policy/bundle/lineage rules above apply unchanged
to revision-marked v4 rows, and the three-gate release discipline (engineering
admission / single-user research trial / full rollout) is documented there.
