package calibration

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

var replayStrategies = []Strategy{StrategyV3, StrategySegmentsOnly, StrategyCandidate}

type replayScalarCohort struct {
	replayCohort
	seconds                      []pairedError
	missing, unsupported, failed [3]int
	reasons                      [3]map[string]int
	targets                      [3]map[string]int
}

func (a *replayScalarCohort) addScalar(p, seconds pairedError, states, reasons, targets [3]string) {
	var available [3]bool
	for i, state := range states {
		available[i] = state == "available"
		switch state {
		case "missing":
			a.missing[i]++
		case "unsupported":
			a.unsupported[i]++
		case "failed":
			a.failed[i]++
		}
		if a.reasons[i] == nil {
			a.reasons[i] = map[string]int{}
			a.targets[i] = map[string]int{}
		}
		if reasons[i] != "" {
			a.reasons[i][reasons[i]]++
		}
		if targets[i] != "" {
			a.targets[i][targets[i]]++
		}
	}
	a.replayCohort.add(p, available)
	if available[0] && available[1] && available[2] {
		a.seconds = append(a.seconds, seconds)
	}
}
func (a *replayScalarCohort) scalarMetrics(race bool) []ReplayScalarMetrics {
	old := a.metrics()
	seconds := metricsForPairs(a.seconds)
	out := make([]ReplayScalarMetrics, 3)
	for i, m := range old {
		out[i] = ReplayScalarMetrics{Strategy: m.Strategy, Available: m.Available, Missing: m.Missing, MissingCenter: a.missing[i], Unsupported: a.unsupported[i], ComputationFailures: a.failed[i], Coverage: m.Coverage, Reasons: a.reasons[i], PredictionTargets: a.targets[i], MedianAbsoluteError: m.MedianAbsoluteError, P90AbsoluteError: m.P90AbsoluteError, SignedBias: m.SignedBias}
		if a.activities > 0 {
			out[i].FailureRate = float64(a.failed[i]) / float64(a.activities)
		}
		if race {
			out[i].MedianAbsoluteErrorS, out[i].P90AbsoluteErrorS, out[i].SignedBiasS = seconds[i].MedianAbsoluteError, seconds[i].P90AbsoluteError, seconds[i].SignedBias
		}
	}
	return out
}

func scalarPrediction(v OfflineResult, family string, r *ReplayReference) (state, reason, target string, value float64) {
	target = v.Implementation
	if family == "race_prediction" {
		prediction := PredictOfflineRaceTime(v.Snapshot, r.DistanceM)
		if prediction.DurationS != nil {
			value = *prediction.DurationS
		}
		return prediction.State, prediction.Reason, target, value
	}
	center := v.Snapshot.ThresholdSpeedMps
	if family == "lab_lthr" || family == "field_hr_proxy" {
		center = v.Snapshot.ThresholdHR
		target = "legacy_training_estimate"
		if v.Strategy == StrategyCandidate {
			if v.Evidence == nil || v.Evidence.HR == nil {
				return "missing", "independent_HR_output_missing", "unavailable", 0
			}
			hr := v.Evidence.HR
			target = hr.TargetType + "/" + hr.ReferenceTier + "/" + hr.LabMethod
			if family == "lab_lthr" && (hr.ReferenceTier != "lab_lthr" || r.HRAudit == nil || hr.LabMethod != r.HRAudit.LabMethod) {
				return "unsupported", "lab_method_or_target_mismatch", target, 0
			}
			if family == "field_hr_proxy" && hr.ReferenceTier != "field_hr_proxy" {
				return "unsupported", "field_proxy_target_mismatch", target, 0
			}
		}
	}
	if center == nil {
		return "missing", "snapshot_center_missing", target, 0
	}
	if !candidateFinite(center) || *center <= 0 {
		return "failed", "invalid_snapshot_center", target, 0
	}
	value = *center
	if family == "direct_60min" {
		value = 1000 / value
	}
	if !finiteScalar(value) {
		return "failed", "nonfinite_prediction", target, 0
	}
	return "available", "", target, value
}

// EvaluateReplayOutcomes evaluates sealed, already-fitted results. It is the
// same pure scoring seam used by Replay; no second estimator or pipeline exists.
func EvaluateReplayOutcomes(m ReplayManifest, cases []ReplayCaseResult) ([]ReplayCohortEvaluation, []ReplayQualityCheck, error) {
	if err := validateReplay(m, "sealed-outcomes"); err != nil {
		return nil, nil, err
	}
	if len(cases) != len(m.Cases) {
		return nil, nil, fmt.Errorf("case result inventory mismatch")
	}
	expected := map[string]ReplayCase{}
	for _, c := range m.Cases {
		expected[c.ID] = c
	}
	seen := map[string]bool{}
	for _, r := range cases {
		c, ok := expected[r.ID]
		if !ok || seen[r.ID] || r.User != c.User || r.Mode != c.Mode || r.TargetRootActivityID != c.TargetRootActivityID || !r.PredictionAsOf.Equal(c.PredictionAsOf) {
			return nil, nil, fmt.Errorf("case result identity mismatch")
		}
		seen[r.ID] = true
		strategies := map[Strategy]bool{}
		for _, v := range r.Versions {
			if !validReplayStrategy(v.Strategy) || strategies[v.Strategy] {
				return nil, nil, fmt.Errorf("duplicate or unknown result strategy")
			}
			strategies[v.Strategy] = true
		}
		for strategy, reason := range r.Failures {
			if !validReplayStrategy(strategy) || strategies[strategy] || reason == "" || len(reason) > 128 {
				return nil, nil, fmt.Errorf("invalid isolated computation failure")
			}
			strategies[strategy] = true
		}
		if len(strategies) != 3 {
			return nil, nil, fmt.Errorf("three distinct strategy results or failures required")
		}
	}
	ordered := append([]ReplayCaseResult(nil), cases...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })
	cohorts, quality := evaluateReplayCohorts(m, ordered)
	return cohorts, quality, nil
}
func validReplayStrategy(s Strategy) bool {
	return s == StrategyV3 || s == StrategySegmentsOnly || s == StrategyCandidate
}

func evaluateReplayCohorts(m ReplayManifest, cases []ReplayCaseResult) ([]ReplayCohortEvaluation, []ReplayQualityCheck) {
	var out []ReplayCohortEvaluation
	var quality []ReplayQualityCheck
	targets := map[string]ReplayActivity{}
	for _, a := range m.Activities {
		if a.Reference != nil {
			targets[a.User+"/"+a.RootActivityID] = a
		}
	}
	for _, split := range []string{"validation", "final_holdout"} {
		for _, mode := range []string{"strict", "event_date_retrospective"} {
			for _, family := range []string{"direct_60min", "race_prediction", "lab_lthr", "field_hr_proxy"} {
				c := ReplayCohortEvaluation{Split: split, Mode: mode, Family: family, Unit: "bpm", RejectedLabels: map[string]int{}, SupportGrades: map[string]int{}, ImplementationsValid: true}
				if family == "direct_60min" {
					c.Unit = "s/km"
				}
				if family == "race_prediction" {
					c.Unit = "fraction"
				}
				var all replayScalarCohort
				strata := map[string]*replayScalarCohort{}
				required := requiredReplayStrata(m, family)
				for _, name := range required {
					strata[name] = &replayScalarCohort{}
				}
				seen := map[string]bool{}
				for _, result := range cases {
					if result.Mode != mode || result.TargetRootActivityID == "" {
						continue
					}
					key := result.User + "/" + result.TargetRootActivityID
					a, ok := targets[key]
					if !ok {
						c.RejectedLabels["target_reference_missing"]++
						continue
					}
					if a.Split != split {
						continue
					}
					r := a.Reference
					applies := r.Kind == family || r.HRGrade == family
					if !applies {
						continue
					}
					if seen[key] {
						c.RejectedLabels["duplicate_case_deduplicated"]++
						continue
					}
					seen[key] = true
					c.SupportGrades[r.EffortSupport]++
					observed, rejection := referenceValue(a, result, m, family)
					if rejection != "" {
						c.RejectedLabels[rejection]++
						continue
					}
					versions := map[Strategy]OfflineResult{}
					for _, v := range result.Versions {
						versions[v.Strategy] = v
					}
					p, seconds := pairedError{user: result.User}, pairedError{user: result.User}
					var states, reasons, targetNames [3]string
					for j, s := range replayStrategies {
						v, exists := versions[s]
						if failure := result.Failures[s]; failure != "" {
							states[j], reasons[j] = "failed", failure

							continue
						}
						if !exists {
							states[j], reasons[j] = "failed", "strategy_result_missing"
							c.ImplementationsValid = false
							continue
						}
						if !knownReplayImplementation(v) {
							c.ImplementationsValid = false
						}
						var value float64
						states[j], reasons[j], targetNames[j], value = scalarPrediction(v, family, r)
						if states[j] == "available" {
							p.errors[j] = value - observed
							seconds.errors[j] = p.errors[j]
							if family == "race_prediction" {
								p.errors[j] /= observed
							}
							if !finiteScalar(p.errors[j]) || !finiteScalar(seconds.errors[j]) {
								states[j], reasons[j] = "failed", "nonfinite_reference_derived_error"
								p.errors[j], seconds.errors[j] = 0, 0
							}
						}
					}
					all.addScalar(p, seconds, states, reasons, targetNames)
					for _, name := range replayStrata(a, family) {
						if strata[name] == nil {
							strata[name] = &replayScalarCohort{}
						}
						strata[name].addScalar(p, seconds, states, reasons, targetNames)
					}
				}
				c.EligibleActivities, c.EligibleUsers, c.PairedActivities, c.PairedUsers = all.activities, len(all.users), len(all.pairs), pairUsers(all.pairs)
				if c.PairedUsers > 0 {
					c.MaxUserWeight = 1 / float64(c.PairedUsers)
				}
				c.Versions = all.scalarMetrics(family == "race_prediction")
				if c.PairedUsers >= 2 && !syntheticReplay(m) {
					u := bootstrapPairs(all.pairs)
					c.Uncertainty = &ReplayScalarUncertainty{Method: u.Method, Unit: c.Unit, Seed: u.Seed, Resamples: u.Resamples, MedianCandidateMinusV3: u.MedianCandidateMinusV3, P90CandidateMinusV3: u.P90CandidateMinusV3}
				}
				names := make([]string, 0, len(strata))
				for name := range strata {
					names = append(names, name)
				}
				sort.Strings(names)
				for _, name := range names {
					a := strata[name]
					s := ReplayScalarStratum{Name: name, Required: containsString(required, name), EligibleActivities: a.activities, EligibleUsers: len(a.users), PairedActivities: len(a.pairs), PairedUsers: pairUsers(a.pairs), Versions: a.scalarMetrics(family == "race_prediction")}
					state := "insufficient"
					if s.PairedActivities >= 10 && s.PairedUsers >= 3 && !strings.Contains(name, "unknown") {
						state = "pass"
					}
					s.Gates = append(s.Gates, ReplayGate{ID: "strata." + name + ".sample", Status: state, Observed: []int{s.EligibleActivities, s.EligibleUsers, s.PairedActivities, s.PairedUsers}, Threshold: ">=10 paired activities/3 users; metadata known", Unit: "count", EligibleActivities: s.EligibleActivities, EligibleUsers: s.EligibleUsers, PairedActivities: s.PairedActivities, PairedUsers: s.PairedUsers})
					if family == "direct_60min" && state == "pass" {
						v3, candidate := s.Versions[0], s.Versions[2]
						dm, dp := *candidate.MedianAbsoluteError-*v3.MedianAbsoluteError, *candidate.P90AbsoluteError-*v3.P90AbsoluteError
						status := "pass"
						if dm > 1 || dp > 2 {
							status = "fail"
						}
						s.Gates = append(s.Gates, ReplayGate{ID: "strata." + name + ".regression", Status: status, Observed: []float64{dm, dp}, Threshold: "median delta <=1, P90 delta <=2", Unit: "s/km", EligibleActivities: s.EligibleActivities, EligibleUsers: s.EligibleUsers, PairedActivities: s.PairedActivities, PairedUsers: s.PairedUsers})
					}
					s.Status = gateReduction(s.Gates)
					c.Strata = append(c.Strata, s)
				}
				c.Gates = EvaluateReplayGates(c)
				c.Status = gateReduction(c.Gates)
				out = append(out, c)
			}
		}
	}
	// These references are only descriptive quality/constraint checks, never labels.
	for _, result := range cases {
		a, ok := targets[result.User+"/"+result.TargetRootActivityID]
		if !ok {
			continue
		}
		r := a.Reference
		if r.Kind == "constraint_only" {
			quality = append(quality, replayConstraintCheck(result, a, m))
		}
		if r.HRGrade == "training_hr" {
			quality = append(quality, replayTrainingHRCheck(result, a, m))
		}
	}
	return out, quality
}

func containsString(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}
func requiredReplayStrata(m ReplayManifest, family string) []string {
	names := map[string]bool{}
	if family == "direct_60min" {
		for _, s := range []string{"gps_clean", "gps_abnormal", "continuous", "pause_recovery", "quality_sparse", "quality_sufficient", "distance:direct_60min"} {
			names[s] = true
		}
	}
	if family == "race_prediction" {
		names["distance:other"] = true
		for _, a := range m.Activities {
			if a.Reference != nil && a.Reference.Kind == family {
				names["distance:"+ftoa(a.Reference.DistanceM)+"m"] = true
			}
		}
	}
	for _, a := range m.Activities {
		if a.Reference == nil || (a.Reference.Kind != family && a.Reference.HRGrade != family) {
			continue
		}
		if family == "lab_lthr" {
			if a.Reference != nil && a.Reference.HRGrade == family {
				method := "unknown"
				if a.Reference.HRAudit != nil && a.Reference.HRAudit.LabMethod != "" {
					method = a.Reference.HRAudit.LabMethod
				}
				names["lab_method:"+method] = true
			}
		} else {
			device := a.Device
			if device == "" {
				device = "unknown"
			}
			names["device:"+device] = true
		}
	}
	if len(names) == 0 {
		names["metadata:unknown"] = true
	}
	for _, s := range m.RequiredStrata {
		names[s] = true
	}
	out := make([]string, 0, len(names))
	for name := range names {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}
func replayStrata(a ReplayActivity, family string) []string {
	names := map[string]bool{}
	device := a.Device
	if device == "" {
		device = "unknown"
	}
	names["device:"+device] = true
	for _, s := range a.Scenarios {
		names[s] = true
	}
	if family == "direct_60min" {
		names["distance:direct_60min"] = true
		for _, axis := range [][3]string{{"gps_clean", "gps_abnormal", "gps:unknown"}, {"continuous", "pause_recovery", "continuity:unknown"}, {"quality_sparse", "quality_sufficient", "quality:unknown"}} {
			if !names[axis[0]] && !names[axis[1]] {
				names[axis[2]] = true
			}
		}
	}
	if family == "race_prediction" {
		names["distance:other"] = true
		distance := "distance:" + ftoa(a.Reference.DistanceM) + "m"
		names[distance] = true
	}
	if family == "lab_lthr" {
		method := "unknown"
		if a.Reference.HRAudit != nil && a.Reference.HRAudit.LabMethod != "" {
			method = a.Reference.HRAudit.LabMethod
		}
		names["lab_method:"+method] = true
	}
	out := make([]string, 0, len(names))
	for name := range names {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func replayTrainingHRCheck(c ReplayCaseResult, a ReplayActivity, m ReplayManifest) ReplayQualityCheck {
	check := ReplayQualityCheck{CaseID: c.ID, Family: "training_hr", Status: "insufficient", Reason: "quality_only_not_independent_accuracy_label"}
	if !qualityReferenceObserved(c, a, m) {
		check.Reason = "reference_not_available_at_report"
		return check
	}
	points, bad := candidateHRPoints(a.Activity)
	if len(points) >= 2 {
		_, q := measureCandidateHR(points, points[0].t, points[len(points)-1].t)
		check.Coverage = &q.Coverage
		check.MaxGapS = &q.MaxGapS
		if !bad {
			check.Status = "descriptive"
		}
	}
	for _, v := range c.Versions {
		if v.Strategy == StrategyCandidate && v.Evidence != nil && v.Evidence.HR != nil && v.Evidence.HR.DependsOnPace {
			check.Status = "failed"
			check.Reason = "candidate_HR_circular_pace_dependency"
		}
	}
	return check
}
func replayConstraintCheck(c ReplayCaseResult, a ReplayActivity, m ReplayManifest) ReplayQualityCheck {
	check := ReplayQualityCheck{CaseID: c.ID, Family: "constraint_only", Status: "descriptive", Reason: "same_duration_constraint_only_not_accuracy_label", Strategies: map[Strategy]string{}}
	r := a.Reference
	if !qualityReferenceObserved(c, a, m) {
		check.Status = "insufficient"
		check.Reason = "reference_not_available_at_report"
		check.Strategies = nil
		return check
	}
	for _, v := range c.Versions {
		state := "insufficient_measurement_error_or_model"
		if r.DurationS > 7200 {
			state = "long_duration_monotonic_soft_constraint_no_precise_extrapolation"
		} else if r.DurationS >= 180 && r.DistanceM > 0 && candidateFinite(r.MeasurementRelativeError) && *r.MeasurementRelativeError >= 0 && *r.MeasurementRelativeError <= 1 && candidateFinite(v.Snapshot.ThresholdSpeedMps) && candidateFinite(v.Snapshot.RiegelK) {
			speed := *v.Snapshot.ThresholdSpeedMps * math.Pow(r.DurationS/3600, -*v.Snapshot.RiegelK)
			state = "compatible"
			if speed < r.DistanceM/r.DurationS*(1-*r.MeasurementRelativeError) {
				state = "conflict"
			}
		}
		check.Strategies[v.Strategy] = state
	}
	return check
}

func knownReplayImplementation(v OfflineResult) bool {
	switch v.Strategy {
	case StrategyV3:
		return v.Implementation == "v3" && v.ParameterVersion == "v3-frozen"
	case StrategySegmentsOnly:
		return v.Implementation == segmentsImplementation && v.ParameterVersion == segmentsParameterVersion
	case StrategyCandidate:
		return v.Implementation == hourImplementation+"+independent_hr_v1" && v.ParameterVersion == hourParameterVersion+"+"+hrParameterVersion
	}
	return false
}

func qualityReferenceObserved(c ReplayCaseResult, a ReplayActivity, m ReplayManifest) bool {
	r := a.Reference
	return r != nil && r.AvailableAt != nil && !r.AvailableAt.After(m.AsOf) && !r.AvailableAt.Before(a.EventTime) && !a.EventTime.After(m.AsOf) && a.EventTime.After(c.PredictionAsOf) && a.Split != "train"
}
