# Offline replay evaluation engine (#991 Phase A)

This engine extends the existing `calibration replay` path. It does not change
candidate fitting, effort admission, frozen v3, production policy or storage.
Engineering acceptance and real accuracy acceptance remain separate.

## Seams and reference admission

`Replay` fits the same three strategies on admitted train-only content.
`EvaluateReplayOutcomes` scores sealed results, keyed by strategy identity; it is
also Replay's only scoring seam. Each validation/final × strict/retrospective ×
direct60/race/lab/field cohort is independent. Same-root cases with the same
cutoff are deduplicated per family; conflicting cutoffs/audits are rejected.
A nonempty target must exist, be held out and occur strictly after prediction.
Diagnostic cases without a target remain backward compatible and cannot score.

Direct60 requires a real, independently audited high-quality continuous 3600s
confirmed maximal protocol. Explicitly false continuous verification rejects it;
scenario tags describe coverage and cannot substitute for protocol evidence.
Independent race outcomes require actual positive distance/time, confirmed or
probable maximal support and an independent evidence/protocol reference.
**Race does not require an invented `measurement_quality=high` string**: missing
measurement classification remains visible in the label inventory. It never
upgrades probable to confirmed or feeds a fitting anchor.

Lab references require dated reports, method, instrument and procedure audit.
Candidate lab scoring additionally requires the matching method/target; field
outputs cannot establish lab LTHR accuracy. Field references require a continuous
30min near-maximal chest-strap protocol, fixed last20min window, both full/window
coverage ≥95%, gaps ≤5s, clear independent artifact review and auditable environment.
Available target samples are reintegrated over that fixed window. The candidate
research drift/range/recovery limits are not reference gates. Training HR and
nonmaximal constraints are descriptive quality checks and never scalar labels.

Outcome availability is checked against report time. Training content and its
metadata are separately gated at exact prediction time. Unknown availability is
usable only in retrospective mode; known late content stays excluded in both.
References, outcome audits and all heldout derivatives never enter fitting hashes.

## Prediction, metrics and gates

`PredictOfflineRaceTime` uses only already-fitted Snapshot v60 and identified
Snapshot RiegelK with the declared power-law model, algebraically inverted for a
requested independent distance. Missing k stays missing; ModelKUsed/prior/target
time never fills it. Predicted duration outside 180–7200s is unsupported; actual
outcome time cannot select or trim the prediction domain. Direct60 needs no k.

All eligible roots remain in each strategy's denominator. Mutually exclusive
available/missing_center/unsupported/computation_failures counts sum to eligible;
legacy `missing` is their unavailable sum and must not be added again. Comparison
errors use the same three-way intersection. Race metrics use fractions, with
seconds also reported; HR uses bpm, legacy pace fields keep s/km only.

Each user has equal total weight and their activities share it equally. Absolute
median/P90 use the left empirical weighted quantile; compensated accumulation
preserves exact weighted boundaries with unequal activity counts. Bias is signed.
User-cluster bootstrap uses seed983984, 2000 resamples and sorted-user sampling;
a sampled group copy retains its full 1/U weight, even for repeated users. Sorted
endpoints [49],[1949] form the 95% error-difference interval. Synthetic sources
never produce real-accuracy bootstrap evidence.

Frozen gates report observed values, units, thresholds, eligible/paired counts
and pass/fail/insufficient. Numeric failures take precedence in total status,
while all insufficient blockers stay listed. Default required direct strata are
gps_clean/gps_abnormal, continuous/pause_recovery, quality_sparse/quality_sufficient,
direct distance, and declared target devices; race declares device/distance,
lab method, field device. Unknown metadata cannot pass required coverage. Extra
predeclared strata may be added, never used to remove frozen requirements. The
quality-course classification must come from frozen metadata, not an outcome-
dependent threshold. All reported strata include unavailable predictions.

Coverage≥90% and failure≤1% apply to primary direct60 only. Race/HR report the
same denominators without silently adding these as new numeric gates. Research
parameter limitations remain visible and do not hardcode accuracy to insufficient.
CLI exits are passed→0, failed→1, insufficient→2, after report output. Failure kind
separates computation failure from numeric gate failure; invalid input is an error.

## Immutable evaluation sidecar and engineering evidence

`--evaluation-sidecar PATH` optionally accepts schema1, base_manifest_sha256,
available_at, evidence_ref, rule_version, required_strata and heldout annotations.
Annotations are limited to HR audit/device/scenarios; no train input, outcome
replacement, effort upgrade or model parameter is accepted. The base manifest
hash and fitting input hashes stay unchanged; sidecar and combined evaluation
hashes are separately reported. Unknown fields and multiple JSON values fail.

Engineering evidence is an explicit external index, never inferred from errors,
PR status or active policy. Sidecar engineering fields bind exact code_version,
deterministic/e2e/review passed states and local receipt paths plus SHA256 hashes.
Each receipt is one JSON object with kind (`deterministic`, `e2e`, `review`),
code_version, status (`passed`/`failed`), artifact_ref to actual evidence; the
deterministic receipt additionally carries legacy_pace_delta_s_per_km.
CLI reads local bytes and validates hashes, identities and matching states.
Pure `ReplayWithEvaluationSidecar` leaves unchecked statements unavailable;
`ReplayWithEvaluationEvidence` verifies supplied receipt bytes without I/O.
Receipts index actual test/review evidence and are not rollout authorization.
The implementation code SHA is fixed before scoring; later report/document
commits have their own SHA and do not create a self-referential code-version claim.

No production activation, database write or historical recomputation is performed.
Actual first final run requires a separately reviewed, frozen loader/view mapping,
original base/outcome/split hashes, report time, cutoffs, binary/code/protocol/v3
hashes and an honest final-unseen declaration. Until then this is engineering,
not a completed final accuracy result. #982/#983/#991 remain open; Phase B waits
for authorized merge, deployment and production read-only validation.

## Frozen collection loader (before the first final run)

`calibration replay-collection` is a local wrapper for the existing Replay and
sealed-outcome evaluator. Its frozen schema mirrors the original collector's
`plans-and-independent-outcomes.json.gz`; it has no database/network dependency.
It validates the predeclared inventory SHA256, source commit, root split hash and
case count, then each compressed base/outcome/summary file's original hash.
A collection's completion timestamp must exactly match `--outcome-observed-at`.
This timestamp proves the outcome was observed for the report; it does not create
historical availability. Every case stays event_date_retrospective.

`FrozenRaceReplayView` accepts the original single-case base, unchanged target
user/root/case/event/distance/time/effort, original outcome file SHA256, observed
clock and fixed report time. It verifies prediction cutoff is precisely the prior
Shanghai day's 23:59:59 and rejects train references or target-root inputs.
It creates a new view with a target-only outcome record, not target timeseries,
health, laps or fitting metadata. The original target's probable support remains
probable; measurement quality absent from the frozen race schema is explicitly
`not_recorded`, never invented as high. Direct60/HR thresholds are unchanged.
Original base hashes, outcome hashes, new view hashes and actual fitted input
hashes are all retained. Changing the outcome cannot change the fitted input.

The wrapper writes each new view/report and aggregate into a **new** directory
(0700), files0600 with O_EXCL. Existing files are never overwritten. Stdout contains
only status, counts, hashes and the local output path. The aggregate uses target
records and already fitted per-case results with each exact cutoff/input hash;
it never unions different case histories into a new fit. Synthetic collection
provenance remains synthetic through aggregation and cannot produce accuracy
bootstrap evidence. The fixed statistical/gate reduction is reused verbatim.

Required flags are `--collection-dir`, `--output-dir`, `--code-version`,
`--report-as-of`, `--outcome-observed-at`, `--expected-inventory-sha256`,
`--expected-split-sha256`, `--expected-source-sha`, `--expected-cases`.
Freeze these values, implementation/binary hashes and loader/view rule version
`independent-race-collection-view-v1` before invoking the command on final data.
The synthetic CLI test constructs its own temporary collection and checks base
immutability, retrospective separation, private output and refusal to overwrite.

The initial engineering review at 406da119 found isolated-failure identity,
ambiguous same-root payload, late descriptive-reference clocks, known failed
engineering evidence and nonfinite derived-error handling defects. Follow-up
fixes keep implementation identity separate from allowed numeric failures,
reject conflicting reference-bearing root contents, gate quality references at
report time, preserve known engineering failure and classify nonfinite derived
errors before metrics/JSON. These were synthetic pre-final findings; no final
outcome or accuracy result was used to make these corrections.
