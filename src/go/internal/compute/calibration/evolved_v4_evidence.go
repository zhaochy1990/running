package calibration

import (
	"math"
	"sort"
	"time"
)

// evolved_v4_evidence.go implements docs/calibration/v4.md §3 for the rev3
// evolved v4: the three evidence roles (trusted_bound / model_observation /
// excluded), the 60-day current window with the 180-day audit pool, the
// per-bucket frontier pool (trusted layer first, top-3 fastest independent
// days at >= 97% of the layer's fastest, one window per activity per bucket)
// and the trusted constraint set that feeds the §4 hard floor. All durations
// are the candidates' real durations — nothing is relabeled.

const (
	// v4CurrentWindowDays: §3.3 current constraint/fit window (Shanghai
	// activity day, inclusive of day 60).
	v4CurrentWindowDays = 60
	// v4AuditWindowDays: 180-day audit retention (mirrors the pool builder).
	v4AuditWindowDays = 180
	// v4FrontierPerBucketDays: top-3 fastest independent days per bucket+layer.
	v4FrontierPerBucketDays = 3
	// v4FrontierSpeedRatio: a selected window must be >= 97% of its layer's
	// fastest in-window speed.
	v4FrontierSpeedRatio = 0.97
	// v4MinModelDurationS: §5.2 power-law applicable domain starts at 180 s.
	v4MinModelDurationS = 180.0
	// v4LongDomainS: durations above two hours enter only the monotone
	// envelope constraint, never the precise-duration loss.
	v4LongDomainS = 7200.0
	// v4MaxPlausibleSpeedMps keeps the cleaner's plausibility ceiling.
	v4MaxPlausibleSpeedMps = 8.5
)

// v4 buckets: the seven frozen V3 best-effort buckets plus the actually
// supportable 90/120-minute windows (§2: "另外提取实际可支持的 90/120 分钟与
// 更长连续表现"). Durations beyond 7200 s form the long-performance group.
var v4BucketDurationsS = []float64{180, 300, 600, 1200, 1800, 2700, 3600, 4500, 5400, 7200}

// v4EvidenceRole is the §3.2 three-role evidence layering.
type v4EvidenceRole string

const (
	v4RoleTrustedBound     v4EvidenceRole = "trusted_bound"
	v4RoleModelObservation v4EvidenceRole = "model_observation"
	v4RoleExcluded         v4EvidenceRole = "excluded"
)

// v4Observation is one auditable candidate row carrying its §3 role, real
// duration, layer weights and the §5.1 margin-class inputs.
type v4Observation struct {
	ActivityID   string
	Root         string
	Day          string
	Date         time.Time
	AgeDays      float64
	DurationS    float64
	AvgSpeedMps  float64
	Y            float64 // log(AvgSpeedMps)
	X            float64 // log(min(DurationS,7200)/3600)
	Bucket       float64 // retrieval bucket; 0 for the >7200 long group
	Long         bool    // DurationS > 7200
	Role         v4EvidenceRole
	Quality      Confidence
	Effort       EffortSupport
	Source       string
	FullActivity bool
	// Excluded reasons (role == excluded only).
	ExclusionReasons []string
	// Fit-pool fields (§5.2 weights); zero outside the pool.
	Weight        float64
	DayWeight     float64
	Selected      bool
	SelectionNote string
}

// v4EvidenceSet is the §3 output: role-assigned observations, the frontier
// fit pool, the trusted constraint rows and the separately retained verified
// all-out references (§3.3).
type v4EvidenceSet struct {
	Rows []v4Observation
	// WindowDays: the current-window length this set was built with (60 for
	// the main solve; 180 for the §7 stale rebuild).
	WindowDays int
	// Pool: frontier-pool rows in model domain (index into Rows).
	Pool []int
	// TrustedConstraintIdx: all trusted in-window rows (in-domain + long),
	// pool members or not — §3.3 "所有可信近期表现都参与约束检查".
	TrustedConstraintIdx []int
	// VerifiedReferenceIdx: separately retained verified (protocol-confirmed
	// or probable) all-out rows among the trusted layer.
	VerifiedReferenceIdx []int
	// Excluded counts keyed by the primary reason.
	Excluded map[string]int
	// FrontierFastestByBucket: layer fastest speed per bucket (trusted layer
	// preferred), for the 97% gate audit.
	FrontierFastestByBucket map[float64]float64
}

// v4ConditionsComparable applies §3.2: only *known* assist/bias evidence
// (明显助力下坡、持续顺风、设备偏差、跑台标定差异) demotes a row from the
// comparable group; missing weather alone never demotes a road result, and the
// reference scene is the user's own recent outdoor road conditions. The
// marker vocabulary is minimal and additive-only.
func v4ConditionsComparable(terrain, device string) bool {
	for _, marker := range []string{"treadmill", "downhill_assist", "assisted_descent", "tailwind", "headwind_free", "device_bias", "calibration_bias"} {
		if containsFold(terrain, marker) || containsFold(device, marker) {
			return false
		}
	}
	return true
}

func containsFold(s, sub string) bool {
	if len(s) < len(sub) || sub == "" {
		return false
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		match := true
		for j := 0; j < len(sub); j++ {
			a, b := s[i+j], sub[j]
			if 'A' <= a && a <= 'Z' {
				a += 'a' - 'A'
			}
			if 'A' <= b && b <= 'Z' {
				b += 'a' - 'A'
			}
			if a != b {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// v4NearestBucket maps a real duration onto its retrieval bucket; durations
// beyond 7200 s return 0 (the long-performance group, bucketed per activity).
func v4NearestBucket(durationS float64) float64 {
	if durationS > v4LongDomainS {
		return 0
	}
	best, bestDiff := v4BucketDurationsS[0], math.Abs(v4BucketDurationsS[0]-durationS)
	for _, d := range v4BucketDurationsS[1:] {
		if diff := math.Abs(d - durationS); diff < bestDiff {
			best, bestDiff = d, diff
		}
	}
	return best
}

// assignV4Role applies the §3.2 admission rules to one cleaned candidate row.
func assignV4Role(e CandidateEvidence, rootConflict bool) (v4EvidenceRole, []string) {
	reasons := []string{}
	switch {
	case !candidateFinite(&e.AvgSpeedMps) || math.IsNaN(e.AvgSpeedMps) || math.IsInf(e.AvgSpeedMps, 0):
		return v4RoleExcluded, append(reasons, "nonfinite_speed")
	case !(e.AvgSpeedMps > 0 && e.AvgSpeedMps <= v4MaxPlausibleSpeedMps):
		return v4RoleExcluded, append(reasons, "implausible_speed")
	case !candidateFinite(&e.DurationS) || math.IsNaN(e.DurationS) || math.IsInf(e.DurationS, 0) || e.DurationS <= 0:
		return v4RoleExcluded, append(reasons, "invalid_duration")
	case e.ActivityDate.IsZero() || e.RootActivityID == "" && e.ActivityID == "":
		return v4RoleExcluded, append(reasons, "identity_missing")
	case rootConflict:
		// Unresolvable channel/root contradictions stay excluded from the
		// solve but are retained with their reason (§3.2 excluded).
		return v4RoleExcluded, append(reasons, "root_activity_day_conflict")
	}
	// Sub-180 s rows keep a measurement role (a complete measurement at its
	// real duration is still a fact) but never enter the power-law pool or
	// constraints — §4.2 constrains only the 180–7200 s domain plus the
	// >7200 s monotone envelope.
	// trusted_bound: complete continuous measurement (full time coverage —
	// summary-only integrations never qualify, whatever their quality label),
	// measurement quality at least medium, no unresolved conflicts, and no
	// known non-comparable condition evidence.
	if e.Continuous &&
		candidateConfidenceRank(e.MeasurementQuality) >= candidateConfidenceRank(ConfidenceMedium) &&
		v4ConditionsComparable(e.Terrain, e.Device) {
		return v4RoleTrustedBound, reasons
	}
	// Everything with a legal speed/duration that cannot fully verify
	// coverage, continuity or conditions stays a wide-error observation.
	demotions := []string{}
	if !e.Continuous {
		demotions = append(demotions, "time_coverage_not_continuous")
	}
	if candidateConfidenceRank(e.MeasurementQuality) < candidateConfidenceRank(ConfidenceMedium) {
		demotions = append(demotions, "measurement_quality_below_medium")
	}
	if !v4ConditionsComparable(e.Terrain, e.Device) {
		demotions = append(demotions, "conditions_not_comparable")
	}
	return v4RoleModelObservation, demotions
}

// BuildV4Evidence assembles the §3 evidence set from the cleaned candidate
// pool (selection, cleaning and pause handling stay upstream in
// buildCandidateEvidence; §2 处置表 reuses candidate-segments-v1 verbatim)
// using the 60-day current window.
func BuildV4Evidence(evidence []CandidateEvidence, asOf time.Time) v4EvidenceSet {
	return buildV4Evidence(evidence, asOf, v4CurrentWindowDays)
}

// buildV4Evidence with an explicit current-window length (the §7 stale
// rebuild passes the 180-day audit window).
func buildV4Evidence(evidence []CandidateEvidence, asOf time.Time, windowDays int) v4EvidenceSet {
	out := v4EvidenceSet{Excluded: map[string]int{}, FrontierFastestByBucket: map[float64]float64{}, WindowDays: windowDays}
	conflicts := conflictingCandidateRootDays(evidence)
	ordered := append([]CandidateEvidence(nil), evidence...)
	sort.Slice(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		if candidateRootID(a) != candidateRootID(b) {
			return candidateRootID(a) < candidateRootID(b)
		}
		if a.DurationS != b.DurationS {
			return a.DurationS < b.DurationS
		}
		if a.ActivityID != b.ActivityID {
			return a.ActivityID < b.ActivityID
		}
		return ReplayContentHash(a) < ReplayContentHash(b)
	})
	for i := range ordered {
		e := &ordered[i]
		root := candidateRootID(*e)
		age := float64(dayDiff(asOf, e.ActivityDate))
		if age < 0 {
			age = 0
		}
		role, reasons := assignV4Role(*e, conflicts[root])
		row := v4Observation{
			ActivityID: e.ActivityID, Root: root, Day: e.ActivityDate.Format("2006-01-02"),
			Date: e.ActivityDate, AgeDays: age, DurationS: e.DurationS, AvgSpeedMps: e.AvgSpeedMps,
			Y: math.Log(e.AvgSpeedMps), X: math.Log(math.Min(e.DurationS, v4LongDomainS) / 3600),
			Bucket: v4NearestBucket(e.DurationS), Long: e.DurationS > v4LongDomainS,
			Role: role, Quality: e.MeasurementQuality, Effort: e.EffortSupport, Source: e.Source,
			FullActivity: e.FullActivity, ExclusionReasons: reasons,
		}
		if role == v4RoleExcluded {
			for _, r := range reasons {
				out.Excluded[r]++
			}
			out.Rows = append(out.Rows, row)
			continue
		}
		// Audit-window rows keep their role for audit but never enter the
		// current solve (§3.3: 61–180 天保留为历史能力和敏感性分析).
		if age > float64(v4AuditWindowDays) {
			row.SelectionNote = "outside_audit_window"
			out.Rows = append(out.Rows, row)
			continue
		}
		idx := len(out.Rows)
		if age > float64(windowDays) {
			row.SelectionNote = "audit_window_only"
		} else if role == v4RoleTrustedBound {
			// All trusted in-window rows constrain the solve (§3.3), pool
			// member or not.
			out.TrustedConstraintIdx = append(out.TrustedConstraintIdx, idx)
			if e.EffortSupport == EffortConfirmedMaximal || e.EffortSupport == EffortProbableMaximal {
				out.VerifiedReferenceIdx = append(out.VerifiedReferenceIdx, idx)
			}
		}
		out.Rows = append(out.Rows, row)
	}
	buildV4FrontierPool(&out)
	return out
}

// buildV4FrontierPool applies §3.3: per bucket, trusted layer first; up to 3
// fastest independent in-window days at >= 97% of the layer's fastest; only
// buckets without any trusted candidate fall to the model_observation layer
// (same rule, at-least-low error scale downstream). One window per activity
// per bucket; weak fast summaries never define the trusted layer's gate.
func buildV4FrontierPool(out *v4EvidenceSet) {
	type key struct {
		bucket float64
		layer  v4EvidenceRole
	}
	groups := map[key][]int{}
	for i := range out.Rows {
		r := &out.Rows[i]
		if r.Role == v4RoleExcluded || r.AgeDays > float64(out.WindowDays) || r.Long {
			continue
		}
		if r.DurationS < v4MinModelDurationS {
			continue
		}
		groups[key{r.Bucket, r.Role}] = append(groups[key{r.Bucket, r.Role}], i)
	}
	buckets := make([]float64, 0, len(v4BucketDurationsS))
	buckets = append(buckets, v4BucketDurationsS...)
	for _, bucket := range buckets {
		trusted := groups[key{bucket, v4RoleTrustedBound}]
		layer, rows := v4RoleTrustedBound, trusted
		if len(rows) == 0 {
			layer, rows = v4RoleModelObservation, groups[key{bucket, v4RoleModelObservation}]
		}
		if len(rows) == 0 {
			continue
		}
		// One window per activity per bucket: keep each activity's fastest.
		byActivity := map[string]int{}
		for _, i := range rows {
			if prior, ok := byActivity[out.Rows[i].ActivityID]; !ok || out.Rows[i].AvgSpeedMps > out.Rows[prior].AvgSpeedMps {
				byActivity[out.Rows[i].ActivityID] = i
			}
		}
		uniq := make([]int, 0, len(byActivity))
		for _, i := range byActivity {
			uniq = append(uniq, i)
		}
		sort.Slice(uniq, func(a, b int) bool {
			i, j := uniq[a], uniq[b]
			if out.Rows[i].AvgSpeedMps != out.Rows[j].AvgSpeedMps {
				return out.Rows[i].AvgSpeedMps > out.Rows[j].AvgSpeedMps
			}
			return out.Rows[i].ActivityID < out.Rows[j].ActivityID
		})
		fastest := out.Rows[uniq[0]].AvgSpeedMps
		out.FrontierFastestByBucket[bucket] = fastest
		// Fastest up to 3 independent days at >= 97% of the layer fastest.
		selectedDays := map[string]bool{}
		for _, i := range uniq {
			r := &out.Rows[i]
			if r.AvgSpeedMps < v4FrontierSpeedRatio*fastest {
				break
			}
			if len(selectedDays) >= v4FrontierPerBucketDays {
				break
			}
			if selectedDays[r.Day] {
				continue
			}
			selectedDays[r.Day] = true
			r.Selected = true
			r.SelectionNote = "frontier_pool_" + string(layer)
			out.Pool = append(out.Pool, i)
		}
	}
	sort.Ints(out.Pool)
}

// AssignV4Weights applies §5.2 day weights over the frontier pool: D selected
// independent days, W_j = D*2^(-age_j/30) / sum_d 2^(-age_d/30); within a day
// the weight splits equally across activity roots and within a root across
// its selected windows. Weights are invariant to adding unselected rows.
func AssignV4Weights(rows []v4Observation, pool []int) {
	if len(pool) == 0 {
		return
	}
	dayFactor := map[string]float64{}
	dayRoots := map[string]map[string]bool{}
	rootWindows := map[string]int{}
	days := map[string]bool{}
	for _, i := range pool {
		r := &rows[i]
		days[r.Day] = true
		// All rows of one Shanghai day share the day's age factor; the day
		// enters the normalization exactly once.
		dayFactor[r.Day] = math.Exp2(-r.AgeDays / 30)
		if dayRoots[r.Day] == nil {
			dayRoots[r.Day] = map[string]bool{}
		}
		dayRoots[r.Day][r.Root] = true
		rootWindows[r.Root+"\x00"+r.Day]++
	}
	// A root with windows on multiple selected days splits its day share per
	// day (the day share is what matters: w_i = W_j / roots_on_day_j /
	// windows_of_root_on_day_j).
	total := 0.0
	dayList := make([]string, 0, len(days))
	for d := range days {
		dayList = append(dayList, d)
	}
	sort.Strings(dayList)
	for _, d := range dayList {
		total += dayFactor[d]
	}
	if total <= 0 {
		return
	}
	D := float64(len(dayList))
	for _, i := range pool {
		r := &rows[i]
		Wj := D * dayFactor[r.Day] / total
		r.DayWeight = Wj
		r.Weight = Wj / float64(len(dayRoots[r.Day])) / float64(rootWindows[r.Root+"\x00"+r.Day])
	}
}

// v4PoolDayList returns the sorted distinct selected days of the pool.
func v4PoolDayList(rows []v4Observation, pool []int) []string {
	seen := map[string]bool{}
	for _, i := range pool {
		seen[rows[i].Day] = true
	}
	out := make([]string, 0, len(seen))
	for d := range seen {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}
