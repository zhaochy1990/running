package calibration

// evolved_v4_internal_test.go pins the §3-§8 unit invariants that the §10.2
// behavior table exercises indirectly: the A_floor algebra (§4.2), the
// bound_fallback / long_training_fallback ladders and the long monotone
// envelope kinds (§5.2), the §5.2 day weights, the B_eligible aggregation
// (§4.1) and the §8.1 tie rules.

import (
	"math"
	"testing"
	"time"
)

func v4InternalAsOf() time.Time { return time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC) }

func v4TrustedRow(id string, ageDays int, durationS, speed float64) CandidateEvidence {
	day := v4InternalAsOf().AddDate(0, 0, -ageDays)
	return CandidateEvidence{
		ActivityID: id, RootActivityID: id, ActivityDate: day,
		DurationS: durationS, AvgSpeedMps: speed,
		MeasurementQuality: ConfidenceHigh, Continuous: true, Source: "timeseries",
		EffortSupport: EffortUnknown, Selected: true,
	}
}

// §4.2 A_floor algebra: t=3600 gives a nominal (k-free) term; shorter rows
// bind through the curve; >7200 s rows contribute y + k·log2; B_eligible
// joins the max; absent terms are skipped (no invented zero floor).
func TestV4AFloorAlgebra(t *testing.T) {
	asOf := v4InternalAsOf()
	hour := v4TrustedRow("hour", 5, 3600, 3.9)
	tenMin := v4TrustedRow("tenmin", 4, 600, 4.6)
	long := v4TrustedRow("long", 3, 9000, 3.7)
	ev := v4EvidenceSet{Rows: []v4Observation{}}
	for _, e := range []CandidateEvidence{hour, tenMin, long} {
		age := float64(dayDiff(asOf, e.ActivityDate))
		row := v4Observation{
			ActivityID: e.ActivityID, Root: e.RootActivityID, Day: e.ActivityDate.Format("2006-01-02"),
			AgeDays: age, DurationS: e.DurationS, AvgSpeedMps: e.AvgSpeedMps,
			Y: math.Log(e.AvgSpeedMps), X: math.Log(math.Min(e.DurationS, 7200) / 3600),
			Bucket: v4NearestBucket(e.DurationS), Long: e.DurationS > 7200,
			Role: v4RoleTrustedBound, Quality: ConfidenceHigh, Effort: EffortUnknown,
		}
		ev.Rows = append(ev.Rows, row)
		ev.TrustedConstraintIdx = append(ev.TrustedConstraintIdx, len(ev.Rows)-1)
	}
	base := v4Baselines{}
	eligible := 4.1
	base.BEligibleMps = &eligible
	floor := v4NewFloorFunction(&ev, &base)
	f := floor.aFloor(0.06)
	wantTerms := []float64{
		math.Log(3.9),                    // t=3600: y
		math.Log(4.6) - 0.06*math.Log(6), // t=600: y + k·log(1/6)
		math.Log(3.7) + 0.06*math.Log(2), // t=9000: y + k·log2
		math.Log(4.1),                    // B_eligible
	}
	want := math.Inf(-1)
	for _, w := range wantTerms {
		want = math.Max(want, w)
	}
	if math.Abs(f.Value-want) > 1e-12 {
		t.Fatalf("A_floor(0.06)=%.6f want %.6f (terms %v)", f.Value, want, wantTerms)
	}
	// Trusted-only nominal floor excludes B_eligible.
	trustedWant := math.Max(math.Log(3.9), math.Max(wantTerms[1], wantTerms[2]))
	if math.Abs(f.TrustedOnly-trustedWant) > 1e-12 {
		t.Fatalf("trusted-only floor %.6f want %.6f", f.TrustedOnly, trustedWant)
	}
	// No trusted terms: only B_eligible; and with nothing at all, -inf
	// (never an invented zero-speed floor).
	empty := v4NewFloorFunction(&v4EvidenceSet{}, &v4Baselines{})
	if ef := empty.aFloor(0.06); ef.HasTrustedTerm || ef.finite() {
		t.Fatalf("empty floor must stay empty, got %+v", ef)
	}
	onlyB := v4NewFloorFunction(&v4EvidenceSet{}, &base)
	if of := onlyB.aFloor(0.06); math.Abs(of.Value-math.Log(4.1)) > 1e-12 || of.HasTrustedTerm {
		t.Fatalf("B-only floor wrong: %+v", of)
	}
	// k-dependence direction: the short-row term y + k·x (x<0) decreases
	// with k, the long-row term y + k·log2 increases, t=3600 stays fixed.
	fSmall := floor.aFloor(0.02)
	fBig := floor.aFloor(0.10)
	shortTerm := func(k float64) float64 { return math.Log(4.6) + k*math.Log(600.0/3600) }
	longTerm := func(k float64) float64 { return math.Log(3.7) + k*math.Log(2) }
	if !(shortTerm(0.02) > shortTerm(0.10)) || !(longTerm(0.02) < longTerm(0.10)) {
		t.Fatal("term direction sanity failed")
	}
	if math.Abs(fSmall.Value-math.Max(math.Log(4.1), shortTerm(0.02))) > 1e-12 {
		t.Fatalf("small-k floor %.6f dominated by the short-row term %.6f", fSmall.Value, shortTerm(0.02))
	}
	if math.Abs(fBig.Value-math.Log(4.1)) > 1e-12 {
		t.Fatalf("big-k floor %.6f should sit on B_eligible %.6f", fBig.Value, math.Log(4.1))
	}
}

// §5.2 fallback ladder: with an empty L_P and a trusted >7200 s constraint,
// bound_fallback fixes k=0.06 and takes the minimal constraint-satisfying a.
func TestV4BoundFallbackMinimalA(t *testing.T) {
	asOf := v4InternalAsOf()
	priors := DefaultEvolvedPriors()
	long := v4TrustedRow("only-long", 5, 7800, 3.9)
	ev := v4EvidenceSet{WindowDays: 60}
	row := v4Observation{
		ActivityID: long.ActivityID, Root: long.RootActivityID, Day: long.ActivityDate.Format("2006-01-02"),
		AgeDays: 5, DurationS: 7800, AvgSpeedMps: 3.9, Y: math.Log(3.9), X: math.Log(2),
		Long: true, Role: v4RoleTrustedBound, Quality: ConfidenceHigh, Effort: EffortUnknown,
	}
	ev.Rows = []v4Observation{row}
	ev.TrustedConstraintIdx = []int{0}
	est := &v4Estimate{asOf: asOf, priors: priors, evidence: ev, baselines: v4Baselines{}, hrBranch: "unavailable"}
	res := est.runSolve(v4SolveConfig{})
	if !res.OK || res.Method != v4MethodBoundFallback {
		t.Fatalf("trusted long-only evidence must bound_fallback: %+v", res)
	}
	if math.Abs(res.K-0.06) > 1e-12 {
		t.Fatalf("bound_fallback k=%v want 0.06", res.K)
	}
	want := math.Log(3.9) + 0.06*math.Log(2)
	if math.Abs(res.A-want) > 1e-12 {
		t.Fatalf("bound_fallback a=%.6f want minimal constraint value %.6f", res.A, want)
	}
}

// §5.2 long_training_fallback: only weak (>7200 s, non-trusted) legal
// records, no in-domain observations, no trusted bounds — k fixed at 0.06,
// wide 0.15 Huber position prior over the per-day best full-activity speeds,
// prior_dominated.
func TestV4LongTrainingFallback(t *testing.T) {
	asOf := v4InternalAsOf()
	priors := DefaultEvolvedPriors()
	ev := v4EvidenceSet{WindowDays: 60, Rows: []v4Observation{
		{ActivityID: "w1", Root: "w1", Day: asOf.AddDate(0, 0, -10).Format("2006-01-02"), AgeDays: 10,
			DurationS: 8000, AvgSpeedMps: 3.6, Y: math.Log(3.6), X: math.Log(2), Long: true,
			Role: v4RoleModelObservation, Quality: ConfidenceLow, Effort: EffortUnknown},
		{ActivityID: "w2", Root: "w2", Day: asOf.AddDate(0, 0, -3).Format("2006-01-02"), AgeDays: 3,
			DurationS: 8200, AvgSpeedMps: 3.4, Y: math.Log(3.4), X: math.Log(2), Long: true,
			Role: v4RoleModelObservation, Quality: ConfidenceLow, Effort: EffortUnknown},
	}}
	est := &v4Estimate{asOf: asOf, priors: priors, evidence: ev, baselines: v4Baselines{}, hrBranch: "unavailable"}
	res := est.runSolve(v4SolveConfig{})
	if !res.OK || res.Method != v4MethodLongFallback {
		t.Fatalf("weak long-only evidence must long_training_fallback: %+v", res)
	}
	if math.Abs(res.K-0.06) > 1e-12 {
		t.Fatalf("long_training_fallback k=%v want 0.06", res.K)
	}
	// The center is a conservative position between the two day speeds,
	// weighted by recency (never relabeled as a measured hour effort).
	if res.CenterMps == nil || *res.CenterMps < 3.4-1e-9 || *res.CenterMps > 3.6+1e-9 {
		t.Fatalf("long_training_fallback center %.4f outside the evidence bracket", derefF(res.CenterMps))
	}
	if res.Reason != v4ReasonPriorDominated {
		t.Fatalf("long_training_fallback must mark prior_dominated, got %q", res.Reason)
	}
}

func derefF(v *float64) float64 {
	if v == nil {
		return math.NaN()
	}
	return *v
}

// §5.2 day weights: W_j sums to the selected-day count D; weights are
// invariant to adding unselected rows; within a day the weight splits across
// roots and within a root across windows.
func TestV4DayWeights(t *testing.T) {
	rows := []v4Observation{
		{Root: "r1", Day: "d1", AgeDays: 1, Selected: true},
		{Root: "r2", Day: "d1", AgeDays: 1, Selected: true},
		{Root: "r3", Day: "d2", AgeDays: 10, Selected: true},
	}
	pool := []int{0, 1, 2}
	AssignV4Weights(rows, pool)
	total := 0.0
	for _, i := range pool {
		total += rows[i].Weight
	}
	if math.Abs(total-2) > 1e-12 {
		t.Fatalf("weights must sum to D=2, got %v", total)
	}
	// d1 (fresher) carries more than d2 despite splitting across two roots.
	d1, d2 := rows[0].Weight+rows[1].Weight, rows[2].Weight
	if !(d1 > d2) {
		t.Fatalf("fresher day must outweigh older: %v vs %v", d1, d2)
	}
	if math.Abs(rows[0].Weight-rows[1].Weight) > 1e-15 {
		t.Fatalf("same-day roots split equally: %v vs %v", rows[0].Weight, rows[1].Weight)
	}
	// Adding unselected rows never changes the selected weights.
	rows = append(rows, v4Observation{Root: "r9", Day: "d9", AgeDays: 0, Selected: false})
	AssignV4Weights(rows, pool)
	if math.Abs((rows[0].Weight+rows[1].Weight+rows[2].Weight)-2) > 1e-12 {
		t.Fatal("unselected addition changed the weight total")
	}
}

// §4.1 B_eligible: the trusted standard-7-bucket rows through the frozen V3
// aggregation rule reproduce estimateThresholdSpeed on the same candidates.
func TestV4EligibleBaselineUsesFrozenV3Aggregation(t *testing.T) {
	asOf := v4InternalAsOf()
	ev := v4EvidenceSet{WindowDays: 60}
	for _, spec := range []struct {
		id       string
		age      int
		duration float64
		speed    float64
	}{{"a", 10, 600, 4.4}, {"b", 12, 1800, 4.1}, {"c", 15, 3600, 3.9}} {
		day := asOf.AddDate(0, 0, -spec.age)
		ev.Rows = append(ev.Rows, v4Observation{
			ActivityID: spec.id, Root: spec.id, Day: day.Format("2006-01-02"), Date: day,
			AgeDays: float64(spec.age), DurationS: spec.duration, AvgSpeedMps: spec.speed,
			Y: math.Log(spec.speed), X: math.Log(spec.duration / 3600), Bucket: spec.duration,
			Role: v4RoleTrustedBound, Quality: ConfidenceHigh, Effort: EffortUnknown, Source: "timeseries",
		})
	}
	got := v4EligibleBaseline(ev, asOf)
	if got == nil {
		t.Fatal("B_eligible missing for a full trusted bucket set")
	}
	// Direct comparison against the frozen aggregator on identical inputs.
	cands := v4EligibleCandidates(ev)
	want, _, _ := estimateThresholdSpeed(cands, asOf)
	if want == nil || math.Abs(*got-*want) > 1e-12 {
		t.Fatalf("B_eligible %.6f != frozen V3 aggregation %.6f", derefF(got), derefF(want))
	}
	// 90-minute rows are not V3 bucket inputs.
	ev.Rows = append(ev.Rows, v4Observation{ActivityID: "d", Root: "d", Day: asOf.AddDate(0, 0, -5).Format("2006-01-02"),
		Date: asOf.AddDate(0, 0, -5), AgeDays: 5, DurationS: 4500, AvgSpeedMps: 4.6, Y: math.Log(4.6),
		X: math.Log(4500.0 / 3600), Bucket: 4500, Role: v4RoleTrustedBound, Quality: ConfidenceHigh, Effort: EffortUnknown, Source: "timeseries"})
	got2 := v4EligibleBaseline(ev, asOf)
	if got2 == nil || math.Abs(*got2-*want) > 1e-12 {
		t.Fatalf("a 4500 s row must not enter B_eligible: %.6f vs %.6f", derefF(got2), derefF(want))
	}
}

// §8.1 tie rules: within 1e-8 objective ties the smaller a wins, then the k
// closer to 0.06.
func TestV4TieRules(t *testing.T) {
	if !v4BetterSolution(1.0, 1.2, 0.05, 1.0+5e-9, 1.25, 0.05) {
		t.Fatal("tied objective must prefer the smaller a")
	}
	if v4BetterSolution(1.0, 1.2, 0.05, 1.0+5e-9, 1.15, 0.05) {
		t.Fatal("tied objective with smaller incumbent a must keep it")
	}
	if !v4BetterSolution(1.0, 1.2, 0.07, 1.0+5e-9, 1.2, 0.04) {
		t.Fatal("equal a tie must prefer k closer to 0.06")
	}
	if v4BetterSolution(1.0, 1.2, 0.08, 1.0+5e-9, 1.2, 0.05) {
		t.Fatal("equal a tie must not prefer a k farther from 0.06")
	}
	if v4BetterSolution(1.0+2e-8, 1.0, 0.06, 1.0, 1.3, 0.06) {
		t.Fatal("materially worse objective must not win via tie rules")
	}
}

// §3 frontier pool: trusted layer preferred; top-3 fastest independent days
// at >= 97% of the layer fastest; one window per activity per bucket;
// slow unselected rows never set the gate.
func TestV4FrontierPoolSelection(t *testing.T) {
	asOf := v4InternalAsOf()
	mk := func(id, root, dayStr string, age float64, duration, speed float64, role v4EvidenceRole) v4Observation {
		return v4Observation{ActivityID: id, Root: root, Day: dayStr, AgeDays: age, DurationS: duration,
			AvgSpeedMps: speed, Y: math.Log(speed), X: math.Log(math.Min(duration, 7200) / 3600),
			Bucket: v4NearestBucket(duration), Role: role, Quality: ConfidenceHigh, Effort: EffortUnknown}
	}
	d := func(n int) string { return asOf.AddDate(0, 0, -n).Format("2006-01-02") }
	rows := []v4Observation{
		mk("t1", "t1", d(1), 1, 1800, 4.0, v4RoleTrustedBound),
		mk("t2", "t2", d(2), 2, 1800, 3.96, v4RoleTrustedBound),    // ≥97% of 4.0
		mk("t3", "t3", d(3), 3, 1800, 3.85, v4RoleTrustedBound),    // <97% of 4.0: excluded
		mk("m1", "m1", d(1), 1, 1800, 4.4, v4RoleModelObservation), // faster but weaker layer
		mk("t4", "t4", d(1), 1, 1200, 4.1, v4RoleTrustedBound),     // other bucket
	}
	ev := v4EvidenceSet{Rows: rows, WindowDays: 60, Excluded: map[string]int{}, FrontierFastestByBucket: map[float64]float64{}}
	for i := range rows {
		if rows[i].Role == v4RoleTrustedBound {
			ev.TrustedConstraintIdx = append(ev.TrustedConstraintIdx, i)
		}
	}
	buildV4FrontierPool(&ev)
	inPool := map[string]bool{}
	for _, i := range ev.Pool {
		inPool[ev.Rows[i].ActivityID] = true
	}
	if inPool["m1"] {
		t.Fatal("model_observation must not enter the pool when trusted rows exist in the bucket")
	}
	if inPool["t3"] {
		t.Fatal("below-97% row must not enter the frontier pool")
	}
	if !inPool["t1"] || !inPool["t2"] || !inPool["t4"] {
		t.Fatalf("trusted fast rows missing from pool: %v", inPool)
	}
	if math.Abs(ev.FrontierFastestByBucket[1800]-4.0) > 1e-12 {
		t.Fatalf("trusted layer fastest must gate the bucket, got %v", ev.FrontierFastestByBucket[1800])
	}
	// A bucket with no trusted rows falls to the model_observation layer.
	rows = append(rows, mk("m2", "m2", d(4), 4, 600, 4.8, v4RoleModelObservation))
	ev2 := v4EvidenceSet{Rows: rows, WindowDays: 60, Excluded: map[string]int{}, FrontierFastestByBucket: map[float64]float64{}}
	buildV4FrontierPool(&ev2)
	found := false
	for _, i := range ev2.Pool {
		if ev2.Rows[i].ActivityID == "m2" {
			found = true
		}
	}
	if !found {
		t.Fatal("bucket without trusted rows must select from model_observation")
	}
}

// §5.2: bound_fallback with valid HR still enters the §6 joint solve — the
// shared hard floor stays and HR may lift a above the minimal solution.
func TestV4BoundFallbackEntersHRJoint(t *testing.T) {
	asOf := v4InternalAsOf()
	priors := DefaultEvolvedPriors()
	long := v4TrustedRow("only-long-hr", 5, 7800, 3.9)
	ev := v4EvidenceSet{WindowDays: 60}
	row := v4Observation{
		ActivityID: long.ActivityID, Root: long.RootActivityID, Day: long.ActivityDate.Format("2006-01-02"),
		AgeDays: 5, DurationS: 7800, AvgSpeedMps: 3.9, Y: math.Log(3.9), X: math.Log(2),
		Long: true, Role: v4RoleTrustedBound, Quality: ConfidenceHigh, Effort: EffortUnknown,
	}
	ev.Rows = []v4Observation{row}
	ev.TrustedConstraintIdx = []int{0}
	// One admitted HR day: 10 bins at constant 3.5 m/s, HR 150, optical.
	bins := make([]v4HRBin, 10)
	for i := range bins {
		bins[i] = v4HRBin{T: float64(i+1) * 60, Dt: 60, LogV: math.Log(3.5), HR: 150, Sigma: 6, S: float64(i) * 60 / 3600, Seg: 0, Init: i == 0}
	}
	series := &v4HRSeries{Days: []*v4HRDay{{Day: "d1", AgeDays: 5, Weight: 1, Series: []*v4HRSeriesBins{{Root: "only-long-hr", Sensor: "unknown", Bins: bins}}}}}
	r, m := 55.0, 190.0
	est := &v4Estimate{asOf: asOf, priors: priors, evidence: ev, baselines: v4Baselines{},
		hrSeries: series, hrBranch: "joint",
		phys: v4HRPhysiology{R: &r, M: &m}, restPrior: &r}
	res := est.runSolve(v4SolveConfig{})
	if !res.OK || res.Method != v4MethodBoundFallback {
		t.Fatalf("long-only trusted evidence must stay bound_fallback: %+v", res)
	}
	if res.HRBranch != "joint" || res.H60 == nil {
		t.Fatalf("§5.2: valid HR must enter the §6 joint solve, got branch=%s h60=%v", res.HRBranch, res.H60)
	}
	floor := math.Log(3.9) + 0.06*math.Log(2)
	if res.A < floor-1e-9 {
		t.Fatalf("joint dropped below the hard floor: %.6f < %.6f", res.A, floor)
	}
	if *res.H60 <= r || *res.H60 >= m {
		t.Fatalf("H60 must stay inside (R,M): %v", *res.H60)
	}
}

// §6.1: HR segment admission requires comparable conditions — treadmill
// metadata never feeds the reference-condition model.
func TestV4HRSeriesSkipsNonComparableTerrain(t *testing.T) {
	asOf := v4InternalAsOf()
	priors := DefaultEvolvedPriors()
	mk := func(id string, terrain string) Activity {
		seconds := 3600
		speed := 3.5
		duration, distance := float64(seconds), float64(seconds)*speed
		a := Activity{LabelID: id, ActivityDate: asOf.AddDate(0, 0, -3), Sport: "run", DurationS: &duration, DistanceM: &distance}
		hr := 150.0
		for second := 0; second <= seconds; second += 5 {
			elapsed, dd, sp := float64(second), float64(second)*speed, speed
			a.Samples = append(a.Samples, Sample{ElapsedS: &elapsed, DistanceM: &dd, SpeedMps: &sp, HeartRateBpm: &hr})
		}
		_ = terrain
		return a
	}
	road := mk("road-hr", "")
	tread := mk("treadmill-hr", "")
	meta := []CandidateMetadata{
		{ActivityID: "road-hr", SourceVersion: "t"},
		{ActivityID: "treadmill-hr", SourceVersion: "t", Terrain: "treadmill"},
	}
	series := v4BuildHRSeries([]Activity{road, tread}, meta, nil, asOf, priors)
	days := 0
	for _, d := range series.Days {
		for _, sr := range d.Series {
			if sr.Root == "treadmill-hr" {
				t.Fatal("treadmill series must not be admitted as model HR evidence")
			}
			days++
		}
	}
	if days != 1 {
		t.Fatalf("expected exactly the road series admitted, got %d", days)
	}
}

// §4.3: no invented tolerances — a verified reference projecting just above
// B_raw is a v3_projection_conflict; any visible repair difference is
// measurement_corrected.
func TestV4SlowdownCodesWithoutInventedTolerances(t *testing.T) {
	asOf := v4InternalAsOf()
	braw := 4.0
	brep := 4.0001 // a visible repair delta, far below the old 0.5% threshold
	base := v4Baselines{BRawMps: &braw, BRepairedMps: &brep}
	// Verified 3600 s reference at 4.0001 m/s: its projection is just above
	// B_raw — a conflict under the doc's strict reading.
	day := asOf.AddDate(0, 0, -2)
	ev := v4EvidenceSet{Rows: []v4Observation{{
		ActivityID: "ref", Root: "ref", Day: day.Format("2006-01-02"),
		AgeDays: 2, DurationS: 3600, AvgSpeedMps: 4.0001, Y: math.Log(4.0001), X: 0,
		Role: v4RoleTrustedBound, Quality: ConfidenceHigh, Effort: EffortProbableMaximal,
	}}, VerifiedReferenceIdx: []int{0}}
	v60 := 3.9
	reasons := v4ExplainSlowdown(&v60, base, ev)
	want := map[string]bool{v4ReasonMeasurementCorrected: false, v4ReasonV3ProjectionConflict: false}
	for _, r := range reasons {
		if _, ok := want[r]; ok {
			want[r] = true
		}
	}
	for code, seen := range want {
		if !seen {
			t.Fatalf("reason %s missing (no-tolerance semantics): %v", code, reasons)
		}
	}
}

// §8.3: the bound_fallback precondition 未触边 is an open interval — a floor
// sitting exactly on the numerical search edge is not publishable.
func TestV4BoundFallbackEdgeIsNotPublishable(t *testing.T) {
	asOf := v4InternalAsOf()
	priors := DefaultEvolvedPriors()
	long := v4TrustedRow("edge-long", 5, 7800, 11.9)
	ev := v4EvidenceSet{WindowDays: 60}
	row := v4Observation{ActivityID: long.ActivityID, Root: long.RootActivityID, Day: long.ActivityDate.Format("2006-01-02"),
		AgeDays: 5, DurationS: 7800, AvgSpeedMps: 11.9, Y: math.Log(11.9), X: math.Log(2),
		Long: true, Role: v4RoleTrustedBound, Quality: ConfidenceHigh, Effort: EffortUnknown}
	// Force the floor onto the fast search edge via B_eligible = 12 exactly:
	// floor(0.06) = log(12)·(exact) → touches the edge.
	ev.Rows = []v4Observation{row}
	ev.TrustedConstraintIdx = []int{0}
	b12 := 12.0 / math.Pow(2, -0.06) // undo the k·log2 shift: floor = log 12
	base := v4Baselines{BEligibleMps: &b12}
	est := &v4Estimate{asOf: asOf, priors: priors, evidence: ev, baselines: base, hrBranch: "unavailable"}
	res := est.runSolve(v4SolveConfig{})
	if res.OK {
		t.Fatalf("a bound_fallback touching the search edge must not publish: %+v", res)
	}
	if res.Reason == "" {
		t.Fatal("failure must carry a reason")
	}
}
