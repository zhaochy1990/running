package calibration

import (
	"math"
	"math/rand"
	"sort"
)

type ReplayEvaluation struct {
	Status                string             `json:"status"`
	EligibleActivities    int                `json:"eligible_activities"`
	PairedActivities      int                `json:"paired_activities"`
	Users                 int                `json:"users"`
	UnsupportedRaceLabels int                `json:"unsupported_race_labels"`
	UnsupportedHRLabels   int                `json:"unsupported_hr_labels"`
	RejectedLabels        int                `json:"rejected_or_unavailable_labels"`
	Versions              []ReplayMetrics    `json:"versions"`
	Strata                []ReplayStratum    `json:"strata"`
	Uncertainty           *ReplayUncertainty `json:"uncertainty"`
}

type ReplayMetrics struct {
	ComputationFailures int      `json:"computation_failures"`
	FailureRate         float64  `json:"failure_rate"`
	Strategy            Strategy `json:"strategy"`
	Available           int      `json:"available"`
	Missing             int      `json:"missing"`
	Coverage            float64  `json:"coverage"`
	MedianAbsoluteError *float64 `json:"median_absolute_error_s_per_km"`
	P90AbsoluteError    *float64 `json:"p90_absolute_error_s_per_km"`
	SignedBias          *float64 `json:"signed_bias_s_per_km"`
}

type ReplayStratum struct {
	Name       string          `json:"name"`
	Status     string          `json:"status"`
	Activities int             `json:"activities"`
	Users      int             `json:"users"`
	Versions   []ReplayMetrics `json:"versions"`
}

type ReplayUncertainty struct {
	Method                 string     `json:"method"`
	Seed                   int64      `json:"seed"`
	Resamples              int        `json:"resamples"`
	MedianCandidateMinusV3 [2]float64 `json:"median_candidate_minus_v3_s_per_km"`
	P90CandidateMinusV3    [2]float64 `json:"p90_candidate_minus_v3_s_per_km"`
}

type pairedError struct {
	user   string
	errors [3]float64
	strata []string
}

func evaluateReplay(m ReplayManifest, cases []ReplayCaseResult, split string) ReplayEvaluation {
	out := ReplayEvaluation{Status: "insufficient"}
	var pairs []pairedError
	var availableCounts [3]int
	seen := map[string]bool{}
	for _, c := range cases {
		// Retrospective estimates are never pooled into strict historical evidence.
		if c.Mode != "strict" || c.TargetRootActivityID == "" {
			continue
		}
		key := c.User + "/" + c.TargetRootActivityID
		if seen[key] {
			continue
		}
		seen[key] = true
		var target *ReplayActivity
		for i := range m.Activities {
			a := &m.Activities[i]
			if a.User == c.User && a.RootActivityID == c.TargetRootActivityID && a.Reference != nil {
				target = a
				break
			}
		}
		if target == nil || target.Split != split {
			continue
		}
		ref := target.Reference
		if ref.HRGrade != "" {
			out.UnsupportedHRLabels++
		}
		if ref.Kind == "race_prediction" {
			out.UnsupportedRaceLabels++
			continue
		}
		if ref.Kind != "direct_60min" || !ref.Real || ref.EffortSupport != "confirmed_maximal" || ref.MeasurementQuality != "high" || ref.EvidenceRef == "" || ref.Protocol != "continuous_60min_v1" || ref.DurationS != 3600 || ref.DistanceM <= 0 || ref.AvailableAt == nil || ref.AvailableAt.After(m.AsOf) || target.EventTime.After(m.AsOf) || !target.EventTime.After(c.PredictionAsOf) || target.Split == "train" {
			out.RejectedLabels++
			continue
		}
		out.EligibleActivities++
		observation := 1000 * ref.DurationS / ref.DistanceM
		p := pairedError{user: c.User, strata: append([]string{"device:" + target.Device}, target.Scenarios...)}
		all := len(c.Versions) == 3
		for j, v := range c.Versions {
			speed := v.Snapshot.ThresholdSpeedMps
			if speed == nil || *speed <= 0 || math.IsNaN(*speed) || math.IsInf(*speed, 0) {
				all = false
				continue
			}
			availableCounts[j]++
			p.errors[j] = 1000/(*speed) - observation
		}
		if all {
			pairs = append(pairs, p)
		}
	}
	out.PairedActivities = len(pairs)
	out.Users = pairUsers(pairs)
	out.Versions = metricsForPairs(pairs)
	for i := range out.Versions {
		v := &out.Versions[i]
		v.Available = availableCounts[i]
		v.Missing = out.EligibleActivities - v.Available
		if out.EligibleActivities > 0 {
			v.Coverage = float64(v.Available) / float64(out.EligibleActivities)
		}
	}
	names := map[string]bool{}
	for _, p := range pairs {
		for _, s := range p.strata {
			names[s] = true
		}
	}
	ordered := make([]string, 0, len(names))
	for s := range names {
		ordered = append(ordered, s)
	}
	sort.Strings(ordered)
	for _, name := range ordered {
		var selected []pairedError
		for _, p := range pairs {
			for _, s := range p.strata {
				if s == name {
					selected = append(selected, p)
					break
				}
			}
		}
		out.Strata = append(out.Strata, ReplayStratum{Name: name, Status: "insufficient", Activities: len(selected), Users: pairUsers(selected), Versions: metricsForPairs(selected)})
	}
	if len(pairs) > 0 && out.Users >= 2 {
		out.Uncertainty = bootstrapPairs(pairs)
	}
	return out
}

func pairUsers(pairs []pairedError) int {
	users := map[string]bool{}
	for _, p := range pairs {
		users[p.user] = true
	}
	return len(users)
}

func metricsForPairs(pairs []pairedError) []ReplayMetrics {
	strategies := []Strategy{StrategyV3, StrategySegmentsOnly, StrategyCandidate}
	counts := map[string]int{}
	for _, p := range pairs {
		counts[p.user]++
	}
	out := make([]ReplayMetrics, 3)
	for j, strategy := range strategies {
		metric := ReplayMetrics{Strategy: strategy, Available: len(pairs)}
		if len(pairs) > 0 {
			weighted := make([][2]float64, 0, len(pairs))
			bias := 0.0
			for _, p := range pairs {
				w := 1 / float64(len(counts)*counts[p.user])
				weighted = append(weighted, [2]float64{math.Abs(p.errors[j]), w})
				bias += p.errors[j] * w
			}
			median, p90 := errorQuantile(weighted, 0.5), errorQuantile(weighted, 0.9)
			metric.MedianAbsoluteError = &median
			metric.P90AbsoluteError = &p90
			metric.SignedBias = &bias
			metric.Coverage = 1
		}
		out[j] = metric
	}
	return out
}

func errorQuantile(values [][2]float64, q float64) float64 {
	ordered := append([][2]float64(nil), values...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i][0] < ordered[j][0] })
	sum := 0.0
	for _, v := range ordered {
		sum += v[1]
	}
	cumulative := 0.0
	for _, v := range ordered {
		cumulative += v[1]
		if cumulative >= q*sum {
			return v[0]
		}
	}
	return ordered[len(ordered)-1][0]
}

func bootstrapPairs(pairs []pairedError) *ReplayUncertainty {
	const seed int64 = 983984
	const resamples = 2000
	groups := map[string][]pairedError{}
	for _, p := range pairs {
		groups[p.user] = append(groups[p.user], p)
	}
	users := make([]string, 0, len(groups))
	for u := range groups {
		users = append(users, u)
	}
	sort.Strings(users)
	rng := rand.New(rand.NewSource(seed))
	medians, p90s := make([]float64, resamples), make([]float64, resamples)
	for n := 0; n < resamples; n++ {
		// A resampled user's whole activity group receives one user's total weight.
		var errors [3][][2]float64
		for range users {
			selected := groups[users[rng.Intn(len(users))]]
			weight := 1 / float64(len(users)*len(selected))
			for _, p := range selected {
				for j := 0; j < 3; j++ {
					errors[j] = append(errors[j], [2]float64{math.Abs(p.errors[j]), weight})
				}
			}
		}
		medians[n] = errorQuantile(errors[2], 0.5) - errorQuantile(errors[0], 0.5)
		p90s[n] = errorQuantile(errors[2], 0.9) - errorQuantile(errors[0], 0.9)
	}
	sort.Float64s(medians)
	sort.Float64s(p90s)
	return &ReplayUncertainty{Method: "user_cluster_percentile_95", Seed: seed, Resamples: resamples, MedianCandidateMinusV3: [2]float64{medians[49], medians[1949]}, P90CandidateMinusV3: [2]float64{p90s[49], p90s[1949]}}
}
