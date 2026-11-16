package calibration

import (
	"math"
	"time"
)

// The frozen estimation contract for the in-place evolved v4 (SPEC #993,
// ticket #995, user decision 2026-11-16: no v5 identity). AlgorithmVersion
// stays 4; new and historical v4 outputs are separated by the algorithm
// revision marker, never by a new top-level version. See
// docs/calibration/estimation-contract-v2.md.

// HistoricalCandidateAlgorithmRevision is the implicit revision of every v4
// row written by the PR#740 implementation (empty algorithm_revision column).
const HistoricalCandidateAlgorithmRevision = ""

// EvolvedCandidateAlgorithmRevision marks outputs of the in-place evolved v4.
// It participates in the snapshot natural key so a new-revision write can
// never overwrite a historical v4 row (ADR 0045, #995).
const EvolvedCandidateAlgorithmRevision = "v4-rev2-2026-11"

// EvolvedPriorSetVersion names the runnable default parameter set. It is part
// of the evolved candidate identity and of every lineage serialization.
const EvolvedPriorSetVersion = "rev2-research-2026-11"

const evolvedImplementationIdentity = "evolved_joint_v2"

// EvolvedCandidateIdentity returns the frozen (implementation, parameter set,
// algorithm revision) triple that T2-T4 estimators must stamp on every
// OfflineResult, SourceSummary and persisted snapshot of the evolved v4.
func EvolvedCandidateIdentity() (implementation, parameterVersion, revision string) {
	return evolvedImplementationIdentity, EvolvedPriorSetVersion, EvolvedCandidateAlgorithmRevision
}

// EstimationState is the five-label state contract for threshold outputs.
// Range semantics: every non-unavailable state must publish a finite
// estimation range described as model sensitivity, never as a calibrated
// probability interval.
type EstimationState string

const (
	// StateMeasuredReference: a verified independent reference (all-out
	// confirmed/probable anchor for speed; verified field protocol or lab
	// report for HR) directly supports the center.
	StateMeasuredReference EstimationState = "measured_reference"
	// StateModelEstimated: ordinary training identifies the target within the
	// pre-declared identifiability criteria.
	StateModelEstimated EstimationState = "model_estimated"
	// StatePriorDominated: valid inputs exist but identification is
	// prior-limited (or only a prior exists); a finite wide-range estimate is
	// still mandatory.
	StatePriorDominated EstimationState = "prior_dominated"
	// StateStale: the retained estimate's supporting evidence is older than
	// the declared staleness window; the estimate is kept, flagged and aged.
	StateStale EstimationState = "stale"
	// StateUnavailable: no valid input and no qualified prior, physically
	// impossible inputs, or solver failure. A reason is mandatory.
	StateUnavailable EstimationState = "unavailable"
)

// Bounded categorical reasons persisted in summaries. The denylist below is
// the contract-level guarantee of #995: these categorical facts can never
// justify unavailability.
const (
	ReasonNoValidRunningInput     = "no_valid_running_input"
	ReasonNoHRSeriesOrPrior       = "no_HR_series_or_qualified_physiological_prior"
	ReasonInputsPhysicallyInvalid = "inputs_physically_invalid"
	ReasonPriorOnlyAged           = "current_window_empty_prior_only_aged"
	ReasonIdentifiabilityLimited  = "identifiability_limited_prior_dominated"
	ReasonSingleActivityWindow    = "single_activity_no_duration_diversity"
	ReasonEvidenceStale           = "supporting_evidence_older_than_staleness_window"
	ReasonOpticalHRDownweighted   = "optical_HR_downweighted_not_excluded"
	ReasonPriorOnlyHR             = "prior_only_HR_estimate"
	ReasonSolverPendingT2         = "estimator_implementation_pending_t2"
	// ReasonSolverNumericalFailure: the deterministic solver produced a
	// nonfinite or nonpositive-curvature result. This is a failure of the
	// computation, never a claim of insufficient evidence (#996).
	ReasonSolverNumericalFailure = "solver_numerical_failure"
)

// neverUnavailabilityReasons are categorical facts that must NOT appear as
// unavailability reasons: missing all-out labels, missing chest strap and
// optical-HR-only are downgrades of support, never output suppressors.
func NeverUnavailabilityReasons() []string {
	return []string{"missing_all_out_label", "missing_chest_strap", "optical_HR_only"}
}

// Pre-declared thresholds (part of the frozen contract; units in field names).
const (
	// ContractSpeedStaleAfterDays: speed support older than this is stale.
	ContractSpeedStaleAfterDays = 90.0
	// ContractHRStaleAfterDays matches the v1 HR freshness rule (60d).
	ContractHRStaleAfterDays = 60.0
	// ContractEvidenceWindowDays matches the production 180-day window.
	ContractEvidenceWindowDays = 180
	// ContractSpeedModelMinRoots/Days and duration ratio mirror the v1
	// identifiability pattern: without all-out anchors, ordinary training must
	// span >= 2 independent roots on >= 2 days with >= 1.5x duration diversity
	// before the center may be called model_estimated instead of
	// prior_dominated.
	ContractSpeedModelMinRoots                    = 2
	ContractSpeedModelMinDays                     = 2
	ContractSpeedDurationRatioMin                 = 1.5
	ContractSpeedEligibleMinRoots                 = 3
	contractMaxPlausibleSpeedMps                  = 8.5
	contractMinModelDurationS                     = 180.0
	contractHRValidLowBpm, contractHRValidHighBpm = 80.0, 230.0
)

// HistoricalCapabilityPrior is the weak prior extracted from a prior v3/v4
// snapshot. It is never a speed cap and is aged with a variance floor
// (SPEC #993 R1).
type HistoricalCapabilityPrior struct {
	V60Mps  float64
	AgeDays float64
}

func (p *HistoricalCapabilityPrior) valid() bool {
	return p != nil && candidateFinite(&p.V60Mps) && p.V60Mps > 0 && p.V60Mps <= contractMaxPlausibleSpeedMps && p.AgeDays >= 0
}

// AdjudicationInput carries the as-of facts the contract adjudicates on. All
// facts must be derived with the same cutoff instant; DeriveAdjudicationInput
// is the canonical derivation from v1 evidence types.
type AdjudicationInput struct {
	AsOf time.Time
	// Speed-side facts (admitted observations inside the window only).
	ValidRunningObservations   int
	IndependentActivityRoots   int
	IndependentDays            int
	MinDurationS               float64
	MaxDurationS               float64
	MaximalAnchorCount         int
	InputsPhysicallyInvalid    bool
	LatestSpeedEvidenceAgeDays float64
	HasHistoricalPrior         bool
	// HR-side facts.
	HRSeriesValid           bool
	HRSensorOpticalOnly     bool
	HRMeasuredReference     bool
	PhysiologicalPriorOK    bool
	LatestHREvidenceAgeDays float64
}

// MetricDecision is the pre-declared outcome for one metric.
type MetricDecision struct {
	State          EstimationState `json:"state"`
	Valid          bool            `json:"valid"`
	Eligible       bool            `json:"eligible"`
	Reasons        []string        `json:"reasons"`
	RangeRequired  bool            `json:"range_required"`
	RangeSemantics string          `json:"range_semantics"`
}

// EstimationDecision is the joint per-metric adjudication result. It is a
// contract target for T2-T4 estimators, not an estimator itself.
type EstimationDecision struct {
	Speed MetricDecision `json:"speed"`
	HR    MetricDecision `json:"hr"`
}

const contractRangeSemantics = "model_sensitivity_range_not_probability_interval"

// AdjudicateEstimationContract applies the frozen decision order. Missing
// all-out labels and missing chest straps appear nowhere in the unavailability
// branches by construction.
func AdjudicateEstimationContract(in AdjudicationInput) EstimationDecision {
	return EstimationDecision{Speed: adjudicateSpeed(in), HR: adjudicateHR(in)}
}

func adjudicateSpeed(in AdjudicationInput) MetricDecision {
	d := MetricDecision{State: StateUnavailable, Reasons: []string{}, RangeSemantics: contractRangeSemantics}
	d.Valid = in.ValidRunningObservations > 0 || in.HasHistoricalPrior
	d.Eligible = in.IndependentActivityRoots >= ContractSpeedEligibleMinRoots
	switch {
	case in.InputsPhysicallyInvalid:
		d.Reasons = append(d.Reasons, ReasonInputsPhysicallyInvalid)
		return d
	case in.ValidRunningObservations == 0 && !in.HasHistoricalPrior:
		d.Reasons = append(d.Reasons, ReasonNoValidRunningInput)
		return d
	case in.ValidRunningObservations == 0:
		// Aged weak prior only: finite prior_dominated estimate, never a cap.
		d.State = StatePriorDominated
		d.RangeRequired = true
		d.Reasons = append(d.Reasons, ReasonPriorOnlyAged, ReasonIdentifiabilityLimited)
		return d
	}
	if in.LatestSpeedEvidenceAgeDays > ContractSpeedStaleAfterDays {
		d.State = StateStale
		d.RangeRequired = true
		d.Reasons = append(d.Reasons, ReasonEvidenceStale)
		return d
	}
	if in.MaximalAnchorCount > 0 {
		d.State = StateMeasuredReference
		d.RangeRequired = true
		return d
	}
	identifiable := in.IndependentActivityRoots >= ContractSpeedModelMinRoots &&
		in.IndependentDays >= ContractSpeedModelMinDays &&
		in.MinDurationS > 0 && in.MaxDurationS/in.MinDurationS >= ContractSpeedDurationRatioMin
	if identifiable {
		d.State = StateModelEstimated
		d.RangeRequired = true
		return d
	}
	d.State = StatePriorDominated
	d.RangeRequired = true
	d.Reasons = append(d.Reasons, ReasonIdentifiabilityLimited)
	if in.ValidRunningObservations == 1 || in.IndependentActivityRoots <= 1 {
		d.Reasons = append(d.Reasons, ReasonSingleActivityWindow)
	}
	return d
}

func adjudicateHR(in AdjudicationInput) MetricDecision {
	d := MetricDecision{State: StateUnavailable, Reasons: []string{}, RangeSemantics: contractRangeSemantics}
	d.Valid = in.HRSeriesValid || in.PhysiologicalPriorOK
	d.Eligible = in.HRSeriesValid || in.PhysiologicalPriorOK
	switch {
	case !in.HRSeriesValid && !in.PhysiologicalPriorOK:
		d.Reasons = append(d.Reasons, ReasonNoHRSeriesOrPrior)
		return d
	case in.HRMeasuredReference && in.LatestHREvidenceAgeDays <= ContractHRStaleAfterDays:
		d.State = StateMeasuredReference
		d.RangeRequired = true
		return d
	case in.HRSeriesValid && in.LatestHREvidenceAgeDays > ContractHRStaleAfterDays:
		d.State = StateStale
		d.RangeRequired = true
		d.Reasons = append(d.Reasons, ReasonEvidenceStale)
		return d
	case in.HRSeriesValid:
		// Optical-only wrist HR is a down-weighted model input, never an
		// exclusion; a chest strap is not required to estimate.
		d.State = StateModelEstimated
		d.RangeRequired = true
		if in.HRSensorOpticalOnly {
			d.Reasons = append(d.Reasons, ReasonOpticalHRDownweighted)
		}
		return d
	default:
		// No usable series but a qualified physiological prior: finite
		// prior_dominated HR (SPEC #993 R2).
		d.State = StatePriorDominated
		d.RangeRequired = true
		d.Reasons = append(d.Reasons, ReasonPriorOnlyHR)
		return d
	}
}

// DeriveAdjudicationInput projects v1 evidence types onto the contract facts
// at one cutoff instant. Evidence dated after the cutoff, non-selected,
// non-continuous or out-of-window rows never contribute, which is exactly the
// no-time-machine guarantee: future inputs cannot alter this derivation.
func DeriveAdjudicationInput(evidence []CandidateEvidence, hr *CandidateHRReport, asOf time.Time, prior *HistoricalCapabilityPrior, hrPriorQualified bool) AdjudicationInput {
	in := AdjudicationInput{AsOf: asOf, LatestSpeedEvidenceAgeDays: math.Inf(1), LatestHREvidenceAgeDays: math.Inf(1), PhysiologicalPriorOK: hrPriorQualified}
	in.HasHistoricalPrior = prior.valid()
	selectedCount := 0
	roots, days := map[string]bool{}, map[string]bool{}
	latestSpeed := time.Time{}
	invalid := 0
	for _, e := range evidence {
		if !e.Selected || e.ActivityDate.IsZero() {
			continue
		}
		age := dayDiff(asOf, e.ActivityDate)
		if age < 0 || age > ContractEvidenceWindowDays {
			continue
		}
		selectedCount++
		bad := !candidateFinite(&e.AvgSpeedMps) || e.AvgSpeedMps <= 0 || e.AvgSpeedMps > contractMaxPlausibleSpeedMps ||
			!candidateFinite(&e.DurationS) || math.IsInf(e.DurationS, 0) || e.DurationS < contractMinModelDurationS
		if bad {
			invalid++
			continue
		}
		if !e.Continuous {
			continue
		}
		in.ValidRunningObservations++
		root := candidateRootID(e)
		roots[root] = true
		days[e.ActivityDate.Format("2006-01-02")] = true
		if in.MinDurationS == 0 || e.DurationS < in.MinDurationS {
			in.MinDurationS = e.DurationS
		}
		if e.DurationS > in.MaxDurationS {
			in.MaxDurationS = e.DurationS
		}
		if e.EffortSupport == EffortConfirmedMaximal || e.EffortSupport == EffortProbableMaximal {
			in.MaximalAnchorCount++
		}
		if e.ActivityDate.After(latestSpeed) {
			latestSpeed = e.ActivityDate
		}
	}
	in.InputsPhysicallyInvalid = selectedCount > 0 && in.ValidRunningObservations == 0 && invalid > 0
	in.IndependentActivityRoots = len(roots)
	in.IndependentDays = len(days)
	if !latestSpeed.IsZero() {
		in.LatestSpeedEvidenceAgeDays = float64(dayDiff(asOf, latestSpeed))
	}
	if hr != nil {
		anySeries, anyStrap := false, false
		latestHR := time.Time{}
		for _, o := range hr.Observations {
			if o.ActivityDate.IsZero() || o.ValueBpm == nil || !candidateFinite(o.ValueBpm) || *o.ValueBpm < contractHRValidLowBpm || *o.ValueBpm > contractHRValidHighBpm {
				continue
			}
			age := dayDiff(asOf, o.ActivityDate)
			if age < 0 || age > ContractEvidenceWindowDays {
				continue
			}
			anySeries = true
			if o.Sensor == "chest_strap" {
				anyStrap = true
			}
			if o.Selected && (o.ReferenceTier == "lab_lthr" || o.ReferenceTier == "field_hr_proxy") {
				in.HRMeasuredReference = true
			}
			if o.ActivityDate.After(latestHR) {
				latestHR = o.ActivityDate
			}
		}
		in.HRSeriesValid = anySeries
		in.HRSensorOpticalOnly = anySeries && !anyStrap
		if !latestHR.IsZero() {
			in.LatestHREvidenceAgeDays = float64(dayDiff(asOf, latestHR))
		}
	}
	return in
}

// EstimationUnits declares every target unit of the contract. Pace is derived
// from the speed center as 1000/v60 (seconds per km); types are derived, not
// self-reported by inputs.
type EstimationUnits struct {
	Speed        string `json:"speed"`
	Pace         string `json:"pace"`
	HR           string `json:"hr"`
	Duration     string `json:"duration"`
	EffortMargin string `json:"effort_margin"`
	RelIntensity string `json:"relative_intensity"`
}

// EstimationStateSpec documents one state label.
type EstimationStateSpec struct {
	State     EstimationState `json:"state"`
	Semantics string          `json:"semantics"`
}

// ValidEligibleSpec is the pre-declared split between input validity and the
// evaluation-coverage eligibility rule (protocol v2).
type ValidEligibleSpec struct {
	ValidDefinition    string `json:"valid_definition"`
	EligibleDefinition string `json:"eligible_definition"`
	NonExclusions      string `json:"non_exclusions"`
}

// EstimationGateSpec is one of the three non-interchangeable gates.
type EstimationGateSpec struct {
	ID       string   `json:"id"`
	Requires []string `json:"requires"`
	Allows   string   `json:"allows"`
	Blocks   string   `json:"blocks"`
}

// PublicationContractSpec freezes the revision-in-key resolution for the
// (user, day, version) overwrite conflict found in #995.
type PublicationContractSpec struct {
	NaturalKey        string `json:"natural_key"`
	SameKeySemantics  string `json:"same_key_semantics"`
	CrossRevisionRule string `json:"cross_revision_rule"`
	ReadTiebreak      string `json:"read_tiebreak"`
}

// EstimationContractDocument is the complete serializable contract snapshot:
// identity, units, states, priors, hashes and gates. Its IdentityHash is the
// lineage anchor T2-T4 reports must embed.
type EstimationContractDocument struct {
	ContractVersion    string                  `json:"contract_version"`
	AlgorithmVersion   int                     `json:"algorithm_version"`
	AlgorithmRevision  string                  `json:"algorithm_revision"`
	Strategy           Strategy                `json:"strategy"`
	Implementation     string                  `json:"implementation"`
	Units              EstimationUnits         `json:"units"`
	States             []EstimationStateSpec   `json:"states"`
	ValidEligible      ValidEligibleSpec       `json:"valid_eligible"`
	Priors             EvolvedPriorSet         `json:"priors"`
	PriorsIdentityHash string                  `json:"priors_identity_hash"`
	ProtocolV1SHA256   string                  `json:"protocol_v1_sha256"`
	ProtocolV2SHA256   string                  `json:"protocol_v2_sha256"`
	V3SourceSHA256     string                  `json:"v3_source_sha256"`
	Gates              []EstimationGateSpec    `json:"gates"`
	Publication        PublicationContractSpec `json:"publication"`
}

const estimationContractVersion = "estimation-contract-v2-2026-11-16"

// EstimationContractDocumentSnapshot returns the frozen contract document.
func EstimationContractDocumentSnapshot() EstimationContractDocument {
	implementation, _, revision := EvolvedCandidateIdentity()
	priors := DefaultEvolvedPriors()
	return EstimationContractDocument{
		ContractVersion:   estimationContractVersion,
		AlgorithmVersion:  CandidateVersion,
		AlgorithmRevision: revision,
		Strategy:          StrategyEvolvedCandidate,
		Implementation:    implementation,
		Units: EstimationUnits{
			Speed:        "m_per_s",
			Pace:         "s_per_km derived as 1000/v60",
			HR:           "bpm",
			Duration:     "s",
			EffortMargin: "log_speed (delta in log v units, >= 0)",
			RelIntensity: "v/v60 dimensionless",
		},
		States: []EstimationStateSpec{
			{StateMeasuredReference, "verified independent reference anchors the center; range is sensitivity"},
			{StateModelEstimated, "ordinary training identifies the target under pre-declared identifiability criteria"},
			{StatePriorDominated, "valid inputs but identification is prior-limited; finite wide range mandatory"},
			{StateStale, "retained estimate whose support is older than the declared staleness window"},
			{StateUnavailable, "no valid input and no qualified prior, physically invalid inputs, or solver failure; reason mandatory"},
		},
		ValidEligible: ValidEligibleSpec{
			ValidDefinition:    "input passes physical/plausibility gates (finite, in-domain speeds 0<v<=8.5 m/s, durations >= 180 s, HR 80-230 bpm, in window)",
			EligibleDefinition: "pre-declared evaluation coverage rule: speed >= 3 admitted running roots in window; HR has valid HR series or qualified physiological prior; coverage is reported for all inputs AND eligible inputs",
			NonExclusions:      "missing all-out labels and missing chest strap never remove validity or eligibility",
		},
		Priors:             priors,
		PriorsIdentityHash: priors.IdentityHash(),
		ProtocolV1SHA256:   hashBytes(evaluationProtocol),
		ProtocolV2SHA256:   EvaluationProtocolV2SHA256(),
		V3SourceSHA256:     FrozenV3SourceSHA256(),
		Gates: []EstimationGateSpec{
			{ID: "engineering_admission", Requires: []string{"determinism", "version_isolation", "provenance_and_recovery_tests", "independent_review"}, Allows: "further tickets and single-user trial candidacy", Blocks: "nothing accuracy-related; never a rollout"},
			{ID: "single_user_research_trial", Requires: []string{"engineering_admission", "explicit_user_authorization", "per_user_isolation", "revocable_recovery"}, Allows: "one authorized user with research_uncalibrated disclosure; population accuracy may stay insufficient", Blocks: "any second user, any derived-data write outside the user, any global change"},
			{ID: "full_rollout", Requires: []string{"pre_frozen_independent_accuracy_gates_pass", "release_authorization"}, Allows: "expanded activation", Blocks: "insufficient accuracy keeps blocking regardless of personal authorizations"},
		},
		Publication: PublicationContractSpec{
			NaturalKey:        "user_id + as_of_date + algorithm_version + algorithm_revision",
			SameKeySemantics:  "same key republish is an idempotent overwrite (same-day recompute semantics retained from ADR 0045)",
			CrossRevisionRule: "a different algorithm_revision writes a new row; historical v4 rows (revision='') are never overwritten",
			ReadTiebreak:      "as_of_date DESC, id DESC within a version; per-user revision preference lands with T5 (#999)",
		},
	}
}

// IdentityHash is the deterministic digest of the serialized contract.
func (d EstimationContractDocument) IdentityHash() string { return ReplayContentHash(d) }
