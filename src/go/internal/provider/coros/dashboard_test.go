package coros

import "testing"

// sampleDashboardSummary mirrors the Python TestDashboardFromApi fixture
// (tests/test_models.py) — the /dashboard/query data.summaryInfo shape.
const sampleDashboardSummary = `{
  "summaryInfo": {
    "staminaLevel": 65.0,
    "aerobicEnduranceScore": 70,
    "lactateThresholdCapacityScore": 55,
    "anaerobicEnduranceScore": 40,
    "anaerobicCapacityScore": 35,
    "rhr": 52,
    "lthr": 165,
    "ltsp": 280,
    "recoveryPct": 85,
    "sleepHrvData": {
      "avgSleepHrv": 55,
      "sleepHrvAllIntervalList": [10, 20, 40, 70],
      "sleepHrvList": [
        {"avgSleepHrv": 42, "happenDay": 20260516, "sleepHrvIntervalList": [5, 26, 30, 38]},
        {"avgSleepHrv": 44, "happenDay": 20260517, "sleepHrvIntervalList": [5, 27, 31, 39]}
      ]
    },
    "runScoreList": [
      {"type": 1, "duration": 10800, "avgPace": 257},
      {"type": 4, "duration": 2400, "avgPace": 240}
    ]
  }
}`

// sampleDashboardDetail is the /dashboard/detail/query data.currentWeekRecord.
const sampleDashboardDetail = `{"currentWeekRecord": {"distanceRecord": 50000, "durationRecord": 18000}}`

func TestParseDashboard(t *testing.T) {
	const uid = "f10bc353-01ab-4db1-af9f-d9305ea9a532"
	dash, hrv, preds := parseDashboard(uid, []byte(sampleDashboardSummary), []byte(sampleDashboardDetail))

	if dash == nil {
		t.Fatal("dashboard is nil")
	}
	if dash.UserID != uid || dash.Provider != "coros" {
		t.Errorf("identity = %s/%s", dash.UserID, dash.Provider)
	}
	if got := derefFl(dash.RunningLevel); got != 65.0 {
		t.Errorf("running_level = %v, want 65.0", got)
	}
	if got := derefFl(dash.AerobicScore); got != 70 {
		t.Errorf("aerobic_score = %v, want 70", got)
	}
	if got := derefFl(dash.LactateThresholdScore); got != 55 {
		t.Errorf("lactate_threshold_score = %v, want 55", got)
	}
	if got := derefInt(dash.RHR); got != 52 {
		t.Errorf("rhr = %v, want 52", got)
	}
	if got := derefInt(dash.ThresholdHR); got != 165 {
		t.Errorf("threshold_hr = %v, want 165 (lthr)", got)
	}
	if got := derefFl(dash.ThresholdPaceSKm); got != 280 {
		t.Errorf("threshold_pace_s_km = %v, want 280 (ltsp)", got)
	}
	if got := derefFl(dash.AvgSleepHRV); got != 55 {
		t.Errorf("avg_sleep_hrv = %v, want 55", got)
	}
	// hrv_normal_low/high are sleepHrvAllIntervalList indices 2 and 3.
	if got := derefFl(dash.HRVNormalLow); got != 40 {
		t.Errorf("hrv_normal_low = %v, want 40", got)
	}
	if got := derefFl(dash.HRVNormalHigh); got != 70 {
		t.Errorf("hrv_normal_high = %v, want 70", got)
	}
	if got := derefFl(dash.WeeklyDistanceM); got != 50000 {
		t.Errorf("weekly_distance_m = %v, want 50000", got)
	}
	if got := derefFl(dash.WeeklyDurationS); got != 18000 {
		t.Errorf("weekly_duration_s = %v, want 18000", got)
	}

	// Race predictions map by type code, in list order.
	if len(preds) != 2 {
		t.Fatalf("preds = %d, want 2", len(preds))
	}
	if preds[0].RaceType != "Marathon" || derefFl(preds[0].DurationS) != 10800 || derefFl(preds[0].AvgPace) != 257 {
		t.Errorf("preds[0] = %+v", preds[0])
	}
	if preds[1].RaceType != "10K" {
		t.Errorf("preds[1].race_type = %q, want 10K", preds[1].RaceType)
	}
	if preds[0].UserID != uid {
		t.Errorf("preds[0].user_id = %q", preds[0].UserID)
	}

	// Per-day HRV rows, oldest→newest in list order.
	if len(hrv) != 2 {
		t.Fatalf("hrv rows = %d, want 2", len(hrv))
	}
	if hrv[0].Date != "2026-05-16" || derefInt(hrv[0].LastNightAvg) != 42 {
		t.Errorf("hrv[0] = %s / %v", hrv[0].Date, hrv[0].LastNightAvg)
	}
	if hrv[1].Date != "2026-05-17" || derefInt(hrv[1].LastNightAvg) != 44 {
		t.Errorf("hrv[1] = %s / %v", hrv[1].Date, hrv[1].LastNightAvg)
	}
	// baseline fields come from sleepHrvIntervalList indices 1,2,3.
	if derefInt(hrv[0].BaselineLowUpper) != 26 || derefInt(hrv[0].BaselineBalancedLow) != 30 || derefInt(hrv[0].BaselineBalancedUpper) != 38 {
		t.Errorf("hrv[0] baseline = %v/%v/%v", hrv[0].BaselineLowUpper, hrv[0].BaselineBalancedLow, hrv[0].BaselineBalancedUpper)
	}
	if hrv[0].Provider != "coros" {
		t.Errorf("hrv[0].provider = %q", hrv[0].Provider)
	}
}

// TestDeriveHRVStatus mirrors tests/test_coros_models.py TestDailyHrvFromCoros
// status bands: intervals = [floor=5, low_upper=26, balanced_low=30,
// balanced_upper=38].
func TestDeriveHRVStatus(t *testing.T) {
	intervals := []any{5.0, 26.0, 30.0, 38.0}
	cases := []struct {
		value float64
		want  string
	}{
		{32, "BALANCED"},   // in [balanced_low, balanced_upper]
		{40, "UNBALANCED"}, // above balanced_upper
		{28, "UNBALANCED"}, // in [low_upper, balanced_low)
		{20, "LOW"},        // in [floor, low_upper)
		{3, "POOR"},        // below floor
	}
	for _, c := range cases {
		v := c.value
		got := deriveHRVStatus(&v, intervals)
		if got == nil || *got != c.want {
			t.Errorf("status(%v) = %v, want %s", c.value, got, c.want)
		}
	}
}

func TestDeriveHRVStatusNilWhenIncomplete(t *testing.T) {
	v := 30.0
	if got := deriveHRVStatus(&v, []any{5.0, 26.0}); got != nil {
		t.Errorf("short interval list should yield nil status, got %v", *got)
	}
	if got := deriveHRVStatus(nil, []any{5.0, 26.0, 30.0, 38.0}); got != nil {
		t.Errorf("nil value should yield nil status, got %v", *got)
	}
	// A non-numeric interval (bool) makes the band unusable → nil.
	if got := deriveHRVStatus(&v, []any{5.0, true, 30.0, 38.0}); got != nil {
		t.Errorf("bool in interval should yield nil status, got %v", *got)
	}
}

// TestHRVRowsRejectBoolAndFilterBadDates mirrors the defense-in-depth Python
// tests: a boolean avgSleepHrv must not persist as 1, and rows with an
// unparseable happenDay are dropped.
func TestHRVRowsRejectBoolAndFilterBadDates(t *testing.T) {
	const summary = `{"summaryInfo": {"sleepHrvData": {"sleepHrvList": [
	  {"avgSleepHrv": true, "happenDay": 20260103, "sleepHrvIntervalList": [5, 26, 30, 38]},
	  {"avgSleepHrv": 42, "happenDay": null, "sleepHrvIntervalList": [5, 26, 30, 38]},
	  {"avgSleepHrv": 99, "happenDay": "garbage"},
	  {"avgSleepHrv": 30, "happenDay": 20260516.0, "sleepHrvIntervalList": [5, 25, 29, 39]}
	]}}}`
	_, hrv, _ := parseDashboard("f10bc353-01ab-4db1-af9f-d9305ea9a532", []byte(summary), nil)

	// Rows with null / "garbage" happenDay are dropped; the bool row keeps its
	// date but has a nil last_night_avg; the float happenDay is coerced.
	var dates []string
	for _, r := range hrv {
		dates = append(dates, r.Date)
	}
	if len(hrv) != 2 {
		t.Fatalf("hrv rows = %d (%v), want 2", len(hrv), dates)
	}
	if hrv[0].Date != "2026-01-03" {
		t.Errorf("hrv[0].date = %q, want 2026-01-03", hrv[0].Date)
	}
	if hrv[0].LastNightAvg != nil {
		t.Errorf("bool avgSleepHrv must yield nil last_night_avg, got %v", *hrv[0].LastNightAvg)
	}
	if hrv[1].Date != "2026-05-16" || derefInt(hrv[1].LastNightAvg) != 30 {
		t.Errorf("hrv[1] = %s / %v, want 2026-05-16 / 30 (float happenDay coerced)", hrv[1].Date, hrv[1].LastNightAvg)
	}
}

// TestParseDashboardShortIntervalListDropsNormalBand guards the parity fix: a
// sleepHrvAllIntervalList shorter than 4 entries must yield nil for BOTH
// hrv_normal_low and hrv_normal_high (matching Python's `len >= 4` guard), not
// just the missing index.
func TestParseDashboardShortIntervalListDropsNormalBand(t *testing.T) {
	const summary = `{"summaryInfo":{"staminaLevel":60,"sleepHrvData":{"avgSleepHrv":50,"sleepHrvAllIntervalList":[10,20,40]}}}`
	dash, _, _ := parseDashboard("f10bc353-01ab-4db1-af9f-d9305ea9a532", []byte(summary), nil)
	if dash == nil {
		t.Fatal("dashboard is nil")
	}
	if dash.HRVNormalLow != nil {
		t.Errorf("hrv_normal_low = %v, want nil for a 3-element interval list", *dash.HRVNormalLow)
	}
	if dash.HRVNormalHigh != nil {
		t.Errorf("hrv_normal_high = %v, want nil for a 3-element interval list", *dash.HRVNormalHigh)
	}
}

// TestParseDashboardToleratesFloatHR confirms an rhr/lthr that arrives as a JSON
// float does not fail the summary unmarshal and drop the whole dashboard.
func TestParseDashboardToleratesFloatHR(t *testing.T) {
	const summary = `{"summaryInfo":{"staminaLevel":60,"rhr":46.0,"lthr":165.0}}`
	dash, _, _ := parseDashboard("f10bc353-01ab-4db1-af9f-d9305ea9a532", []byte(summary), nil)
	if dash == nil {
		t.Fatal("dashboard dropped on a float HR value")
	}
	if derefInt(dash.RHR) != 46 || derefInt(dash.ThresholdHR) != 165 {
		t.Errorf("rhr/threshold_hr = %v/%v, want 46/165", dash.RHR, dash.ThresholdHR)
	}
}

func TestHappenDayToISO(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{20260516.0, "2026-05-16"}, // float
		{"20260516", "2026-05-16"}, // numeric string
		{"garbage", ""},
		{nil, ""},
		{"2026051", ""}, // too short
	}
	for _, c := range cases {
		if got := happenDayToISO(c.in); got != c.want {
			t.Errorf("happenDayToISO(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRaceTypeName(t *testing.T) {
	cases := map[int]string{1: "Marathon", 2: "Half Marathon", 4: "10K", 5: "5K", 7: "Unknown (7)"}
	for code, want := range cases {
		if got := raceTypeName(code); got != want {
			t.Errorf("raceTypeName(%d) = %q, want %q", code, got, want)
		}
	}
}

// TestParseDashboardNoWeekRecord confirms a nil detail payload still yields a
// usable dashboard (weekly volume just stays nil).
func TestParseDashboardNoWeekRecord(t *testing.T) {
	dash, _, _ := parseDashboard("f10bc353-01ab-4db1-af9f-d9305ea9a532", []byte(sampleDashboardSummary), nil)
	if dash == nil {
		t.Fatal("dashboard is nil")
	}
	if dash.WeeklyDistanceM != nil || dash.WeeklyDurationS != nil {
		t.Errorf("weekly volume should be nil without a week record, got %v/%v", dash.WeeklyDistanceM, dash.WeeklyDurationS)
	}
	if derefFl(dash.RunningLevel) != 65.0 {
		t.Errorf("running_level = %v, want 65.0", derefFl(dash.RunningLevel))
	}
}

func derefInt(p *int) int {
	if p == nil {
		return -1
	}
	return *p
}
