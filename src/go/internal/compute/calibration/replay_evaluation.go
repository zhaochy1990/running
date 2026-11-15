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
	Name             string          `json:"name"`
	Status           string          `json:"status"`
	Activities       int             `json:"activities"` // All eligible independent targets.
	Users            int             `json:"users"`      // Users with eligible targets.
	PairedActivities int             `json:"paired_activities"`
	PairedUsers      int             `json:"paired_users"`
	Versions         []ReplayMetrics `json:"versions"`
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
}

// Coverage counts every eligible target; errors use only the three-way paired
// intersection. The same cohort rules apply overall and within each stratum.
type replayCohort struct {
	activities int
	users      map[string]bool
	available  [3]int
	pairs      []pairedError
}

func (cohort *replayCohort) add(p pairedError, available [3]bool) {
	cohort.activities++
	if cohort.users == nil {
		cohort.users = map[string]bool{}
	}
	cohort.users[p.user] = true
	all := true
	for i, present := range available {
		if present {
			cohort.available[i]++
		} else {
			all = false
		}
	}
	if all {
		cohort.pairs = append(cohort.pairs, p)
	}
}

func (cohort *replayCohort) metrics() []ReplayMetrics {
	out := metricsForPairs(cohort.pairs)
	for i := range out {
		out[i].Available = cohort.available[i]
		out[i].Missing = cohort.activities - cohort.available[i]
		if cohort.activities > 0 {
			out[i].Coverage = float64(cohort.available[i]) / float64(cohort.activities)
		}
	}
	return out
}

func legacyReplayEvaluation(cohorts []ReplayCohortEvaluation, split string) ReplayEvaluation {
	out := ReplayEvaluation{Status: "insufficient"}
	for _, c := range cohorts {
		if c.Split != split || c.Mode != "strict" {
			continue
		}
		if c.Family != "direct_60min" {
			continue
		}
		out.Status, out.EligibleActivities, out.PairedActivities, out.Users = c.Status, c.EligibleActivities, c.PairedActivities, c.PairedUsers
		out.Versions = legacyMetrics(c.Versions)
		for _, n := range c.RejectedLabels {
			out.RejectedLabels += n
		}
		for _, s := range c.Strata {
			out.Strata = append(out.Strata, ReplayStratum{Name: s.Name, Status: s.Status, Activities: s.EligibleActivities, Users: s.EligibleUsers, PairedActivities: s.PairedActivities, PairedUsers: s.PairedUsers, Versions: legacyMetrics(s.Versions)})
		}
		if c.Uncertainty != nil {
			u := c.Uncertainty
			out.Uncertainty = &ReplayUncertainty{Method: u.Method, Seed: u.Seed, Resamples: u.Resamples, MedianCandidateMinusV3: u.MedianCandidateMinusV3, P90CandidateMinusV3: u.P90CandidateMinusV3}
		}
	}
	return out
}
func legacyMetrics(metrics []ReplayScalarMetrics) []ReplayMetrics {
	out := make([]ReplayMetrics, 0, len(metrics))
	for _, v := range metrics {
		out = append(out, ReplayMetrics{Strategy: v.Strategy, Available: v.Available, Missing: v.Missing, ComputationFailures: v.ComputationFailures, Coverage: v.Coverage, FailureRate: v.FailureRate, MedianAbsoluteError: v.MedianAbsoluteError, P90AbsoluteError: v.P90AbsoluteError, SignedBias: v.SignedBias})
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
		metric := ReplayMetrics{Strategy: strategy}
		if len(pairs) > 0 {
			weighted := make([][2]float64, 0, len(pairs))
			scale := 0.0
			for _, p := range pairs {
				w := 1 / float64(len(counts)*counts[p.user])
				weighted = append(weighted, [2]float64{math.Abs(p.errors[j]), w})
				scale = math.Max(scale, math.Abs(p.errors[j]))
			}
			// Scale before summing: finite individual errors near MaxFloat must
			// not overflow an otherwise bounded weighted mean. Normalize by the
			// actual compensated weight sum, preserving each user's equal weight.
			scaled, scaledCorrection, total, totalCorrection := 0.0, 0.0, 0.0, 0.0
			if scale > 0 {
				for _, p := range pairs {
					w := 1 / float64(len(counts)*counts[p.user])
					addCompensated(&scaled, &scaledCorrection, (p.errors[j]/scale)*w)
					addCompensated(&total, &totalCorrection, w)
				}
			}
			bias := 0.0
			if scale > 0 {
				relative := scaled / total
				relative = math.Max(-1, math.Min(1, relative))
				bias = scale * relative
			}
			median, p90 := errorQuantile(weighted, 0.5), errorQuantile(weighted, 0.9)
			metric.MedianAbsoluteError = &median
			metric.P90AbsoluteError = &p90
			metric.SignedBias = &bias
		}
		out[j] = metric
	}
	return out
}

func errorQuantile(values [][2]float64, q float64) float64 {
	ordered := append([][2]float64(nil), values...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i][0] < ordered[j][0] })
	// Compensated sums preserve the frozen empirical boundary when one user
	// contributes many tiny activity weights (e.g. 100 x .001 vs 9 x .1).
	sum, correction := 0.0, 0.0
	for _, v := range ordered {
		addCompensated(&sum, &correction, v[1])
	}
	cumulative, correction := 0.0, 0.0
	for _, v := range ordered {
		addCompensated(&cumulative, &correction, v[1])
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

func addCompensated(sum, correction *float64, value float64) {
	y := value - *correction
	t := *sum + y
	*correction = (t - *sum) - y
	*sum = t
}
