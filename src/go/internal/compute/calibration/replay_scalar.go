package calibration

import "strconv"

// Scalar metrics always use the cohort's explicit unit. Legacy pace-only fields
// are projected separately, never reused for heart rate or race seconds.
type ReplayScalarMetrics struct {
	Strategy             Strategy       `json:"strategy"`
	Available            int            `json:"available"`
	Missing              int            `json:"missing"` // All unavailable, retained for legacy consumers.
	MissingCenter        int            `json:"missing_center"`
	Unsupported          int            `json:"unsupported"`
	ComputationFailures  int            `json:"computation_failures"`
	Coverage             float64        `json:"coverage"`
	FailureRate          float64        `json:"failure_rate"`
	Reasons              map[string]int `json:"reasons"`
	PredictionTargets    map[string]int `json:"prediction_targets,omitempty"`
	MedianAbsoluteError  *float64       `json:"median_absolute_error"`
	P90AbsoluteError     *float64       `json:"p90_absolute_error"`
	SignedBias           *float64       `json:"signed_bias"`
	MedianAbsoluteErrorS *float64       `json:"median_absolute_error_s,omitempty"`
	P90AbsoluteErrorS    *float64       `json:"p90_absolute_error_s,omitempty"`
	SignedBiasS          *float64       `json:"signed_bias_s,omitempty"`
}
type ReplayGate struct {
	ID                 string `json:"id"`
	Status             string `json:"status"` // pass, fail, insufficient
	Observed           any    `json:"observed"`
	Threshold          string `json:"threshold"`
	Unit               string `json:"unit"`
	Reason             string `json:"reason,omitempty"`
	EligibleActivities int    `json:"eligible_activities"`
	EligibleUsers      int    `json:"eligible_users"`
	PairedActivities   int    `json:"paired_activities"`
	PairedUsers        int    `json:"paired_users"`
}
type ReplayScalarUncertainty struct {
	Method                 string     `json:"method"`
	Unit                   string     `json:"unit"`
	Seed                   int64      `json:"seed"`
	Resamples              int        `json:"resamples"`
	MedianCandidateMinusV3 [2]float64 `json:"median_candidate_minus_v3"`
	P90CandidateMinusV3    [2]float64 `json:"p90_candidate_minus_v3"`
}
type ReplayScalarStratum struct {
	Name               string                `json:"name"`
	Required           bool                  `json:"required"`
	Status             string                `json:"status"`
	EligibleActivities int                   `json:"eligible_activities"`
	EligibleUsers      int                   `json:"eligible_users"`
	PairedActivities   int                   `json:"paired_activities"`
	PairedUsers        int                   `json:"paired_users"`
	Versions           []ReplayScalarMetrics `json:"versions"`
	Gates              []ReplayGate          `json:"gates"`
}
type ReplayCohortEvaluation struct {
	Split                string                   `json:"split"`
	Mode                 string                   `json:"mode"`
	Family               string                   `json:"family"`
	Unit                 string                   `json:"unit"`
	Status               string                   `json:"status"`
	EligibleActivities   int                      `json:"eligible_activities"`
	EligibleUsers        int                      `json:"eligible_users"`
	PairedActivities     int                      `json:"paired_activities"`
	PairedUsers          int                      `json:"paired_users"`
	RejectedLabels       map[string]int           `json:"rejected_labels"`
	SupportGrades        map[string]int           `json:"support_grades"`
	MaxUserWeight        float64                  `json:"max_user_weight"`
	ImplementationsValid bool                     `json:"implementations_valid"`
	Versions             []ReplayScalarMetrics    `json:"versions"`
	Strata               []ReplayScalarStratum    `json:"strata"`
	Uncertainty          *ReplayScalarUncertainty `json:"uncertainty"`
	Gates                []ReplayGate             `json:"gates"`
}

func gateReduction(gates []ReplayGate) string {
	status := "passed"
	for _, g := range gates {
		if g.Status == "fail" {
			return "failed"
		}
		if g.Status != "pass" {
			status = "insufficient"
		}
	}
	return status
}

// EvaluateReplayGates classifies scalar evidence against the frozen protocol.
// Calling it with synthetic scalars tests the classifier, not real accuracy.
func EvaluateReplayGates(c ReplayCohortEvaluation) []ReplayGate {
	var gates []ReplayGate
	add := func(id string, observed any, threshold, unit string, enough, ok bool) {
		state := "insufficient"
		reason := "insufficient_independent_paired_evidence"
		if enough {
			state = "fail"
			reason = "numeric_gate_failed"
			if ok {
				state = "pass"
				reason = ""
			}
		}
		gates = append(gates, ReplayGate{ID: id, Status: state, Observed: observed, Threshold: threshold, Unit: unit, Reason: reason, EligibleActivities: c.EligibleActivities, EligibleUsers: c.EligibleUsers, PairedActivities: c.PairedActivities, PairedUsers: c.PairedUsers})
	}
	minimum, users := 30, 10
	if c.Family == "race_prediction" {
		minimum, users = 60, 20
	}
	enough := c.PairedActivities >= minimum && c.PairedUsers >= users
	add("sample", []int{c.EligibleActivities, c.EligibleUsers, c.PairedActivities, c.PairedUsers}, "paired activities >= "+itoa(minimum)+", users >= "+itoa(users), "count", enough, true)
	add("implementations", c.ImplementationsValid, "three distinct implemented strategies", "identity", c.ImplementationsValid, true)
	keyed := map[Strategy]ReplayScalarMetrics{}
	for _, v := range c.Versions {
		keyed[v.Strategy] = v
	}
	v3, segments, candidate := keyed[StrategyV3], keyed[StrategySegmentsOnly], keyed[StrategyCandidate]
	complete := len(keyed) == 3 && v3.MedianAbsoluteError != nil && v3.P90AbsoluteError != nil && segments.MedianAbsoluteError != nil && segments.P90AbsoluteError != nil && candidate.MedianAbsoluteError != nil && candidate.P90AbsoluteError != nil
	if c.Family == "direct_60min" {
		add("weight", c.MaxUserWeight, "<= 0.20", "fraction", enough, c.MaxUserWeight <= .20)
		add("coverage", []float64{v3.Coverage, segments.Coverage, candidate.Coverage}, "candidate >= 0.90 and >= both baselines", "fraction", c.EligibleActivities >= minimum && c.EligibleUsers >= users, candidate.Coverage >= .90 && candidate.Coverage >= v3.Coverage && candidate.Coverage >= segments.Coverage)
		add("failure", candidate.FailureRate, "<= 0.01", "fraction", c.EligibleActivities >= minimum && c.EligibleUsers >= users, candidate.FailureRate <= .01)
	}
	if complete {
		tolerance := 0.0
		if c.Family == "direct_60min" {
			tolerance = 1e-9
		}
		med, p90 := *candidate.MedianAbsoluteError-*v3.MedianAbsoluteError, *candidate.P90AbsoluteError-*v3.P90AbsoluteError
		add("v3.noninferior", []float64{med, p90}, "median and P90 delta <= "+ftoa(tolerance), c.Unit, enough, med <= tolerance && p90 <= tolerance)
		if c.Family == "direct_60min" || c.Family == "race_prediction" {
			dm, dp := *segments.MedianAbsoluteError-*candidate.MedianAbsoluteError, *segments.P90AbsoluteError-*candidate.P90AbsoluteError
			a, b := 1.0, 2.0
			if c.Family == "race_prediction" {
				a, b = .005, .005
			}
			add("segments.improvement", []float64{dm, dp}, "median >= "+ftoa(a)+" OR P90 >= "+ftoa(b), c.Unit, enough && c.ImplementationsValid, dm >= a || dp >= b)
		} else {
			add("absolute_error", []float64{*candidate.MedianAbsoluteError, *candidate.P90AbsoluteError}, "median <= 3, P90 <= 6", "bpm", enough, *candidate.MedianAbsoluteError <= 3 && *candidate.P90AbsoluteError <= 6)
		}
	} else {
		add("v3.noninferior", nil, "three-way paired median and P90", c.Unit, false, false)
		if c.Family == "direct_60min" || c.Family == "race_prediction" {
			add("segments.improvement", nil, "three-way paired improvement", c.Unit, false, false)
		} else {
			add("absolute_error", nil, "median <= 3, P90 <= 6", "bpm", false, false)
		}
	}
	if c.Uncertainty == nil {
		add("uncertainty", nil, "95% paired delta upper endpoints <= 0", c.Unit, false, false)
	} else {
		u := c.Uncertainty
		add("uncertainty", []float64{u.MedianCandidateMinusV3[1], u.P90CandidateMinusV3[1]}, "2000 user-cluster resamples, seed983984; both upper endpoints <= 0", c.Unit, enough && u.Resamples == 2000 && u.Seed == 983984, u.MedianCandidateMinusV3[1] <= 0 && u.P90CandidateMinusV3[1] <= 0)
	}
	for _, s := range c.Strata {
		if s.Required {
			gates = append(gates, s.Gates...)
		}
	}
	if len(c.Strata) == 0 {
		add("strata", nil, "predeclared required strata, each >=10 activities/3 users", "count", false, false)
	}
	return gates
}

func itoa(n int) string     { return strconv.Itoa(n) }
func ftoa(n float64) string { return strconv.FormatFloat(n, 'g', -1, 64) }
