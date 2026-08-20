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

// activityUserA/B are two distinct JWT subs used to prove tenant isolation.
const (
	activityUserA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	activityUserB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
)

// --- fake store --------------------------------------------------------------

// fakeActivityStore is a scripted ActivityStore. Each method returns its canned
// value (or error) and records the (userID, labelID, params) it was called with
// so a handler test can assert the request was forwarded verbatim.
type fakeActivityStore struct {
	page      *storage.ActivityPage
	pageErr   error
	activity  *storage.Activity
	actErr    error
	laps      map[string][]storage.Lap // keyed by lap_type
	lapsErr   error
	zones     []storage.ActivityWatchZone
	zonesErr  error
	load      *storage.ActivityTrainingLoad
	loadErr   error
	series    []storage.TimeseriesPoint
	seriesErr error

	// captured inputs
	gotListUser string
	gotParams   storage.ActivityListParams
	gotDetailID string
	gotLapTypes []string
	tsCalled    bool
}

func (f *fakeActivityStore) ListActivities(_ context.Context, userID string, p storage.ActivityListParams) (*storage.ActivityPage, error) {
	f.gotListUser, f.gotParams = userID, p
	if f.pageErr != nil {
		return nil, f.pageErr
	}
	if f.page != nil {
		return f.page, nil
	}
	return &storage.ActivityPage{MonthlySummaries: map[string]storage.ActivityMonthly{}}, nil
}

func (f *fakeActivityStore) ActivityByID(_ context.Context, _ string, labelID string) (*storage.Activity, error) {
	f.gotDetailID = labelID
	return f.activity, f.actErr
}

func (f *fakeActivityStore) ActivityLapsByType(_ context.Context, _, _, lapType string) ([]storage.Lap, error) {
	f.gotLapTypes = append(f.gotLapTypes, lapType)
	if f.lapsErr != nil {
		return nil, f.lapsErr
	}
	return f.laps[lapType], nil
}

func (f *fakeActivityStore) ActivityWatchZones(_ context.Context, _, _ string) ([]storage.ActivityWatchZone, error) {
	return f.zones, f.zonesErr
}

func (f *fakeActivityStore) ActivityTrainingLoad(_ context.Context, _, _ string) (*storage.ActivityTrainingLoad, error) {
	return f.load, f.loadErr
}

func (f *fakeActivityStore) ActivityTimeseries(_ context.Context, _, _ string) ([]storage.TimeseriesPoint, error) {
	f.tsCalled = true
	return f.series, f.seriesErr
}

// --- harness -----------------------------------------------------------------

type activityHarness struct {
	svc   *Service
	store *fakeActivityStore
	key   *rsa.PrivateKey
}

func newActivityHarness(t *testing.T, store *fakeActivityStore) *activityHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	svc := NewService(Config{
		Auth:          NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
		ActivityStore: store,
	})
	return &activityHarness{svc: svc, store: store, key: key}
}

func (h *activityHarness) do(method, path string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, r)
	return w
}

func (h *activityHarness) bearer(t *testing.T, sub string) map[string]string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": sub,
		"iss": testIssuer,
		"aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Unix(),
	})
	s, err := tok.SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + s}
}

// --- small builders ----------------------------------------------------------

func strptr(s string) *string { return &s }
func fptr(f float64) *float64 { return &f }
func iptr(i int) *int         { return &i }
func i64ptr(i int64) *int64   { return &i }

// --- list: auth / tenant scope -----------------------------------------------

func TestActivityList_NoToken_401(t *testing.T) {
	h := newActivityHarness(t, &fakeActivityStore{})
	if w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", w.Code)
	}
}

func TestActivityList_UserTier_CrossUser_403(t *testing.T) {
	h := newActivityHarness(t, &fakeActivityStore{})
	w := h.do(http.MethodGet, "/api/"+activityUserB+"/activities", h.bearer(t, activityUserA))
	if w.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", w.Code)
	}
	if h.store.gotListUser != "" {
		t.Fatalf("store must not be hit on a forbidden request; got user %q", h.store.gotListUser)
	}
}

func TestActivityList_UserTier_OwnUser_200(t *testing.T) {
	h := newActivityHarness(t, &fakeActivityStore{})
	w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities", h.bearer(t, activityUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	if h.store.gotListUser != activityUserA {
		t.Fatalf("store user = %q, want %q", h.store.gotListUser, activityUserA)
	}
}

func TestActivityList_InternalTier_AnyUser_200(t *testing.T) {
	h := newActivityHarness(t, &fakeActivityStore{})
	w := h.do(http.MethodGet, "/api/"+activityUserB+"/activities", internalHdr())
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	if h.store.gotListUser != activityUserB {
		t.Fatalf("internal caller must reach any user; store user = %q", h.store.gotListUser)
	}
}

// --- list: defaults, echo, monthly-always-present ----------------------------

func TestActivityList_DefaultsAndEmptyShape(t *testing.T) {
	h := newActivityHarness(t, &fakeActivityStore{
		page: &storage.ActivityPage{Total: 0, Rows: nil, MonthlySummaries: map[string]storage.ActivityMonthly{}},
	})
	w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities", h.bearer(t, activityUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	// Defaults forwarded to the store.
	if h.store.gotParams.Offset != 0 || h.store.gotParams.Limit != 50 {
		t.Fatalf("default params = offset %d limit %d, want 0/50", h.store.gotParams.Offset, h.store.gotParams.Limit)
	}
	// activities is [] (not null); monthly_summaries is {} (not null); offset/limit echoed.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got := string(raw["activities"]); got != "[]" {
		t.Fatalf("activities = %s, want []", got)
	}
	if got := string(raw["monthly_summaries"]); got != "{}" {
		t.Fatalf("monthly_summaries = %s, want {}", got)
	}
	var resp activitiesListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal resp: %v", err)
	}
	if resp.Offset != 0 || resp.Limit != 50 {
		t.Fatalf("echo = offset %d limit %d, want 0/50", resp.Offset, resp.Limit)
	}
}

// --- list: query parsing -----------------------------------------------------

func TestActivityList_ParamsForwarded(t *testing.T) {
	h := newActivityHarness(t, &fakeActivityStore{})
	path := "/api/" + activityUserA + "/activities?offset=20&limit=10&sport=Run&sport_category=run&min_distance_km=5&date_from=2026-01-01&date_to=2026-01-31"
	if w := h.do(http.MethodGet, path, h.bearer(t, activityUserA)); w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	p := h.store.gotParams
	if p.Offset != 20 || p.Limit != 10 {
		t.Fatalf("offset/limit = %d/%d, want 20/10", p.Offset, p.Limit)
	}
	if p.Sport != "Run" || p.SportCategory != "run" {
		t.Fatalf("sport/category = %q/%q", p.Sport, p.SportCategory)
	}
	if p.MinDistanceKm == nil || *p.MinDistanceKm != 5 {
		t.Fatalf("min_distance_km = %v, want 5", p.MinDistanceKm)
	}
	if p.DateFrom != "2026-01-01" || p.DateTo != "2026-01-31" {
		t.Fatalf("date window = %q..%q", p.DateFrom, p.DateTo)
	}
}

func TestActivityList_LimitClampedTo200(t *testing.T) {
	h := newActivityHarness(t, &fakeActivityStore{})
	if w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities?limit=9999", h.bearer(t, activityUserA)); w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	if h.store.gotParams.Limit != 200 {
		t.Fatalf("limit = %d, want clamp to 200", h.store.gotParams.Limit)
	}
}

func TestActivityList_BadParams_400(t *testing.T) {
	cases := []string{
		"?limit=abc",
		"?offset=xyz",
		"?min_distance_km=notnum",
		"?sport_category=cycling",
	}
	for _, q := range cases {
		h := newActivityHarness(t, &fakeActivityStore{})
		w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities"+q, h.bearer(t, activityUserA))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("query %q: code = %d, want 400", q, w.Code)
		}
		if h.store.gotListUser != "" {
			t.Fatalf("query %q: store must not be hit on a 400", q)
		}
	}
}

// --- list: monthly rounding + item mapping -----------------------------------

func TestActivityList_MonthlyRoundingAndItem(t *testing.T) {
	h := newActivityHarness(t, &fakeActivityStore{
		page: &storage.ActivityPage{
			Total: 1,
			Rows: []storage.Activity{{
				LabelID:    "act-1",
				SportType:  100,
				SportName:  strptr("Run"),
				Date:       time.Date(2026, 1, 15, 2, 0, 0, 0, time.UTC), // 10:00 Shanghai
				DistanceM:  fptr(5234),
				DurationS:  fptr(1830), // 30:30
				AvgPaceSKm: fptr(350),  // 5:50/km
			}},
			MonthlySummaries: map[string]storage.ActivityMonthly{
				"2026-01": {ActivityCount: 1, TotalRunKm: 5.234, RunDurationS: 1830, DurationS: 1830},
			},
		},
	})
	w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities", h.bearer(t, activityUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	var resp activitiesListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	sum, ok := resp.MonthlySummaries["2026-01"]
	if !ok {
		t.Fatalf("month 2026-01 missing")
	}
	if sum.TotalRunKm != 5.2 {
		t.Fatalf("total_run_km = %v, want 5.2 (rounded)", sum.TotalRunKm)
	}
	if sum.RunDurationS != 1830 {
		t.Fatalf("run_duration_s = %d, want 1830", sum.RunDurationS)
	}
	if len(resp.Activities) != 1 {
		t.Fatalf("activities len = %d, want 1", len(resp.Activities))
	}
	it := resp.Activities[0]
	if it.DistanceKm != 5.23 {
		t.Fatalf("distance_km = %v, want 5.23", it.DistanceKm)
	}
	if it.DurationFmt != "00:30:30" {
		t.Fatalf("duration_fmt = %q, want 00:30:30", it.DurationFmt)
	}
	if it.PaceFmt != "5:50/km" {
		t.Fatalf("pace_fmt = %q, want 5:50/km", it.PaceFmt)
	}
	if !strings.HasPrefix(it.Date, "2026-01-15") {
		t.Fatalf("date = %q, want Shanghai 2026-01-15…", it.Date)
	}
}

// --- detail: auth / not found ------------------------------------------------

func TestActivityDetail_CrossUser_403(t *testing.T) {
	h := newActivityHarness(t, &fakeActivityStore{})
	w := h.do(http.MethodGet, "/api/"+activityUserB+"/activities/act-1", h.bearer(t, activityUserA))
	if w.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", w.Code)
	}
}

func TestActivityDetail_NotFound_404(t *testing.T) {
	h := newActivityHarness(t, &fakeActivityStore{activity: nil}) // nil → not found
	w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities/missing", h.bearer(t, activityUserA))
	if w.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", w.Code)
	}
	var er errorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &er); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if er.Error != "Not found" {
		t.Fatalf("error = %q, want \"Not found\"", er.Error)
	}
}

// --- detail: include=timeseries toggle + null/empty invariants ---------------

func baseDetailStore() *fakeActivityStore {
	return &fakeActivityStore{
		activity: &storage.Activity{LabelID: "act-1", SportType: 100, Date: time.Date(2026, 1, 15, 2, 0, 0, 0, time.UTC)},
		laps: map[string][]storage.Lap{
			"autoKm": {{LapIndex: 0, LapType: "autoKm", DistanceM: fptr(1000), DurationS: fptr(300), AvgPace: fptr(300)}},
			"type2":  {{LapIndex: 0, LapType: "type2", ExerciseType: iptr(3), Mode: iptr(1)}},
		},
		zones: []storage.ActivityWatchZone{{ZoneType: "hr", ZoneIndex: 1, DurationS: iptr(60)}},
	}
}

func TestActivityDetail_NoInclude_OmitsTimeseries(t *testing.T) {
	h := newActivityHarness(t, baseDetailStore())
	w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities/act-1", h.bearer(t, activityUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	if h.store.tsCalled {
		t.Fatalf("ActivityTimeseries must not be called without ?include=timeseries")
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := raw["timeseries"]; present {
		t.Fatalf("timeseries key must be omitted without include")
	}
	// laps/segments/zones are [] (never null); training-load + linked workout are null.
	for _, k := range []string{"laps", "segments", "zones"} {
		if strings.HasPrefix(string(raw[k]), "[") == false {
			t.Fatalf("%s = %s, want a JSON array", k, raw[k])
		}
	}
	if got := string(raw["stride_training_load"]); got != "null" {
		t.Fatalf("stride_training_load = %s, want null", got)
	}
	if got := string(raw["linked_scheduled_workout"]); got != "null" {
		t.Fatalf("linked_scheduled_workout = %s, want null", got)
	}
	// pauses defaults to [] (never null).
	var resp activityDetailResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal resp: %v", err)
	}
	if string(resp.Activity.Pauses) != "[]" {
		t.Fatalf("pauses = %s, want []", resp.Activity.Pauses)
	}
	// segment carries seg_name + mode.
	if len(resp.Segments) != 1 || resp.Segments[0].SegName == "" {
		t.Fatalf("segment seg_name not populated: %+v", resp.Segments)
	}
}

func TestActivityDetail_IncludeTimeseries_Downsamples(t *testing.T) {
	store := baseDetailStore()
	// 2500 points → step = 2 → expect 1250 samples (idx 0,2,4,…).
	pts := make([]storage.TimeseriesPoint, 2500)
	for i := range pts {
		pts[i] = storage.TimeseriesPoint{Timestamp: i64ptr(int64(i)), HeartRate: iptr(120 + i%40)}
	}
	store.series = pts
	h := newActivityHarness(t, store)
	w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities/act-1?include=timeseries", h.bearer(t, activityUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	if !h.store.tsCalled {
		t.Fatalf("ActivityTimeseries must be called with ?include=timeseries")
	}
	var resp activityDetailResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Timeseries == nil {
		t.Fatalf("timeseries must be present with include")
	}
	if len(*resp.Timeseries) != 1250 {
		t.Fatalf("downsampled len = %d, want 1250", len(*resp.Timeseries))
	}
	// First kept point is index 0.
	if got := (*resp.Timeseries)[0].Timestamp; got == nil || *got != 0 {
		t.Fatalf("first sample timestamp = %v, want 0", got)
	}
	// Second kept point is index 2 (step stride).
	if got := (*resp.Timeseries)[1].Timestamp; got == nil || *got != 2 {
		t.Fatalf("second sample timestamp = %v, want 2", got)
	}
}

func TestActivityDetail_EmptyTimeseries_IncludeYieldsArray(t *testing.T) {
	store := baseDetailStore()
	store.series = nil // present-but-empty
	h := newActivityHarness(t, store)
	w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities/act-1?include=timeseries", h.bearer(t, activityUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got := string(raw["timeseries"]); got != "[]" {
		t.Fatalf("timeseries = %s, want [] (present-but-empty)", got)
	}
}

// --- detail: training load serialization -------------------------------------

func TestActivityDetail_TrainingLoad_ReasonsAndFlags(t *testing.T) {
	store := baseDetailStore()
	store.load = &storage.ActivityTrainingLoad{
		LabelID:          "act-1",
		ActivityDate:     "2026-01-15",
		AlgorithmVersion: 2,
		ExcludedFromPMC:  true,
		ReasonsJSON:      strptr(`["short_activity","low_coverage"]`),
	}
	h := newActivityHarness(t, store)
	w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities/act-1", h.bearer(t, activityUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	var resp activityDetailResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	tl := resp.StrideTrainingLoad
	if tl == nil {
		t.Fatalf("stride_training_load must be present when the store returns a row")
	}
	if !tl.ExcludedFromPMC {
		t.Fatalf("excluded_from_pmc = false, want true")
	}
	if len(tl.Reasons) != 2 || tl.Reasons[0] != "short_activity" {
		t.Fatalf("reasons = %v, want [short_activity low_coverage]", tl.Reasons)
	}
}

func TestActivityDetail_TrainingLoad_NilReasons_EmptyList(t *testing.T) {
	store := baseDetailStore()
	store.load = &storage.ActivityTrainingLoad{LabelID: "act-1", ActivityDate: "2026-01-15", ReasonsJSON: nil}
	h := newActivityHarness(t, store)
	w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities/act-1", h.bearer(t, activityUserA))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	// reasons must serialize as [] (never null).
	var probe struct {
		Load struct {
			Reasons json.RawMessage `json:"reasons"`
		} `json:"stride_training_load"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &probe); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if string(probe.Load.Reasons) != "[]" {
		t.Fatalf("reasons = %s, want []", probe.Load.Reasons)
	}
}

// --- 500 propagation ---------------------------------------------------------

func TestActivityList_StoreError_500(t *testing.T) {
	h := newActivityHarness(t, &fakeActivityStore{pageErr: errors.New("boom")})
	if w := h.do(http.MethodGet, "/api/"+activityUserA+"/activities", h.bearer(t, activityUserA)); w.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d, want 500", w.Code)
	}
}
