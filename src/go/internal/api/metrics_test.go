package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/storage"
)

// metricsUserA/B are two distinct JWT subs used to prove tenant isolation on the
// training-status metrics endpoints (ADR 0023).
const (
	metricsUserA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	metricsUserB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
)

// ── fake stores ──────────────────────────────────────────────────────────────

type fakeHealthStore struct {
	health       []storage.DailyHealth
	healthErr    error
	hrv          []storage.DailyHRV
	hrvErr       error
	latestHRV    string
	latestHRVErr error
	dash         *storage.Dashboard
	dashErr      error
	snap         *storage.RunningCalibrationSnapshot
	snapErr      error
	withPrior    []storage.DailyLoadWithPrior
	withPriorErr error
	latestUsable *storage.DailyTrainingLoad
	latestErr    error

	gotHealthUser string
	gotDays       int
	gotAsOf       string
}

func (f *fakeHealthStore) DailyHealthWindow(_ context.Context, userID string, days int) ([]storage.DailyHealth, error) {
	f.gotHealthUser, f.gotDays = userID, days
	return f.health, f.healthErr
}
func (f *fakeHealthStore) DailyHRVWindow(_ context.Context, _ string, days int) ([]storage.DailyHRV, error) {
	f.gotDays = days
	return f.hrv, f.hrvErr
}
func (f *fakeHealthStore) LatestHRVDate(_ context.Context, _ string) (string, error) {
	return f.latestHRV, f.latestHRVErr
}
func (f *fakeHealthStore) DashboardSnapshot(_ context.Context, _ string) (*storage.Dashboard, error) {
	return f.dash, f.dashErr
}
func (f *fakeHealthStore) LatestRunningCalibrationSnapshotForVersion(_ context.Context, _ string, _ int, asOf string) (*storage.RunningCalibrationSnapshot, error) {
	f.gotAsOf = asOf
	return f.snap, f.snapErr
}
func (f *fakeHealthStore) DailyTrainingLoadWithPrior(_ context.Context, _ string, days int) ([]storage.DailyLoadWithPrior, error) {
	f.gotDays = days
	return f.withPrior, f.withPriorErr
}
func (f *fakeHealthStore) LatestUsableDailyTrainingLoad(_ context.Context, _ string) (*storage.DailyTrainingLoad, error) {
	return f.latestUsable, f.latestErr
}

type fakeStrideStore struct {
	snap         *storage.RunningCalibrationSnapshot
	snapErr      error
	pace         []storage.RunningCalibrationPaceZone
	hr           []storage.RunningCalibrationHRZone
	zonesErr     error
	series       []storage.DailyTrainingLoad
	seriesErr    error
	latestUsable *storage.DailyTrainingLoad
	latestErr    error

	gotUser     string
	gotDays     int
	gotSnapshot uint64
}

func (f *fakeStrideStore) LatestRunningCalibrationSnapshotForVersion(_ context.Context, userID string, _ int, _ string) (*storage.RunningCalibrationSnapshot, error) {
	f.gotUser = userID
	return f.snap, f.snapErr
}
func (f *fakeStrideStore) CalibrationZonesForSnapshot(_ context.Context, _ string, snapshotID uint64) ([]storage.RunningCalibrationPaceZone, []storage.RunningCalibrationHRZone, error) {
	f.gotSnapshot = snapshotID
	return f.pace, f.hr, f.zonesErr
}
func (f *fakeStrideStore) DailyTrainingLoadSeries(_ context.Context, _ string, days int) ([]storage.DailyTrainingLoad, error) {
	f.gotDays = days
	return f.series, f.seriesErr
}
func (f *fakeStrideStore) LatestUsableDailyTrainingLoad(_ context.Context, _ string) (*storage.DailyTrainingLoad, error) {
	return f.latestUsable, f.latestErr
}

// ── harness ──────────────────────────────────────────────────────────────────

type metricsHarness struct {
	svc *Service
	hs  *fakeHealthStore
	ss  *fakeStrideStore
	key *rsa.PrivateKey
}

func newMetricsHarness(t *testing.T, hs *fakeHealthStore, ss *fakeStrideStore) *metricsHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	svc := NewService(Config{
		Auth:        NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
		HealthStore: hs,
		StrideStore: ss,
	})
	return &metricsHarness{svc: svc, hs: hs, ss: ss, key: key}
}

func (h *metricsHarness) do(method, path string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, r)
	return w
}

func (h *metricsHarness) bearer(t *testing.T, sub string) map[string]string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	})
	s, err := tok.SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + s}
}

// ── auth / tenant scope ──────────────────────────────────────────────────────

func TestMetrics_AuthTiers(t *testing.T) {
	paths := []string{
		"/api/%s/health", "/api/%s/hrv", "/api/%s/pmc",
		"/api/%s/stride/zones", "/api/%s/stride/training-load",
	}
	for _, p := range paths {
		h := newMetricsHarness(t, &fakeHealthStore{}, &fakeStrideStore{})
		// no token → 401
		if w := h.do(http.MethodGet, sprintfPath(p, metricsUserA), nil); w.Code != http.StatusUnauthorized {
			t.Fatalf("%s no-token: code = %d, want 401", p, w.Code)
		}
		// user-tier cross-user → 403, store untouched
		if w := h.do(http.MethodGet, sprintfPath(p, metricsUserB), h.bearer(t, metricsUserA)); w.Code != http.StatusForbidden {
			t.Fatalf("%s cross-user: code = %d, want 403", p, w.Code)
		}
		// own user → 200
		if w := h.do(http.MethodGet, sprintfPath(p, metricsUserA), h.bearer(t, metricsUserA)); w.Code != http.StatusOK {
			t.Fatalf("%s own-user: code = %d, want 200", p, w.Code)
		}
		// internal tier any user → 200
		if w := h.do(http.MethodGet, sprintfPath(p, metricsUserB), internalHdr()); w.Code != http.StatusOK {
			t.Fatalf("%s internal: code = %d, want 200", p, w.Code)
		}
	}
}

func sprintfPath(tmpl, user string) string {
	return strings.ReplaceAll(tmpl, "%s", user)
}

// ── days clamping ────────────────────────────────────────────────────────────

func TestMetrics_DaysClampAndDefault(t *testing.T) {
	cases := []struct {
		path string
		def  int
		lo   int
		hi   int
	}{
		{"/api/%s/health", 30, 1, 365},
		{"/api/%s/hrv", 30, 1, 365},
		{"/api/%s/pmc", 90, 14, 365},
		{"/api/%s/stride/training-load", 90, 7, 365},
	}
	for _, tc := range cases {
		// default (no days)
		hs, ss := &fakeHealthStore{}, &fakeStrideStore{}
		h := newMetricsHarness(t, hs, ss)
		h.do(http.MethodGet, sprintfPath(tc.path, metricsUserA), h.bearer(t, metricsUserA))
		if got := lastDays(hs, ss); got != tc.def {
			t.Fatalf("%s default days = %d, want %d", tc.path, got, tc.def)
		}
		// below floor → clamp to lo
		hs, ss = &fakeHealthStore{}, &fakeStrideStore{}
		h = newMetricsHarness(t, hs, ss)
		h.do(http.MethodGet, sprintfPath(tc.path, metricsUserA)+"?days=1", h.bearer(t, metricsUserA))
		if got := lastDays(hs, ss); got != tc.lo {
			t.Fatalf("%s days=1 → %d, want lo %d", tc.path, got, tc.lo)
		}
		// above ceiling → clamp to hi
		hs, ss = &fakeHealthStore{}, &fakeStrideStore{}
		h = newMetricsHarness(t, hs, ss)
		h.do(http.MethodGet, sprintfPath(tc.path, metricsUserA)+"?days=9999", h.bearer(t, metricsUserA))
		if got := lastDays(hs, ss); got != tc.hi {
			t.Fatalf("%s days=9999 → %d, want hi %d", tc.path, got, tc.hi)
		}
		// non-integer → 400
		hs, ss = &fakeHealthStore{}, &fakeStrideStore{}
		h = newMetricsHarness(t, hs, ss)
		if w := h.do(http.MethodGet, sprintfPath(tc.path, metricsUserA)+"?days=abc", h.bearer(t, metricsUserA)); w.Code != http.StatusBadRequest {
			t.Fatalf("%s days=abc: code = %d, want 400", tc.path, w.Code)
		}
	}
}

// lastDays returns whichever fake captured the days window this request touched.
func lastDays(hs *fakeHealthStore, ss *fakeStrideStore) int {
	if ss.gotDays != 0 {
		return ss.gotDays
	}
	return hs.gotDays
}

// ── /stride/zones ────────────────────────────────────────────────────────────

func TestStrideZones_NoSnapshot_EmptyShape(t *testing.T) {
	h := newMetricsHarness(t, &fakeHealthStore{}, &fakeStrideStore{snap: nil})
	w := h.do(http.MethodGet, "/api/"+metricsUserA+"/stride/zones", h.bearer(t, metricsUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if string(raw["threshold"]) != "null" {
		t.Fatalf("threshold = %s, want null", raw["threshold"])
	}
	if string(raw["pace_zones"]) != "[]" || string(raw["hr_zones"]) != "[]" {
		t.Fatalf("zones = %s / %s, want [] / []", raw["pace_zones"], raw["hr_zones"])
	}
}

func TestStrideZones_ThresholdAndOrderingAndFormatting(t *testing.T) {
	ss := &fakeStrideStore{
		snap: &storage.RunningCalibrationSnapshot{
			ID:                       7,
			ThresholdSpeedMps:        fptr(3.3333333), // → 300 s/km → 5:00
			ThresholdHR:              fptr(170),
			ThresholdSpeedConfidence: "high",
			ThresholdHRConfidence:    "medium",
			AsOfDate:                 "2026-05-09",
		},
		// deliberately out of physiological order to prove the sort
		pace: []storage.RunningCalibrationPaceZone{
			{Name: "interval", MinSpeedMps: fptr(3.7), MaxSpeedMps: fptr(4.0)},
			{Name: "recovery", MinSpeedMps: fptr(2.4), MaxSpeedMps: nil},
		},
		hr: []storage.RunningCalibrationHRZone{
			{Name: "threshold", MinBpm: fptr(160.9), MaxBpm: fptr(171.9)},
			{Name: "easy", MinBpm: fptr(136), MaxBpm: fptr(150)},
		},
	}
	h := newMetricsHarness(t, &fakeHealthStore{}, ss)
	w := h.do(http.MethodGet, "/api/"+metricsUserA+"/stride/zones", h.bearer(t, metricsUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	if ss.gotSnapshot != 7 {
		t.Fatalf("zones fetched for snapshot %d, want 7", ss.gotSnapshot)
	}
	var resp strideZonesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Threshold == nil {
		t.Fatalf("threshold missing")
	}
	if resp.Threshold.PacePerKmSec == nil || *resp.Threshold.PacePerKmSec != 300 {
		t.Fatalf("pace_per_km_sec = %v, want 300", resp.Threshold.PacePerKmSec)
	}
	if resp.Threshold.CalibrationID != 7 || resp.Threshold.AsOfDate != "2026-05-09" {
		t.Fatalf("threshold id/as_of = %d/%q", resp.Threshold.CalibrationID, resp.Threshold.AsOfDate)
	}
	// physiological order: recovery before interval
	if resp.PaceZones[0].Name != "recovery" || resp.PaceZones[1].Name != "interval" {
		t.Fatalf("pace order = %q,%q, want recovery,interval", resp.PaceZones[0].Name, resp.PaceZones[1].Name)
	}
	// recovery is open-ended slower edge: lower_pace from min_speed, upper_pace null
	if resp.PaceZones[0].UpperPace != nil {
		t.Fatalf("recovery upper_pace = %v, want null", *resp.PaceZones[0].UpperPace)
	}
	if resp.PaceZones[0].LowerPace == nil {
		t.Fatalf("recovery lower_pace missing")
	}
	if resp.PaceZones[0].Label != "配速1区" {
		t.Fatalf("recovery label = %q, want 配速1区", resp.PaceZones[0].Label)
	}
	// hr order: easy before threshold; int() truncation of bpm
	if resp.HRZones[0].Name != "easy" || resp.HRZones[1].Name != "threshold" {
		t.Fatalf("hr order = %q,%q", resp.HRZones[0].Name, resp.HRZones[1].Name)
	}
	if resp.HRZones[1].LowerBpm == nil || *resp.HRZones[1].LowerBpm != 160 {
		t.Fatalf("threshold lower_bpm = %v, want 160 (trunc of 160.9)", resp.HRZones[1].LowerBpm)
	}
	if resp.HRZones[1].Label != "心率4区" {
		t.Fatalf("threshold hr label = %q, want 心率4区", resp.HRZones[1].Label)
	}
}

// ── /stride/training-load ────────────────────────────────────────────────────

func TestStrideTrainingLoad_EmptySeries_NullCurrent(t *testing.T) {
	ss := &fakeStrideStore{series: nil}
	h := newMetricsHarness(t, &fakeHealthStore{}, ss)
	w := h.do(http.MethodGet, "/api/"+metricsUserA+"/stride/training-load", h.bearer(t, metricsUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(w.Body.Bytes(), &raw)
	if string(raw["current"]) != "null" || string(raw["series"]) != "[]" {
		t.Fatalf("current/series = %s / %s, want null / []", raw["current"], raw["series"])
	}
}

func TestStrideTrainingLoad_CurrentIsLatestUsable(t *testing.T) {
	ss := &fakeStrideStore{
		series: []storage.DailyTrainingLoad{
			{Date: "2026-05-08", CoverageStatus: "complete", TrainingDose: 40, AcuteLoad: 30, ChronicLoad: 28, Form: -2},
			{Date: "2026-05-09", CoverageStatus: "unknown", TrainingDose: 0},
		},
		latestUsable: &storage.DailyTrainingLoad{
			Date: "2026-05-08", CoverageStatus: "complete", TrainingDose: 40, AcuteLoad: 30,
			ChronicLoad: 28, Form: -2, ReadinessGate: strptr("green"),
			ReadinessReasonsJSON: strptr(`["fresh"]`),
		},
	}
	h := newMetricsHarness(t, &fakeHealthStore{}, ss)
	w := h.do(http.MethodGet, "/api/"+metricsUserA+"/stride/training-load?days=60", h.bearer(t, metricsUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	var resp strideTrainingLoadResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Series) != 2 {
		t.Fatalf("series len = %d, want 2", len(resp.Series))
	}
	if resp.Current == nil || resp.Current.Date != "2026-05-08" {
		t.Fatalf("current = %+v, want the 05-08 usable row (not the 05-09 unknown)", resp.Current)
	}
	if resp.Current.ReadinessGate == nil || *resp.Current.ReadinessGate != "green" {
		t.Fatalf("current readiness_gate = %v, want green", resp.Current.ReadinessGate)
	}
	if len(resp.Current.ReadinessReasons) != 1 || resp.Current.ReadinessReasons[0] != "fresh" {
		t.Fatalf("readiness_reasons = %v, want [fresh]", resp.Current.ReadinessReasons)
	}
}

// ── /health ──────────────────────────────────────────────────────────────────

func TestHealth_SnapshotTrendAndBaseline(t *testing.T) {
	hs := &fakeHealthStore{
		health: []storage.DailyHealth{
			{Date: "20260509", RHR: iptr(46), Provider: "coros"}, // YYYYMMDD → normalized
			{Date: "20260508", RHR: iptr(48), Provider: "coros"},
		},
		hrv: []storage.DailyHRV{ // newest-first from the store
			{Date: "2026-05-09", LastNightAvg: iptr(62), Status: strptr("balanced"), BaselineBalancedLow: iptr(50), BaselineBalancedUpper: iptr(70)},
			{Date: "2026-05-08", LastNightAvg: iptr(58)},
		},
		latestHRV: "2026-05-09",
		dash:      &storage.Dashboard{HRVNormalLow: fptr(48), HRVNormalHigh: fptr(72), AvgSleepHRV: fptr(60), RecoveryPct: fptr(85)},
		snap:      &storage.RunningCalibrationSnapshot{RHRBaseline: fptr(44.8)}, // int() → 44
	}
	h := newMetricsHarness(t, hs, &fakeStrideStore{})
	w := h.do(http.MethodGet, "/api/"+metricsUserA+"/health?days=30", h.bearer(t, metricsUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	if hs.gotAsOf == "" {
		t.Fatalf("rhr baseline must be read as-of today (non-empty)")
	}
	var resp healthResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.RHRBaseline == nil || *resp.RHRBaseline != 44 {
		t.Fatalf("rhr_baseline = %v, want 44 (trunc of 44.8)", resp.RHRBaseline)
	}
	if resp.Health[0].Date != "2026-05-09" {
		t.Fatalf("health[0].date = %q, want normalized 2026-05-09", resp.Health[0].Date)
	}
	// trend is reversed to oldest-first
	if len(resp.HRV.Trend) != 2 || resp.HRV.Trend[0].Date != "2026-05-08" {
		t.Fatalf("trend not oldest-first: %+v", resp.HRV.Trend)
	}
	if resp.HRV.Trend[1].DailyBalancedLow == nil || *resp.HRV.Trend[1].DailyBalancedLow != 50 {
		t.Fatalf("trend daily_balanced_low not mapped from baseline_balanced_low")
	}
	if resp.HRV.Date == nil || *resp.HRV.Date != "2026-05-09" {
		t.Fatalf("hrv.date = %v, want 2026-05-09", resp.HRV.Date)
	}
	if resp.HRV.HRVNormalLow == nil || *resp.HRV.HRVNormalLow != 48 {
		t.Fatalf("hrv_normal_low = %v, want 48 from dashboard", resp.HRV.HRVNormalLow)
	}
}

func TestHealth_NoDashboardNoSnapshot_NullBlocks(t *testing.T) {
	h := newMetricsHarness(t, &fakeHealthStore{}, &fakeStrideStore{})
	w := h.do(http.MethodGet, "/api/"+metricsUserA+"/health", h.bearer(t, metricsUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(w.Body.Bytes(), &raw)
	if string(raw["rhr_baseline"]) != "null" {
		t.Fatalf("rhr_baseline = %s, want null", raw["rhr_baseline"])
	}
	// health is [] and hrv.trend is [] (never null)
	if string(raw["health"]) != "[]" {
		t.Fatalf("health = %s, want []", raw["health"])
	}
	var resp healthResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.HRV.Trend == nil {
		t.Fatalf("hrv.trend must be [] not null")
	}
	if resp.HRV.Date != nil {
		t.Fatalf("hrv.date = %v, want null with no readings", resp.HRV.Date)
	}
}

// ── /hrv ─────────────────────────────────────────────────────────────────────

func TestHRV_ReversedWithSummary(t *testing.T) {
	hs := &fakeHealthStore{
		hrv: []storage.DailyHRV{ // newest-first
			{Date: "2026-05-09", LastNightAvg: iptr(62), WeeklyAvg: iptr(60), Status: strptr("balanced")},
			{Date: "2026-05-08", LastNightAvg: iptr(58)},
		},
	}
	h := newMetricsHarness(t, hs, &fakeStrideStore{})
	w := h.do(http.MethodGet, "/api/"+metricsUserA+"/hrv", h.bearer(t, metricsUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	var resp hrvResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// oldest-first
	if resp.HRV[0].Date != "2026-05-08" || resp.HRV[1].Date != "2026-05-09" {
		t.Fatalf("hrv not oldest-first: %q,%q", resp.HRV[0].Date, resp.HRV[1].Date)
	}
	// summary from the latest (newest) reading
	if resp.Summary.Date == nil || *resp.Summary.Date != "2026-05-09" {
		t.Fatalf("summary.date = %v, want 2026-05-09", resp.Summary.Date)
	}
	if resp.Summary.LastNightAvg == nil || *resp.Summary.LastNightAvg != 62 {
		t.Fatalf("summary.last_night_avg = %v, want 62", resp.Summary.LastNightAvg)
	}
}

// ── /pmc ─────────────────────────────────────────────────────────────────────

func TestPMC_TSBZonesRampAndStrideBlock(t *testing.T) {
	// Build 8 daily_health days so the 8th has a 7-day CTL ramp. cti rises 50→57.
	var health []storage.DailyHealth // store returns newest-first
	for i := 7; i >= 0; i-- {
		day := time.Date(2026, 5, 1+i, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
		health = append(health, storage.DailyHealth{
			Date: day,
			ATI:  fptr(40), CTI: fptr(float64(50 + i)), // ratio 40/50=0.8 → race_ready
			TrainingLoadRatio: nil,
		})
	}
	hs := &fakeHealthStore{
		health: health,
		withPrior: []storage.DailyLoadWithPrior{
			{Row: storage.DailyTrainingLoad{Date: "2026-05-08", ChronicLoad: 30, CoverageStatus: "complete"}, PriorChronic: fptr(24)},
		},
		latestUsable: &storage.DailyTrainingLoad{Date: "2026-05-08", ChronicLoad: 30, CoverageStatus: "complete", ReadinessReasonsJSON: strptr(`["ok"]`)},
	}
	h := newMetricsHarness(t, hs, &fakeStrideStore{})
	w := h.do(http.MethodGet, "/api/"+metricsUserA+"/pmc?days=30", h.bearer(t, metricsUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	var resp pmcResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.PMC) != 8 {
		t.Fatalf("pmc len = %d, want 8", len(resp.PMC))
	}
	// oldest-first; ratio 0.8 → race_ready
	if resp.PMC[0].TSBZone != "race_ready" {
		t.Fatalf("tsb_zone = %q, want race_ready (ratio 0.8)", resp.PMC[0].TSBZone)
	}
	// tsb = cti - ati = 50 - 40 = 10 (first day, cti=50)
	if resp.PMC[0].TSB != 10 {
		t.Fatalf("tsb = %v, want 10", resp.PMC[0].TSB)
	}
	// ctl_ramp only on the 8th day: cti 57 - cti 50 = 7
	if resp.PMC[0].CTLRamp != nil {
		t.Fatalf("day0 ctl_ramp = %v, want null (i<7)", *resp.PMC[0].CTLRamp)
	}
	if resp.PMC[7].CTLRamp == nil || *resp.PMC[7].CTLRamp != 7 {
		t.Fatalf("day7 ctl_ramp = %v, want 7", resp.PMC[7].CTLRamp)
	}
	// stride block: chronic_load_ramp = 30 - 24 = 6
	if len(resp.StridePMC) != 1 || resp.StridePMC[0].ChronicLoadRamp == nil || *resp.StridePMC[0].ChronicLoadRamp != 6 {
		t.Fatalf("stride chronic_load_ramp = %+v, want 6", resp.StridePMC)
	}
	// stride_summary reflects the latest usable row + matched ramp
	if resp.StrideSummary.Date == nil || *resp.StrideSummary.Date != "2026-05-08" {
		t.Fatalf("stride_summary.date = %v, want 2026-05-08", resp.StrideSummary.Date)
	}
	if resp.StrideSummary.ChronicLoadRamp == nil || *resp.StrideSummary.ChronicLoadRamp != 6 {
		t.Fatalf("stride_summary chronic_load_ramp = %v, want 6", resp.StrideSummary.ChronicLoadRamp)
	}
	if len(resp.StrideSummary.CurrentReadinessReasons) != 1 {
		t.Fatalf("stride_summary current_readiness_reasons = %v, want [ok]", resp.StrideSummary.CurrentReadinessReasons)
	}
}

func TestPMC_NoStrideUsable_ReasonsNull(t *testing.T) {
	hs := &fakeHealthStore{
		health:       []storage.DailyHealth{{Date: "2026-05-09", ATI: fptr(40), CTI: fptr(50)}},
		withPrior:    nil,
		latestUsable: nil, // no usable stride row
	}
	h := newMetricsHarness(t, hs, &fakeStrideStore{})
	w := h.do(http.MethodGet, "/api/"+metricsUserA+"/pmc", h.bearer(t, metricsUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	var raw struct {
		StrideSummary map[string]json.RawMessage `json:"stride_summary"`
		StridePMC     json.RawMessage            `json:"stride_pmc"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if string(raw.StridePMC) != "[]" {
		t.Fatalf("stride_pmc = %s, want []", raw.StridePMC)
	}
	if string(raw.StrideSummary["current_readiness_reasons"]) != "null" {
		t.Fatalf("current_readiness_reasons = %s, want null (no usable row)", raw.StrideSummary["current_readiness_reasons"])
	}
	if string(raw.StrideSummary["date"]) != "null" {
		t.Fatalf("stride_summary.date = %s, want null", raw.StrideSummary["date"])
	}
}

// ── 500 propagation ──────────────────────────────────────────────────────────

func TestMetrics_StoreError_500(t *testing.T) {
	h := newMetricsHarness(t, &fakeHealthStore{healthErr: errors.New("boom")}, &fakeStrideStore{})
	if w := h.do(http.MethodGet, "/api/"+metricsUserA+"/health", h.bearer(t, metricsUserA)); w.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d, want 500", w.Code)
	}
}
