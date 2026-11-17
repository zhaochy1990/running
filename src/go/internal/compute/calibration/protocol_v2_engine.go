package calibration

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"time"

	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

func absFloat64(v float64) float64 { return math.Abs(v) }

// protocol_v2_engine.go is the #1001 frozen-protocol backtest tooling: it
// executes the three frozen comparison identities (v3, historical v4
// candidate, evolved v4 rev2) on a schema-2 manifest with the v1 replay
// cutoff discipline and reduces the protocol v2 gates. It deliberately does
// not reuse the v1 Replay engine: v1 reports stay byte-identical and refuse
// schema 2; this engine refuses schema != 2. No DB, network, wall clock,
// random source (beyond the frozen bootstrap seed) or storage write is used.

// v2Strategies is the frozen comparison trio of protocol v2.
var v2Strategies = []Strategy{StrategyV3, StrategyCandidate, StrategyEvolvedCandidate}

// ReplayV2CaseResult is one sealed per-case outcome: the assembled input
// identity plus the three version results (or their isolated failures).
type ReplayV2CaseResult struct {
	ID                   string              `json:"id"`
	User                 string              `json:"user"`
	Mode                 string              `json:"mode"`
	PredictionAsOf       time.Time           `json:"prediction_as_of"`
	TargetRootActivityID string              `json:"target_root_activity_id,omitempty"`
	InputSHA256          string              `json:"input_sha256"`
	Activities           int                 `json:"activities"`
	IndependentRoots     int                 `json:"independent_roots"`
	Excluded             map[string]int      `json:"excluded"`
	Versions             []OfflineResult     `json:"versions"`
	Failures             map[Strategy]string `json:"failures,omitempty"`
	// PriorFreeEvolved is the evolved rerun without any personal historical
	// prior (population priors only) — the protocol v2 prior-sensitivity run.
	PriorFreeEvolved *OfflineResult `json:"prior_free_evolved,omitempty"`
	// PriorChainApplied reports whether the main evolved run consumed a
	// personal historical prior chained from an earlier case of the same user.
	PriorChainApplied bool `json:"prior_chain_applied,omitempty"`
}

// ReplayV2AllInputs is the engineering coverage denominator: every strict
// case in the manifest regardless of splits, targets or reference labels.
type ReplayV2AllInputs struct {
	Cases            int            `json:"cases"`
	EvolvedCovered   int            `json:"evolved_covered"`
	Coverage         float64        `json:"coverage"`
	UncoveredReasons map[string]int `json:"uncovered_reasons,omitempty"`
}

// ReplayV2VersionMetrics is one strategy's scalar outcome inside a family.
// Missing counts strategy-level nils; Failures counts estimator failures.
type ReplayV2VersionMetrics struct {
	Strategy          Strategy       `json:"strategy"`
	AlgorithmRevision string         `json:"algorithm_revision,omitempty"`
	Available         int            `json:"available"`
	Missing           int            `json:"missing"`
	Failures          int            `json:"failures"`
	FailureRate       float64        `json:"failure_rate"`
	MedianAbsError    *float64       `json:"median_abs_error,omitempty"`
	P90AbsError       *float64       `json:"p90_abs_error,omitempty"`
	SignedBias        *float64       `json:"signed_bias,omitempty"`
	RangeWidthMedian  *float64       `json:"range_width_median,omitempty"`
	RangeCoverage     *float64       `json:"range_coverage,omitempty"`
	Reasons           map[string]int `json:"reasons,omitempty"`
}

// ReplayV2Stratum is one pre-declared protocol v2 stratum bucket.
type ReplayV2Stratum struct {
	Name             string                   `json:"name"`
	Status           string                   `json:"status"`
	Activities       int                      `json:"activities"`
	Users            int                      `json:"users"`
	PairedActivities int                      `json:"paired_activities"`
	PairedUsers      int                      `json:"paired_users"`
	Versions         []ReplayV2VersionMetrics `json:"versions"`
	Gates            []ReplayGate             `json:"gates"`
}

// ReplayV2Family is the per-(split, mode, family) evaluation with the dual
// denominators of protocol v2.
type ReplayV2Family struct {
	Split              string                   `json:"split"`
	Mode               string                   `json:"mode"`
	Family             string                   `json:"family"`
	Unit               string                   `json:"unit"`
	Status             string                   `json:"status"`
	EligibleActivities int                      `json:"eligible_activities"`
	EligibleUsers      int                      `json:"eligible_users"`
	AllInputsCases     int                      `json:"all_inputs_cases"`
	PairedActivities   int                      `json:"paired_activities"` // rev2&v3 both available+referenced
	PairedUsers        int                      `json:"paired_users"`
	MaxUserWeight      float64                  `json:"max_user_weight"`
	RejectedLabels     map[string]int           `json:"rejected_labels"`
	Versions           []ReplayV2VersionMetrics `json:"versions"`
	Strata             []ReplayV2Stratum        `json:"strata"`
	Uncertainty        *ReplayV2Uncertainty     `json:"uncertainty,omitempty"`
	Gates              []ReplayGate             `json:"gates"`

	// lagSeries carries (user, as-of, rev2 signed error) points for the lag
	// proxy; unexported so it never serializes into the report.
	lagSeries []v2LagPoint `json:"-"`
}

// ReplayV2Uncertainty is the frozen bootstrap: user-level resampling, 2000
// draws, seed 993994, paired rev2-minus-v3 absolute error quantile deltas.
type ReplayV2Uncertainty struct {
	Method            string     `json:"method"`
	Seed              int64      `json:"seed"`
	Resamples         int        `json:"resamples"`
	MedianRev2MinusV3 [2]float64 `json:"median_rev2_minus_v3"`
	P90Rev2MinusV3    [2]float64 `json:"p90_rev2_minus_v3"`
}

// ReplayV2TimeStability summarizes walk-forward jump and lag diagnostics.
type ReplayV2TimeStability struct {
	AdjacentPairs      int      `json:"adjacent_pairs"`
	JumpMedianSPerKm   *float64 `json:"jump_median_s_per_km,omitempty"`
	JumpP90SPerKm      *float64 `json:"jump_p90_s_per_km,omitempty"`
	JumpMaxSPerKm      *float64 `json:"jump_max_s_per_km,omitempty"`
	V3JumpMedianSPerKm *float64 `json:"v3_jump_median_s_per_km,omitempty"`
	// LagDiagnostics stays nil unless some user has >=2 referenced strict
	// predictions; it is a descriptive signed-error drift, never a gate.
	LagDiagnostics *ReplayV2LagDiagnostics `json:"lag_diagnostics,omitempty"`
}

// ReplayV2LagDiagnostics is the honest phase-A lag proxy: the mean signed
// error of the later half minus the earlier half per user, averaged.
type ReplayV2LagDiagnostics struct {
	Users       int      `json:"users"`
	DriftSPerKm *float64 `json:"drift_s_per_km,omitempty"`
	Note        string   `json:"note"`
}

// ReplayV2PriorSensitivity summarizes the personal-prior double run.
type ReplayV2PriorSensitivity struct {
	CasesCompared        int      `json:"cases_compared"`
	MedianAbsDeltaSPerKm *float64 `json:"median_abs_delta_s_per_km,omitempty"`
	MaxAbsDeltaSPerKm    *float64 `json:"max_abs_delta_s_per_km,omitempty"`
	StateFlips           int      `json:"state_flips"`
}

// ReplayV2Report is the protocol v2 scoring report. Status semantics follow
// the frozen protocol: passed (exit 0), insufficient (exit 2), failed (exit 1).
type ReplayV2Report struct {
	Status               string                    `json:"status"`
	SchemaVersion        int                       `json:"schema_version"`
	AsOf                 time.Time                 `json:"as_of"`
	CodeVersion          string                    `json:"code_version"`
	SourceVersion        string                    `json:"source_version"`
	ManifestSHA256       string                    `json:"manifest_sha256"`
	ProtocolV2SHA256     string                    `json:"protocol_v2_sha256"`
	V3SourceSHA256       string                    `json:"v3_source_sha256"`
	ContractIdentityHash string                    `json:"contract_identity_hash"`
	PriorsIdentityHash   string                    `json:"priors_identity_hash"`
	Cases                []ReplayV2CaseResult      `json:"cases"`
	AllInputs            ReplayV2AllInputs         `json:"all_inputs"`
	Families             []ReplayV2Family          `json:"families,omitempty"`
	KnownRegression      []ReplayV2Family          `json:"known_regression,omitempty"`
	TimeStability        *ReplayV2TimeStability    `json:"time_stability,omitempty"`
	PriorSensitivity     *ReplayV2PriorSensitivity `json:"prior_sensitivity,omitempty"`
	Gates                []ReplayGate              `json:"gates"`
	Reasons              []string                  `json:"reasons"`
	FailureKind          string                    `json:"failure_kind,omitempty"`
}

// ReplayV2 validates and scores a schema-2 manifest under protocol v2.
func ReplayV2(m ReplayManifest, codeVersion string) (ReplayV2Report, error) {
	if codeVersion == "" {
		return ReplayV2Report{}, fmt.Errorf("replay v2 requires code_version provenance")
	}
	if err := ValidateReplayManifestV2(m); err != nil {
		return ReplayV2Report{}, err
	}
	out := ReplayV2Report{
		Status:               "insufficient",
		SchemaVersion:        2,
		AsOf:                 m.AsOf,
		CodeVersion:          codeVersion,
		SourceVersion:        m.SourceVersion,
		ManifestSHA256:       ReplayContentHash(m),
		ProtocolV2SHA256:     EvaluationProtocolV2SHA256(),
		V3SourceSHA256:       FrozenV3SourceSHA256(),
		ContractIdentityHash: EstimationContractDocumentSnapshot().IdentityHash(),
		PriorsIdentityHash:   DefaultEvolvedPriors().IdentityHash(),
	}
	activities := append([]ReplayActivity(nil), m.Activities...)
	sort.Slice(activities, func(i, j int) bool { return activities[i].ID < activities[j].ID })
	health := append([]ReplayHealth(nil), m.Health...)
	sort.Slice(health, func(i, j int) bool { return health[i].ID < health[j].ID })
	sortedCases := append([]ReplayCase(nil), m.Cases...)
	sort.Slice(sortedCases, func(i, j int) bool { return sortedCases[i].ID < sortedCases[j].ID })

	// Walk-forward prior chain per user: cases ordered by prediction_as_of so
	// the evolved run consumes the previous same-user snapshot as the aged
	// personal historical prior, mirroring the production refresh semantics.
	ordered := append([]ReplayCase(nil), sortedCases...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].PredictionAsOf.Before(ordered[j].PredictionAsOf) })
	priorByUser := map[string]*HistoricalCapabilityPrior{}

	for _, c := range ordered {
		result := ReplayV2CaseResult{ID: c.ID, User: c.User, Mode: c.Mode, PredictionAsOf: c.PredictionAsOf, TargetRootActivityID: c.TargetRootActivityID, Excluded: map[string]int{}}
		var history []Activity
		var inputMetadata []CandidateMetadata
		var rows []HealthRow
		var usedActivities []ReplayActivity
		var usedHealth []ReplayHealth
		roots := map[string]bool{}
		for _, a := range activities {
			if a.User != c.User {
				continue
			}
			// known_regression samples were seen by the v4 v1 phase; they are
			// never fitting inputs, only a separate regression column.
			switch {
			case a.Split != "train" || a.RootActivityID == c.TargetRootActivityID:
				result.Excluded["heldout_or_validation_or_regression"]++
			case !available(a.EventTime, a.AvailableAt, a.AvailabilityEvidence, c.PredictionAsOf, c.Mode):
				result.Excluded["future_or_unavailable"]++
			default:
				history = append(history, a.Activity)
				if a.InputEvidence != nil && !available(a.EventTime, a.InputEvidence.AvailableAt, a.InputEvidence.AvailabilityEvidence, c.PredictionAsOf, c.Mode) {
					a.InputEvidence = nil
					result.Excluded["metadata_future_or_unavailable"]++
				}
				meta := CandidateMetadata{ActivityID: a.Activity.LabelID, RootActivityID: a.RootActivityID, SourceVersion: "replay-root-v1", Device: a.Device}
				if a.InputEvidence != nil {
					meta = *a.InputEvidence
					meta.RootActivityID = a.RootActivityID
					if meta.Device == "" {
						meta.Device = a.Device
					}
				}
				inputMetadata = append(inputMetadata, meta)
				// Reference labels never enter the fitting payload or input hash.
				a.Reference = nil
				usedActivities = append(usedActivities, a)
				roots[a.RootActivityID] = true
			}
		}
		for _, h := range health {
			if h.User != c.User {
				continue
			}
			if !available(h.EventTime, h.AvailableAt, h.AvailabilityEvidence, c.PredictionAsOf, c.Mode) {
				result.Excluded["health_future_or_unavailable"]++
				continue
			}
			rows = append(rows, h.Row)
			usedHealth = append(usedHealth, h)
		}
		result.Activities = len(history)
		result.IndependentRoots = len(roots)
		result.InputSHA256 = ReplayContentHash(struct {
			Activities []ReplayActivity
			Health     []ReplayHealth
			AsOf       time.Time
		}{usedActivities, usedHealth, c.PredictionAsOf})
		civilDay := timefmt.ShanghaiDay(c.PredictionAsOf)

		record := func(strategy Strategy, run func() (OfflineResult, error)) (*OfflineResult, string) {
			v, err := run()
			if err != nil {
				return nil, "offline_estimator_error"
			}
			if ReplayContentHash(v) == "" {
				return nil, "nonfinite_estimator_output"
			}
			return &v, ""
		}
		for _, strategy := range v2Strategies {
			prior := priorByUser[c.User]
			v, failure := record(strategy, func() (OfflineResult, error) {
				if strategy == StrategyEvolvedCandidate {
					// Review P0-2: the walk-forward personal historical prior is
					// actually consumed here (production refresh semantics — the
					// same entry shape as EstimateEvolvedOffline), not merely
					// flagged. The prior-free rerun below stays on nil so the
					// protocol's double run is a real comparison.
					snapshot, evidence, evolved := estimateEvolvedCandidate(history, civilDay, rows, inputMetadata, c.PredictionAsOf, prior)
					implementation, parameterVersion, revision := EvolvedCandidateIdentity()
					return OfflineResult{Strategy: strategy, Implementation: implementation, ParameterVersion: parameterVersion, AlgorithmRevision: revision, Snapshot: snapshot, Evidence: &evidence, Evolved: evolved}, nil
				}
				return estimateOfflineWithEvidenceAt(strategy, history, civilDay, rows, inputMetadata, c.PredictionAsOf)
			})
			if failure != "" {
				if result.Failures == nil {
					result.Failures = map[Strategy]string{}
				}
				result.Failures[strategy] = failure
				continue
			}
			if strategy == StrategyEvolvedCandidate {
				// Main evolved run consumes the walk-forward personal prior
				// (production refresh semantics); the prior-free rerun is the
				// frozen prior-sensitivity comparison.
				result.PriorChainApplied = priorByUser[c.User] != nil
				priorFree, freeFailure := record(strategy, func() (OfflineResult, error) {
					snapshot, evidence, evolved := estimateEvolvedCandidate(history, civilDay, rows, inputMetadata, c.PredictionAsOf, nil)
					implementation, parameterVersion, revision := EvolvedCandidateIdentity()
					return OfflineResult{Strategy: strategy, Implementation: implementation, ParameterVersion: parameterVersion, AlgorithmRevision: revision, Snapshot: snapshot, Evidence: &evidence, Evolved: evolved}, nil
				})
				if freeFailure != "" {
					if result.Failures == nil {
						result.Failures = map[Strategy]string{}
					}
					result.Failures[strategy] = freeFailure
					continue
				}
				result.PriorFreeEvolved = priorFree
			}
			result.Versions = append(result.Versions, *v)
		}
		// Advance the per-user prior chain with the main evolved center.
		for _, v := range result.Versions {
			if v.Strategy != StrategyEvolvedCandidate || v.Snapshot.ThresholdSpeedMps == nil || !candidateFinite(v.Snapshot.ThresholdSpeedMps) {
				continue
			}
			priorByUser[c.User] = &HistoricalCapabilityPrior{
				V60Mps:           *v.Snapshot.ThresholdSpeedMps,
				AgeDays:          0,
				AsOfDate:         c.PredictionAsOf,
				InputFingerprint: v.Evolved.Speed.InputIdentityHash,
			}
		}
		out.Cases = append(out.Cases, result)
	}
	// Restore the manifest's own case order for the sealed report.
	sort.Slice(out.Cases, func(i, j int) bool { return out.Cases[i].ID < out.Cases[j].ID })

	// Family scoring with the dual denominators and the frozen v2 gates.
	out.Families, out.KnownRegression = v2EvaluateFamilies(m, out.Cases)
	out.TimeStability = v2TimeStability(out.Cases)
	out.PriorSensitivity = v2PriorSensitivity(out.Cases)
	if out.TimeStability != nil {
		for i := range out.Families {
			f := &out.Families[i]
			if f.Split == "final_holdout" && f.Mode == "strict" && f.Family == "direct_60min" {
				out.TimeStability.LagDiagnostics = v2LagDiagnostics(f.lagSeries)
			}
		}
	}
	for _, f := range out.Families {
		if f.Split == "final_holdout" && f.Mode == "strict" {
			out.Gates = append(out.Gates, f.Gates...)
		}
	}

	// Engineering all-inputs coverage: every strict case with at least one
	// admitted running input (windows with no running input at all are
	// legitimately unavailable-with-reason and stay outside the denominator;
	// windows with hard inputs but no usable series stay inside it).
	all := ReplayV2AllInputs{UncoveredReasons: map[string]int{}}
	for _, c := range out.Cases {
		if c.Mode != "strict" || c.Activities == 0 {
			continue
		}
		all.Cases++
		if v2EvolvedCovers(c) {
			all.EvolvedCovered++
		} else if c.Failures[StrategyEvolvedCandidate] != "" {
			all.UncoveredReasons[c.Failures[StrategyEvolvedCandidate]]++
		} else {
			all.UncoveredReasons["no_finite_physical_ranged_estimate"]++
		}
	}
	if all.Cases > 0 {
		all.Coverage = float64(all.EvolvedCovered) / float64(all.Cases)
	}
	out.AllInputs = all

	// Frozen provenance gate: synthetic sources never establish accuracy.
	if syntheticReplay(m) {
		out.Gates = append(out.Gates, ReplayGate{ID: "real_reference_provenance", Status: "insufficient", Threshold: "independent real references", Reason: "synthetic_source_cannot_establish_accuracy", Unit: "evidence"})
	}
	// Frozen engineering gates on the all-inputs denominator (evolved rev2).
	if out.AllInputs.Cases > 0 {
		out.Gates = append(out.Gates, ReplayGate{ID: "all_inputs_coverage", Status: v2ThresholdStatus(out.AllInputs.Coverage, v2AllInputsCoverageMin, true), Observed: out.AllInputs.Coverage, Threshold: ">= 0.90 finite+physical+ranged on all strict cases", Unit: "fraction"})
	} else {
		out.Gates = append(out.Gates, ReplayGate{ID: "all_inputs_coverage", Status: "insufficient", Threshold: ">= 0.90 finite+physical+ranged on all strict cases", Reason: "no_strict_cases", Unit: "fraction"})
	}
	out.Status = v2GateReduction(out.Gates)
	if out.Status == "failed" {
		out.FailureKind = "numeric_gate_failed"
		for _, c := range out.Cases {
			if len(c.Failures) > 0 {
				out.FailureKind = "computation_failed"
				break
			}
		}
	}
	out.Reasons = []string{"protocol_v2_scoring_engine", "evolved_priors_research_uncalibrated"}
	return out, nil
}

// Frozen protocol v2 numeric thresholds (evaluation-protocol-v2.md). Any
// change here requires a new protocol version, never a silent edit.
const (
	v2PaceMedianMaxSPerKm     = 15.0 // final strict direct_60min, rev2
	v2PaceP90MaxSPerKm        = 30.0
	v2NonInferiorMedianSPerKm = 1.0 // rev2 median <= v3 median + 1
	v2NonInferiorP90SPerKm    = 2.0 // rev2 P90 <= v3 P90 + 2
	v2HRMedianMaxBpm          = 5.0 // lab_lthr / field_hr_proxy, rev2
	v2HRP90MaxBpm             = 10.0
	v2FailureRateMax          = 0.01
	v2AllInputsCoverageMin    = 0.90
	v2MinActivities           = 30 // >=30 independent real activities
	v2MinUsers                = 10 // >=10 users, per-user weight <= 20%
	v2MaxUserWeight           = 0.20
	v2StratumMinActivities    = 10
	v2StratumMinUsers         = 3
	v2StratumMedianDegradeS   = 1.0
	v2StratumP90DegradeS      = 2.0
	v2BootstrapSeed           = 993994
	v2BootstrapResamples      = 2000
	v2SpeedEligibleMinRoots   = 3 // frozen eligible rule, speed families
)

func v2ThresholdStatus(observed, threshold float64, atLeast bool) string {
	if atLeast && observed >= threshold {
		return "pass"
	}
	if !atLeast && observed <= threshold {
		return "pass"
	}
	return "fail"
}

// v2EvaluateFamilies scores every (split, mode, family) cell plus the
// known_regression single column (descriptive, never gated).
func v2EvaluateFamilies(m ReplayManifest, cases []ReplayV2CaseResult) (families []ReplayV2Family, knownRegression []ReplayV2Family) {
	targets := map[string]ReplayActivity{}
	for _, a := range m.Activities {
		if a.Reference != nil {
			targets[a.User+"/"+a.RootActivityID] = a
		}
	}
	caseByID := map[string]ReplayV2CaseResult{}
	for _, c := range cases {
		caseByID[c.ID] = c
	}
	for _, split := range []string{"validation", "final_holdout"} {
		for _, mode := range []string{"strict", "event_date_retrospective"} {
			for _, family := range []string{"direct_60min", "race_prediction", "lab_lthr", "field_hr_proxy"} {
				f := v2ScoreFamily(m, targets, caseByID, split, mode, family)
				if f != nil {
					families = append(families, *f)
				}
			}
		}
	}
	// known_regression: v4-v1-used samples, single descriptive column, no gates.
	for _, mode := range []string{"strict", "event_date_retrospective"} {
		for _, family := range []string{"direct_60min", "race_prediction", "lab_lthr", "field_hr_proxy"} {
			f := v2ScoreKnownRegression(m, targets, caseByID, mode, family)
			if f != nil {
				knownRegression = append(knownRegression, *f)
			}
		}
	}
	return families, knownRegression
}

// v2Eligible applies the frozen eligible rules: speed families need >=3
// admitted independent running roots in the window; HR families need a valid
// HR series or a qualified physiological prior.
func v2Eligible(family string, c ReplayV2CaseResult, history []Activity, rows []HealthRow, asOf time.Time) bool {
	switch family {
	case "direct_60min", "race_prediction":
		return c.IndependentRoots >= v2SpeedEligibleMinRoots
	case "lab_lthr", "field_hr_proxy":
		if v2HasHRSeries(history) {
			return true
		}
		return evolvedRestingHRPrior(rows, asOf) != nil
	}
	return false
}

func v2HasHRSeries(history []Activity) bool {
	for _, a := range history {
		count := 0
		for _, s := range a.Samples {
			if s.HeartRateBpm != nil && candidateFinite(s.HeartRateBpm) && *s.HeartRateBpm > 0 {
				count++
				if count >= 2 {
					return true
				}
			}
		}
	}
	return false
}

// v2CaseHistory rebuilds the admitted history for eligibility facts without
// rerunning estimators: same train-split + cutoff filter as assembly.
func v2CaseHistory(m ReplayManifest, c ReplayV2CaseResult) ([]Activity, []HealthRow) {
	var history []Activity
	var rows []HealthRow
	for _, a := range m.Activities {
		if a.User != c.User || a.Split != "train" || a.RootActivityID == c.TargetRootActivityID {
			continue
		}
		if !available(a.EventTime, a.AvailableAt, a.AvailabilityEvidence, c.PredictionAsOf, c.Mode) {
			continue
		}
		history = append(history, a.Activity)
	}
	for _, h := range m.Health {
		if h.User != c.User {
			continue
		}
		if !available(h.EventTime, h.AvailableAt, h.AvailabilityEvidence, c.PredictionAsOf, c.Mode) {
			continue
		}
		rows = append(rows, h.Row)
	}
	return history, rows
}

// v2ScalarOutcome extracts the strategy's family-space prediction: pace
// s/km for direct_60min, seconds for race_prediction, bpm for HR families.
// It returns (value, state, reason) with state available/missing/failed.
func v2ScalarOutcome(v OfflineResult, family string, r *ReplayReference) (float64, string, string) {
	var center *float64
	switch family {
	case "direct_60min":
		center = v.Snapshot.ThresholdSpeedMps
	case "race_prediction":
		prediction := PredictOfflineRaceTime(v.Snapshot, r.DistanceM)
		if prediction.DurationS == nil {
			return 0, "missing", "race_prediction_unavailable"
		}
		if !finiteScalar(*prediction.DurationS) || *prediction.DurationS <= 0 {
			return 0, "failed", "nonfinite_race_prediction"
		}
		return *prediction.DurationS, "available", ""
	case "lab_lthr", "field_hr_proxy":
		center = v.Snapshot.ThresholdHR
	}
	if center == nil {
		return 0, "missing", "snapshot_center_missing"
	}
	if !candidateFinite(center) || *center <= 0 {
		return 0, "failed", "invalid_snapshot_center"
	}
	value := *center
	if family == "direct_60min" {
		value = 1000 / value
	}
	if !finiteScalar(value) {
		return 0, "failed", "nonfinite_prediction"
	}
	return value, "available", ""
}

// v2RangeFor returns the evolved report's family-space [low, high] when the
// strategy carries one (only the evolved revision publishes ranges).
func v2RangeFor(v OfflineResult, family string) (low, high float64, ok bool) {
	if v.Strategy != StrategyEvolvedCandidate || v.Evolved == nil {
		return 0, 0, false
	}
	switch family {
	case "direct_60min":
		if v.Evolved.Speed == nil || v.Evolved.Speed.RangeLowMps == nil || v.Evolved.Speed.RangeHighMps == nil {
			return 0, 0, false
		}
		// Speed range to pace space: order flips.
		return 1000 / *v.Evolved.Speed.RangeHighMps, 1000 / *v.Evolved.Speed.RangeLowMps, true
	case "lab_lthr", "field_hr_proxy":
		if v.Evolved.HR == nil || v.Evolved.HR.RangeLowBpm == nil || v.Evolved.HR.RangeHighBpm == nil {
			return 0, 0, false
		}
		return *v.Evolved.HR.RangeLowBpm, *v.Evolved.HR.RangeHighBpm, true
	}
	return 0, 0, false
}

type v2Observation struct {
	user    string
	asOf    time.Time
	errors  map[Strategy]float64
	states  map[Strategy]string
	widths  map[Strategy]float64
	inRange map[Strategy]bool
	strata  []string
}

// v2ScoreFamily scores one (split, mode, family) cell over case targets.
func v2ScoreFamily(m ReplayManifest, targets map[string]ReplayActivity, caseByID map[string]ReplayV2CaseResult, split, mode, family string) *ReplayV2Family {
	f := &ReplayV2Family{Split: split, Mode: mode, Family: family, Unit: v2FamilyUnit(family), RejectedLabels: map[string]int{}}
	var observations []v2Observation
	seen := map[string]bool{}
	// Deterministic observation order (review P0-1): map iteration is random,
	// and observation order flows into the floating-point bias aggregation.
	for _, c := range v2CasesInScoredOrder(caseByID) {
		if c.Mode != mode || c.TargetRootActivityID == "" {
			continue
		}
		f.AllInputsCases++
		key := c.User + "/" + c.TargetRootActivityID
		a, ok := targets[key]
		if !ok {
			f.RejectedLabels["target_reference_missing"]++
			continue
		}
		if a.Split != split {
			f.AllInputsCases--
			continue
		}
		if seen[key] {
			f.RejectedLabels["duplicate_case_deduplicated"]++
			continue
		}
		seen[key] = true
		r := a.Reference
		if r.Kind != family && r.HRGrade != family {
			f.AllInputsCases--
			continue
		}
		history, rows := v2CaseHistory(m, c)
		if !v2Eligible(family, c, history, rows, c.PredictionAsOf) {
			f.RejectedLabels["window_below_frozen_eligibility"]++
			continue
		}
		observed, rejection := referenceValue(a, ReplayCaseResult{PredictionAsOf: c.PredictionAsOf}, m, family)
		if rejection != "" {
			f.RejectedLabels[rejection]++
			continue
		}
		f.EligibleActivities++
		observation := v2Observation{user: c.User, asOf: c.PredictionAsOf, errors: map[Strategy]float64{}, states: map[Strategy]string{}, widths: map[Strategy]float64{}, inRange: map[Strategy]bool{}}
		for _, v := range c.Versions {
			value, state, reason := v2ScalarOutcome(v, family, r)
			observation.states[v.Strategy] = state
			if state == "available" {
				observation.errors[v.Strategy] = value - observed
				if low, high, ok := v2RangeFor(v, family); ok {
					observation.widths[v.Strategy] = high - low
					observation.inRange[v.Strategy] = low <= observed+1e-9 && observed <= high+1e-9
				}
			} else if reason != "" {
				f.RejectedLabels["strategy_"+string(v.Strategy)+"_"+reason]++
			}
		}
		if c.Failures != nil {
			for strategy := range c.Failures {
				observation.states[strategy] = "failed"
			}
		}
		observation.strata = v2Strata(a)
		observations = append(observations, observation)
	}
	v2ReduceFamily(f, observations, family, split, mode, m)
	return f
}

// v2ScoreKnownRegression evaluates the v4-v1-used sample set as a single
// descriptive column: predictions at cutoffs before those samples, references
// compared for regression watching only, never a gate.
func v2ScoreKnownRegression(m ReplayManifest, targets map[string]ReplayActivity, caseByID map[string]ReplayV2CaseResult, mode, family string) *ReplayV2Family {
	f := &ReplayV2Family{Split: "known_regression", Mode: mode, Family: family, Unit: v2FamilyUnit(family), RejectedLabels: map[string]int{}, Status: "reported"}
	var observations []v2Observation
	seen := map[string]bool{}
	// Deterministic order here too (review P0-1).
	for _, c := range v2CasesInScoredOrder(caseByID) {
		if c.Mode != mode {
			continue
		}
		for _, a := range m.Activities {
			if a.User != c.User || a.Split != "known_regression" || a.Reference == nil {
				continue
			}
			if a.Reference.Kind != family && a.Reference.HRGrade != family {
				continue
			}
			key := c.User + "/" + a.RootActivityID + "/" + c.ID
			if seen[key] {
				continue
			}
			seen[key] = true
			if !a.EventTime.After(c.PredictionAsOf) || a.EventTime.After(m.AsOf) {
				f.RejectedLabels["regression_sample_not_after_cutoff"]++
				continue
			}
			observed, rejection := referenceValue(a, ReplayCaseResult{PredictionAsOf: c.PredictionAsOf}, m, family)
			if rejection != "" {
				f.RejectedLabels[rejection]++
				continue
			}
			f.EligibleActivities++
			observation := v2Observation{user: c.User, asOf: c.PredictionAsOf, errors: map[Strategy]float64{}, states: map[Strategy]string{}, widths: map[Strategy]float64{}, inRange: map[Strategy]bool{}}
			for _, v := range c.Versions {
				value, state, _ := v2ScalarOutcome(v, family, a.Reference)
				observation.states[v.Strategy] = state
				if state == "available" {
					observation.errors[v.Strategy] = value - observed
					if low, high, ok := v2RangeFor(v, family); ok {
						observation.widths[v.Strategy] = high - low
						observation.inRange[v.Strategy] = low <= observed+1e-9 && observed <= high+1e-9
					}
				}
			}
			observation.strata = v2Strata(a)
			observations = append(observations, observation)
		}
	}
	if f.EligibleActivities == 0 {
		return nil
	}
	v2ReduceFamily(f, observations, family, "known_regression", mode, m)
	f.Gates = nil
	f.Status = "reported"
	return f
}

// v2CasesInScoredOrder returns the sealed case results in the deterministic
// scored order (user, then case ID) so observation aggregation never depends
// on Go map iteration (review P0-1).
func v2CasesInScoredOrder(caseByID map[string]ReplayV2CaseResult) []ReplayV2CaseResult {
	out := make([]ReplayV2CaseResult, 0, len(caseByID))
	for _, c := range caseByID {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].User != out[j].User {
			return out[i].User < out[j].User
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func v2FamilyUnit(family string) string {
	switch family {
	case "direct_60min":
		return "s/km"
	case "race_prediction":
		return "s"
	case "lab_lthr", "field_hr_proxy":
		return "bpm"
	}
	return ""
}

// v2Strata returns the five pre-declared protocol v2 stratum axes for a
// target: device vendor, GPS quality, continuity, all-out label presence and
// duration class.
func v2Strata(a ReplayActivity) []string {
	device := a.Device
	if device == "" {
		device = "unknown"
	}
	names := map[string]string{"device": "device:" + device}
	gps := "gps:unknown"
	continuity := "continuity:unknown"
	for _, s := range a.Scenarios {
		switch s {
		case "gps_clean", "gps_abnormal":
			gps = s
		case "continuous", "pause_recovery":
			continuity = s
		}
	}
	names["gps"] = gps
	names["continuity"] = continuity
	label := "label:all_out_absent"
	if a.Reference != nil && (a.Reference.EffortSupport == "confirmed_maximal" || a.Reference.EffortSupport == "probable_maximal") {
		label = "label:all_out_present"
	}
	names["label"] = label
	duration := "duration:unclassified"
	if a.Activity.DurationS != nil && candidateFinite(a.Activity.DurationS) {
		d := *a.Activity.DurationS
		switch {
		case d < 3600:
			duration = "duration:below_3600s"
		case d >= 2880 && d <= 4320:
			duration = "duration:hour_3600s_pm20pct"
		case d > 7200:
			duration = "duration:above_7200s"
		}
	}
	names["duration"] = duration
	out := make([]string, 0, len(names))
	for _, axis := range []string{"device", "gps", "continuity", "label", "duration"} {
		out = append(out, names[axis])
	}
	return out
}

// v2ReduceFamily computes the per-strategy metrics, strata, uncertainty and
// gates for one family cell from its sealed observations.
func v2ReduceFamily(f *ReplayV2Family, observations []v2Observation, family, split, mode string, m ReplayManifest) {
	users := map[string]bool{}
	for _, o := range observations {
		users[o.user] = true
	}
	f.EligibleUsers = len(users)
	counts := map[string]int{}
	for _, o := range observations {
		counts[o.user]++
	}
	userWeight := func(user string) float64 { return 1 / float64(len(users)*counts[user]) }
	if len(users) > 0 {
		f.MaxUserWeight = 1 / float64(len(users))
	}

	type strategyAccumulator struct {
		errors         [][2]float64 // (abs error, weight)
		biasSum        float64
		biasCorrection float64
		widths         []float64
		inRange        int
		ranged         int
	}
	accum := map[Strategy]*strategyAccumulator{}
	for _, s := range v2Strategies {
		accum[s] = &strategyAccumulator{}
	}
	pairedCount := 0
	pairedUsers := map[string]bool{}
	for _, o := range observations {
		for s, state := range o.states {
			a := accum[s]
			if state != "available" {
				continue
			}
			w := userWeight(o.user)
			a.errors = append(a.errors, [2]float64{absFloat64(o.errors[s]), w})
			// Compensated (Kahan) accumulation: naive order-sensitive sums leak
			// ulps into SignedBias (review P0-1), breaking byte determinism.
			addCompensated(&a.biasSum, &a.biasCorrection, o.errors[s]*w)
			if w, ok := o.widths[s]; ok {
				a.widths = append(a.widths, w)
				a.ranged++
				if o.inRange[s] {
					a.inRange++
				}
			}
		}
		if o.states[StrategyEvolvedCandidate] == "available" && o.states[StrategyV3] == "available" {
			pairedCount++
			pairedUsers[o.user] = true
		}
	}
	f.PairedActivities = pairedCount
	f.PairedUsers = len(pairedUsers)

	for _, s := range v2Strategies {
		a := accum[s]
		metric := ReplayV2VersionMetrics{Strategy: s}
		if s == StrategyEvolvedCandidate {
			metric.AlgorithmRevision = EvolvedCandidateAlgorithmRevision
		}
		for _, o := range observations {
			switch o.states[s] {
			case "available":
				metric.Available++
			case "missing":
				metric.Missing++
			case "failed":
				metric.Failures++
			}
		}
		if f.EligibleActivities > 0 {
			metric.FailureRate = float64(metric.Failures) / float64(f.EligibleActivities)
		}
		if len(a.errors) > 0 {
			median := errorQuantile(a.errors, 0.5)
			p90 := errorQuantile(a.errors, 0.9)
			bias := a.biasSum
			metric.MedianAbsError = &median
			metric.P90AbsError = &p90
			metric.SignedBias = &bias
		}
		if len(a.widths) > 0 {
			sort.Float64s(a.widths)
			width := a.widths[len(a.widths)/2]
			metric.RangeWidthMedian = &width
			coverage := float64(a.inRange) / float64(a.ranged)
			metric.RangeCoverage = &coverage
		}
		f.Versions = append(f.Versions, metric)
	}

	// Strata: bucket per pre-declared axis value.
	strataObs := map[string][]v2Observation{}
	for _, o := range observations {
		for _, name := range o.strata {
			strataObs[name] = append(strataObs[name], o)
		}
	}
	names := make([]string, 0, len(strataObs))
	for name := range strataObs {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		sub := ReplayV2Stratum{Name: name}
		subF := &ReplayV2Family{RejectedLabels: map[string]int{}}
		v2ReduceMetricsOnly(subF, strataObs[name])
		sub.Activities = subF.EligibleActivities
		sub.Users = subF.EligibleUsers
		sub.PairedActivities = subF.PairedActivities
		sub.PairedUsers = subF.PairedUsers
		sub.Versions = subF.Versions
		state := "insufficient"
		if sub.PairedActivities >= v2StratumMinActivities && sub.PairedUsers >= v2StratumMinUsers {
			state = "pass"
		}
		sub.Gates = append(sub.Gates, ReplayGate{ID: "strata." + name + ".sample", Status: state, Observed: []int{sub.Activities, sub.Users, sub.PairedActivities, sub.PairedUsers}, Threshold: ">=10 paired activities/3 users", Unit: "count", EligibleActivities: sub.Activities, EligibleUsers: sub.Users, PairedActivities: sub.PairedActivities, PairedUsers: sub.PairedUsers})
		if family == "direct_60min" && state == "pass" {
			sub.Gates = append(sub.Gates, v2DegradationGate("strata."+name+".regression", sub.Versions))
		}
		sub.Status = gateReduction(sub.Gates)
		f.Strata = append(f.Strata, sub)
	}

	// Lag proxy (review P1-2): users with >=2 referenced strict direct_60min
	// predictions contribute a half-window signed-drift estimate; the series
	// rides on the family until ReplayV2 lifts it into TimeStability.
	if split == "final_holdout" && mode == "strict" && family == "direct_60min" {
		f.lagSeries = v2LagSeries(observations)
	}
	// Gates exist only for the strict final_holdout accuracy families.
	if split == "final_holdout" && mode == "strict" {
		sample := v2SampleGate(f)
		f.Gates = append(f.Gates, sample)
		real := !syntheticReplay(m)
		switch family {
		case "direct_60min":
			f.Gates = append(f.Gates, v2PaceGates(f, real)...)
		case "lab_lthr", "field_hr_proxy":
			f.Gates = append(f.Gates, v2HRGates(f, family, real)...)
		}
		if real && f.PairedUsers >= 2 {
			f.Uncertainty = v2Bootstrap(observations)
		}
	}
	f.Status = gateReduction(f.Gates)
	if len(f.Gates) == 0 {
		f.Status = "insufficient"
	}
}

// v2ReduceMetricsOnly recomputes per-strategy metrics for a subset without
// gates or strata (used inside stratum buckets).
func v2ReduceMetricsOnly(f *ReplayV2Family, observations []v2Observation) {
	users := map[string]bool{}
	for _, o := range observations {
		users[o.user] = true
	}
	f.EligibleActivities = len(observations)
	f.EligibleUsers = len(users)
	counts := map[string]int{}
	for _, o := range observations {
		counts[o.user]++
	}
	userWeight := func(user string) float64 { return 1 / float64(len(users)*counts[user]) }
	type acc struct {
		errors         [][2]float64
		biasSum        float64
		biasCorrection float64
		widths         []float64
		inRange        int
		ranged         int
	}
	accum := map[Strategy]*acc{}
	for _, s := range v2Strategies {
		accum[s] = &acc{}
	}
	pairedUsers := map[string]bool{}
	pairedCount := 0
	for _, o := range observations {
		for s, state := range o.states {
			if state != "available" {
				continue
			}
			a := accum[s]
			w := userWeight(o.user)
			a.errors = append(a.errors, [2]float64{absFloat64(o.errors[s]), w})
			// Compensated (Kahan) accumulation: naive order-sensitive sums leak
			// ulps into SignedBias (review P0-1), breaking byte determinism.
			addCompensated(&a.biasSum, &a.biasCorrection, o.errors[s]*w)
			if w, ok := o.widths[s]; ok {
				a.widths = append(a.widths, w)
				a.ranged++
				if o.inRange[s] {
					a.inRange++
				}
			}
		}
		if o.states[StrategyEvolvedCandidate] == "available" && o.states[StrategyV3] == "available" {
			pairedCount++
			pairedUsers[o.user] = true
		}
	}
	f.PairedActivities = pairedCount
	f.PairedUsers = len(pairedUsers)
	for _, s := range v2Strategies {
		a := accum[s]
		metric := ReplayV2VersionMetrics{Strategy: s}
		if s == StrategyEvolvedCandidate {
			metric.AlgorithmRevision = EvolvedCandidateAlgorithmRevision
		}
		for _, o := range observations {
			switch o.states[s] {
			case "available":
				metric.Available++
			case "missing":
				metric.Missing++
			case "failed":
				metric.Failures++
			}
		}
		if len(a.errors) > 0 {
			median := errorQuantile(a.errors, 0.5)
			p90 := errorQuantile(a.errors, 0.9)
			bias := a.biasSum
			metric.MedianAbsError = &median
			metric.P90AbsError = &p90
			metric.SignedBias = &bias
		}
		if len(a.widths) > 0 {
			sort.Float64s(a.widths)
			width := a.widths[len(a.widths)/2]
			metric.RangeWidthMedian = &width
			coverage := float64(a.inRange) / float64(a.ranged)
			metric.RangeCoverage = &coverage
		}
		f.Versions = append(f.Versions, metric)
	}
}

func v2SampleGate(f *ReplayV2Family) ReplayGate {
	status := "insufficient"
	if f.EligibleActivities >= v2MinActivities && f.EligibleUsers >= v2MinUsers && f.MaxUserWeight <= v2MaxUserWeight+1e-12 {
		status = "pass"
	}
	return ReplayGate{ID: v2GatePrefix(f) + ".sample", Status: status, Observed: []int{f.EligibleActivities, f.EligibleUsers}, Threshold: ">=30 independent real activities/>=10 users/per-user weight <=20%", Unit: "count", EligibleActivities: f.EligibleActivities, EligibleUsers: f.EligibleUsers, PairedActivities: f.PairedActivities, PairedUsers: f.PairedUsers}
}

func v2PaceGates(f *ReplayV2Family, real bool) []ReplayGate {
	prefix := v2GatePrefix(f)
	rev2 := v2Metrics(f, StrategyEvolvedCandidate)
	v3 := v2Metrics(f, StrategyV3)
	gates := []ReplayGate{}
	// Review P1-1: the protocol's frozen "计算失败率 <= 1%" is machine-reduced
	// here on the rev2 strategy (real references gate the scoring, matching
	// the pace gates; v2FailureRateMax is constant-locked).
	failureStatus := "insufficient"
	failureReason := ""
	if !real {
		failureReason = "synthetic_source_not_scored"
	} else if f.EligibleActivities == 0 {
		failureReason = "no_eligible_activities"
	} else {
		failureStatus = v2ThresholdStatus(rev2FailureRate(f), v2FailureRateMax, false)
	}
	gates = append(gates, ReplayGate{ID: prefix + ".failure_rate", Status: failureStatus, Reason: failureReason, Observed: rev2FailureRate(f), Threshold: "<= 0.01 computation failures per eligible activity", Unit: "fraction"})
	if rev2 == nil || rev2.MedianAbsError == nil || rev2.P90AbsError == nil {
		return append(gates, ReplayGate{ID: prefix + ".pace_abs_error", Status: "insufficient", Threshold: "median <=15 s/km and P90 <=30 s/km", Reason: "rev2_pace_metrics_unavailable"})
	}
	medianStatus := "insufficient"
	p90Status := "insufficient"
	if real {
		medianStatus = v2ThresholdStatus(*rev2.MedianAbsError, v2PaceMedianMaxSPerKm, false)
		p90Status = v2ThresholdStatus(*rev2.P90AbsError, v2PaceP90MaxSPerKm, false)
	}
	gates = append(gates,
		ReplayGate{ID: prefix + ".pace_median_abs_error", Status: medianStatus, Observed: *rev2.MedianAbsError, Threshold: "<= 15 s/km", Unit: "s/km"},
		ReplayGate{ID: prefix + ".pace_p90_abs_error", Status: p90Status, Observed: *rev2.P90AbsError, Threshold: "<= 30 s/km", Unit: "s/km"})
	if v3 == nil || v3.MedianAbsError == nil || v3.P90AbsError == nil {
		return append(gates, ReplayGate{ID: prefix + ".noninferior_v3", Status: "insufficient", Threshold: "median <= v3+1 s/km, P90 <= v3+2 s/km", Reason: "v3_pace_metrics_unavailable"})
	}
	nonInfStatus := "insufficient"
	if real {
		nonInfStatus = "pass"
		if *rev2.MedianAbsError-*v3.MedianAbsError > v2NonInferiorMedianSPerKm || *rev2.P90AbsError-*v3.P90AbsError > v2NonInferiorP90SPerKm {
			nonInfStatus = "fail"
		}
	}
	return append(gates, ReplayGate{ID: prefix + ".noninferior_v3", Status: nonInfStatus, Observed: []float64{*rev2.MedianAbsError - *v3.MedianAbsError, *rev2.P90AbsError - *v3.P90AbsError}, Threshold: "median delta <= +1 s/km, P90 delta <= +2 s/km", Unit: "s/km"})
}

func v2HRGates(f *ReplayV2Family, family string, real bool) []ReplayGate {
	prefix := v2GatePrefix(f)
	rev2 := v2Metrics(f, StrategyEvolvedCandidate)
	v3 := v2Metrics(f, StrategyV3)
	if rev2 == nil || rev2.MedianAbsError == nil || rev2.P90AbsError == nil {
		return []ReplayGate{{ID: prefix + ".hr_abs_error", Status: "insufficient", Threshold: "median <=5 bpm and P90 <=10 bpm", Reason: "rev2_HR_metrics_unavailable"}}
	}
	medianStatus, p90Status, nonInfStatus := "insufficient", "insufficient", "insufficient"
	if real {
		medianStatus = v2ThresholdStatus(*rev2.MedianAbsError, v2HRMedianMaxBpm, false)
		p90Status = v2ThresholdStatus(*rev2.P90AbsError, v2HRP90MaxBpm, false)
		if v3 != nil && v3.MedianAbsError != nil && v3.P90AbsError != nil {
			// The protocol freezes no explicit HR non-inferiority margin; the
			// margin-0 choice (rev2 no worse than v3) is disclosed in the gate.
			nonInfStatus = "pass"
			if *rev2.MedianAbsError > *v3.MedianAbsError || *rev2.P90AbsError > *v3.P90AbsError {
				nonInfStatus = "fail"
			}
		}
	}
	return []ReplayGate{
		{ID: prefix + ".hr_median_abs_error", Status: medianStatus, Observed: *rev2.MedianAbsError, Threshold: "<= 5 bpm", Unit: "bpm"},
		{ID: prefix + ".hr_p90_abs_error", Status: p90Status, Observed: *rev2.P90AbsError, Threshold: "<= 10 bpm", Unit: "bpm"},
		{ID: prefix + ".noninferior_v3", Status: nonInfStatus, Threshold: "rev2 no worse than v3 (margin 0; protocol freezes no explicit HR margin)", Unit: "bpm"},
	}
}

// rev2FailureRate extracts the evolved revision's failure rate (0 when the
// strategy has no metrics yet — an empty family cannot pass the sample gate
// anyway).
func rev2FailureRate(f *ReplayV2Family) float64 {
	if m := v2Metrics(f, StrategyEvolvedCandidate); m != nil {
		return m.FailureRate
	}
	return 0
}

func v2DegradationGate(id string, versions []ReplayV2VersionMetrics) ReplayGate {
	rev2 := v2MetricsList(versions, StrategyEvolvedCandidate)
	v3 := v2MetricsList(versions, StrategyV3)
	if rev2 == nil || v3 == nil || rev2.MedianAbsError == nil || rev2.P90AbsError == nil || v3.MedianAbsError == nil || v3.P90AbsError == nil {
		return ReplayGate{ID: id, Status: "insufficient", Threshold: "median degrade <=1 s/km, P90 degrade <=2 s/km", Reason: "paired_metrics_unavailable"}
	}
	status := "pass"
	if *rev2.MedianAbsError-*v3.MedianAbsError > v2StratumMedianDegradeS || *rev2.P90AbsError-*v3.P90AbsError > v2StratumP90DegradeS {
		status = "fail"
	}
	return ReplayGate{ID: id, Status: status, Observed: []float64{*rev2.MedianAbsError - *v3.MedianAbsError, *rev2.P90AbsError - *v3.P90AbsError}, Threshold: "median degrade <=1 s/km, P90 degrade <=2 s/km", Unit: "s/km"}
}

func v2Metrics(f *ReplayV2Family, s Strategy) *ReplayV2VersionMetrics {
	for i := range f.Versions {
		if f.Versions[i].Strategy == s {
			return &f.Versions[i]
		}
	}
	return nil
}

func v2MetricsList(versions []ReplayV2VersionMetrics, s Strategy) *ReplayV2VersionMetrics {
	for i := range versions {
		if versions[i].Strategy == s {
			return &versions[i]
		}
	}
	return nil
}

// v2TimeStability computes walk-forward jump diagnostics over each user's
// strict cases ordered by prediction_as_of: adjacent absolute center moves in
// pace space for the evolved revision (with the v3 control), plus the honest
// phase-A lag proxy when a user has >=2 referenced strict predictions.
func v2TimeStability(cases []ReplayV2CaseResult) *ReplayV2TimeStability {
	byUser := map[string][]ReplayV2CaseResult{}
	for _, c := range cases {
		if c.Mode != "strict" {
			continue
		}
		byUser[c.User] = append(byUser[c.User], c)
	}
	var rev2Jumps, v3Jumps []float64
	for _, user := range sortedCaseUsers(byUser) {
		list := byUser[user]
		sort.Slice(list, func(i, j int) bool {
			if !list[i].PredictionAsOf.Equal(list[j].PredictionAsOf) {
				return list[i].PredictionAsOf.Before(list[j].PredictionAsOf)
			}
			return list[i].ID < list[j].ID
		})
		for i := 1; i < len(list); i++ {
			rev2A := v2CenterPace(list[i-1], StrategyEvolvedCandidate)
			rev2B := v2CenterPace(list[i], StrategyEvolvedCandidate)
			if rev2A > 0 && rev2B > 0 {
				rev2Jumps = append(rev2Jumps, absFloat64(rev2B-rev2A))
			}
			v3A := v2CenterPace(list[i-1], StrategyV3)
			v3B := v2CenterPace(list[i], StrategyV3)
			if v3A > 0 && v3B > 0 {
				v3Jumps = append(v3Jumps, absFloat64(v3B-v3A))
			}
		}
	}
	out := &ReplayV2TimeStability{AdjacentPairs: len(rev2Jumps)}
	if len(rev2Jumps) > 0 {
		sort.Float64s(rev2Jumps)
		median, p90, max := rev2Jumps[len(rev2Jumps)/2], rev2Jumps[minInt(9*len(rev2Jumps)/10, len(rev2Jumps)-1)], rev2Jumps[len(rev2Jumps)-1]
		out.JumpMedianSPerKm, out.JumpP90SPerKm, out.JumpMaxSPerKm = &median, &p90, &max
	}
	if len(v3Jumps) > 0 {
		sort.Float64s(v3Jumps)
		median := v3Jumps[len(v3Jumps)/2]
		out.V3JumpMedianSPerKm = &median
	}
	return out
}

// v2LagPoint is one referenced strict prediction for the lag proxy.
type v2LagPoint struct {
	user      string
	asOf      time.Time
	signedErr float64
}

// v2LagSeries collects the rev2 signed errors of available referenced
// observations (called only for the strict final_holdout direct_60min cell).
func v2LagSeries(observations []v2Observation) []v2LagPoint {
	out := []v2LagPoint{}
	for _, o := range observations {
		if o.states[StrategyEvolvedCandidate] == "available" {
			out = append(out, v2LagPoint{user: o.user, asOf: o.asOf, signedErr: o.errors[StrategyEvolvedCandidate]})
		}
	}
	return out
}

// v2LagDiagnostics computes the honest phase-A lag proxy: per user with >=2
// referenced strict predictions, mean signed error of the later half minus
// the earlier half (chronological), averaged over qualifying users. It is a
// descriptive drift diagnostic, never a gate.
func v2LagDiagnostics(series []v2LagPoint) *ReplayV2LagDiagnostics {
	byUser := map[string][]v2LagPoint{}
	for _, p := range series {
		byUser[p.user] = append(byUser[p.user], p)
	}
	users := make([]string, 0, len(byUser))
	for u := range byUser {
		users = append(users, u)
	}
	sort.Strings(users)
	drifts := []float64{}
	for _, u := range users {
		pts := byUser[u]
		if len(pts) < 2 {
			continue
		}
		sort.Slice(pts, func(i, j int) bool {
			if !pts[i].asOf.Equal(pts[j].asOf) {
				return pts[i].asOf.Before(pts[j].asOf)
			}
			return false
		})
		half := len(pts) / 2
		early, late := 0.0, 0.0
		for i := 0; i < half; i++ {
			early += pts[i].signedErr
		}
		for i := half; i < len(pts); i++ {
			late += pts[i].signedErr
		}
		early /= float64(half)
		late /= float64(len(pts) - half)
		drifts = append(drifts, late-early)
	}
	if len(drifts) == 0 {
		return nil
	}
	sum, correction := 0.0, 0.0
	for _, d := range drifts {
		addCompensated(&sum, &correction, d)
	}
	drift := sum / float64(len(drifts))
	return &ReplayV2LagDiagnostics{Users: len(drifts), DriftSPerKm: &drift, Note: "later-half minus earlier-half mean signed error per user with >=2 referenced strict predictions; descriptive proxy, never a gate"}
}

func v2CenterPace(c ReplayV2CaseResult, s Strategy) float64 {
	for _, v := range c.Versions {
		if v.Strategy != s || v.Snapshot.ThresholdSpeedMps == nil || !candidateFinite(v.Snapshot.ThresholdSpeedMps) || *v.Snapshot.ThresholdSpeedMps <= 0 {
			continue
		}
		return 1000 / *v.Snapshot.ThresholdSpeedMps
	}
	return 0
}

func sortedCaseUsers(byUser map[string][]ReplayV2CaseResult) []string {
	users := make([]string, 0, len(byUser))
	for u := range byUser {
		users = append(users, u)
	}
	sort.Strings(users)
	return users
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// v2PriorSensitivity summarizes the with-prior vs prior-free evolved double
// run: absolute center deltas in pace space and state flips.
func v2PriorSensitivity(cases []ReplayV2CaseResult) *ReplayV2PriorSensitivity {
	out := &ReplayV2PriorSensitivity{}
	var deltas []float64
	for _, c := range cases {
		main := v2CaseVersion(c, StrategyEvolvedCandidate)
		if main == nil || c.PriorFreeEvolved == nil {
			continue
		}
		if main.Snapshot.ThresholdSpeedMps == nil || c.PriorFreeEvolved.Snapshot.ThresholdSpeedMps == nil {
			continue
		}
		if !candidateFinite(main.Snapshot.ThresholdSpeedMps) || !candidateFinite(c.PriorFreeEvolved.Snapshot.ThresholdSpeedMps) {
			continue
		}
		out.CasesCompared++
		with := 1000 / *main.Snapshot.ThresholdSpeedMps
		without := 1000 / *c.PriorFreeEvolved.Snapshot.ThresholdSpeedMps
		deltas = append(deltas, absFloat64(with-without))
		if main.Evolved != nil && c.PriorFreeEvolved.Evolved != nil && main.Evolved.Speed != nil && c.PriorFreeEvolved.Evolved.Speed != nil && main.Evolved.Speed.State != c.PriorFreeEvolved.Evolved.Speed.State {
			out.StateFlips++
		}
	}
	if len(deltas) > 0 {
		sort.Float64s(deltas)
		median, max := deltas[len(deltas)/2], deltas[len(deltas)-1]
		out.MedianAbsDeltaSPerKm, out.MaxAbsDeltaSPerKm = &median, &max
	}
	if out.CasesCompared == 0 {
		return nil
	}
	return out
}

func v2CaseVersion(c ReplayV2CaseResult, s Strategy) *OfflineResult {
	for i := range c.Versions {
		if c.Versions[i].Strategy == s {
			return &c.Versions[i]
		}
	}
	return nil
}

func v2GatePrefix(f *ReplayV2Family) string {
	return f.Family + "." + f.Split + "." + f.Mode
}

// v2Bootstrap is the frozen uncertainty draw: user-level resampling with the
// frozen seed 993994 and 2000 resamples over paired rev2/v3 absolute errors.
// Each resampled user's whole group receives one user's total weight.
func v2Bootstrap(observations []v2Observation) *ReplayV2Uncertainty {
	type pair struct{ rev2, v3 float64 }
	byUser := map[string][]pair{}
	for _, o := range observations {
		if o.states[StrategyEvolvedCandidate] == "available" && o.states[StrategyV3] == "available" {
			byUser[o.user] = append(byUser[o.user], pair{absFloat64(o.errors[StrategyEvolvedCandidate]), absFloat64(o.errors[StrategyV3])})
		}
	}
	users := make([]string, 0, len(byUser))
	for u := range byUser {
		users = append(users, u)
	}
	sort.Strings(users)
	if len(users) < 2 {
		return nil
	}
	rng := rand.New(rand.NewSource(v2BootstrapSeed))
	medians, p90s := make([]float64, v2BootstrapResamples), make([]float64, v2BootstrapResamples)
	for n := 0; n < v2BootstrapResamples; n++ {
		var rev2Errs, v3Errs [][2]float64
		for range users {
			selected := byUser[users[rng.Intn(len(users))]]
			w := 1 / float64(len(users)*len(selected))
			for _, p := range selected {
				rev2Errs = append(rev2Errs, [2]float64{p.rev2, w})
				v3Errs = append(v3Errs, [2]float64{p.v3, w})
			}
		}
		medians[n] = errorQuantile(rev2Errs, 0.5) - errorQuantile(v3Errs, 0.5)
		p90s[n] = errorQuantile(rev2Errs, 0.9) - errorQuantile(v3Errs, 0.9)
	}
	sort.Float64s(medians)
	sort.Float64s(p90s)
	return &ReplayV2Uncertainty{Method: "user_cluster_percentile_95", Seed: v2BootstrapSeed, Resamples: v2BootstrapResamples, MedianRev2MinusV3: [2]float64{medians[49], medians[1949]}, P90Rev2MinusV3: [2]float64{p90s[49], p90s[1949]}}
}

// v2EvolvedCovers reports the protocol v2 engineering coverage shape: a
// finite, physically legal center plus a finite sensitivity range.
func v2EvolvedCovers(c ReplayV2CaseResult) bool {
	if c.Failures[StrategyEvolvedCandidate] != "" {
		return false
	}
	for _, v := range c.Versions {
		if v.Strategy != StrategyEvolvedCandidate || v.Evolved == nil || v.Evolved.Speed == nil {
			continue
		}
		s := v.Evolved.Speed
		if s.CenterMps == nil || s.RangeLowMps == nil || s.RangeHighMps == nil {
			return false
		}
		center, low, high := *s.CenterMps, *s.RangeLowMps, *s.RangeHighMps
		if !candidateFinite(s.CenterMps) || !candidateFinite(s.RangeLowMps) || !candidateFinite(s.RangeHighMps) {
			return false
		}
		if center <= 0 || center > contractMaxPlausibleSpeedMps {
			return false
		}
		return low <= center && center <= high
	}
	return false
}

// v2GateReduction follows the frozen v1 reduction semantics: any fail fails,
// else any insufficient stays insufficient, else passed.
func v2GateReduction(gates []ReplayGate) string {
	status := "passed"
	for _, g := range gates {
		if g.Status == "fail" {
			return "failed"
		}
		if g.Status == "insufficient" {
			status = "insufficient"
		}
	}
	return status
}
