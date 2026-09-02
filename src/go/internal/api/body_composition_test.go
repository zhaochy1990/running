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
	"gorm.io/gorm"

	"github.com/zhaochy1990/stride/internal/storage"
)

// ─── fake store ─────────────────────────────────────────────────────────────

type fakeBodyCompStore struct {
	scans     map[string]*storage.BodyCompositionScanRecord // key = scanDate
	byUser    map[string][]string                           // userID -> []scanDate (newest first)
	upsertErr error
	listErr   error
	latestErr error
}

func newFakeBodyCompStore() *fakeBodyCompStore {
	return &fakeBodyCompStore{
		scans:  map[string]*storage.BodyCompositionScanRecord{},
		byUser: map[string][]string{},
	}
}

func (f *fakeBodyCompStore) addScan(userID string, scan *storage.BodyCompositionScanRecord) {
	scan.UserID = userID
	f.scans[scan.ScanDate] = scan
	dates := f.byUser[userID]
	inserted := false
	for i, d := range dates {
		if scan.ScanDate > d {
			dates = append(dates[:i+1], dates[i:]...)
			dates[i] = scan.ScanDate
			inserted = true
			break
		}
	}
	if !inserted {
		dates = append(dates, scan.ScanDate)
	}
	f.byUser[userID] = dates
}

func (f *fakeBodyCompStore) ListBodyCompositionScans(_ context.Context, userID string, days int) ([]storage.BodyCompositionScanRecord, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	dates := f.byUser[userID]
	var out []storage.BodyCompositionScanRecord
	cutoff := ""
	if days > 0 {
		cutoff = time.Now().AddDate(0, 0, -days).Format("2006-01-02")
	}
	for _, d := range dates {
		if days > 0 && d < cutoff {
			continue
		}
		if s, ok := f.scans[d]; ok {
			out = append(out, *s)
		}
	}
	return out, nil
}

func (f *fakeBodyCompStore) GetBodyCompositionScan(_ context.Context, userID, scanDate string) (*storage.BodyCompositionScanRecord, error) {
	s, ok := f.scans[scanDate]
	if !ok || s.UserID != userID {
		return nil, gorm.ErrRecordNotFound
	}
	return s, nil
}

func (f *fakeBodyCompStore) LatestBodyCompositionScan(_ context.Context, userID string) (*storage.BodyCompositionScanRecord, error) {
	if f.latestErr != nil {
		return nil, f.latestErr
	}
	dates := f.byUser[userID]
	if len(dates) == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	return f.scans[dates[0]], nil
}

func (f *fakeBodyCompStore) PreviousBodyCompositionScan(_ context.Context, userID, beforeDate string) (*storage.BodyCompositionScanRecord, error) {
	dates := f.byUser[userID]
	for _, d := range dates {
		if d < beforeDate {
			return f.scans[d], nil
		}
	}
	return nil, gorm.ErrRecordNotFound
}

func (f *fakeBodyCompStore) UpsertBodyCompositionScan(_ context.Context, userID string, input *storage.BodyCompositionScanRecord) (*storage.BodyCompositionScanRecord, error) {
	if f.upsertErr != nil {
		return nil, f.upsertErr
	}
	if existing, ok := f.scans[input.ScanDate]; ok && existing.UserID == userID {
		existing.WeightKg = input.WeightKg
		existing.BodyFatPct = input.BodyFatPct
		existing.SmmKg = input.SmmKg
		existing.FatMassKg = input.FatMassKg
		existing.VisceralFatLevel = input.VisceralFatLevel
		existing.Segments = input.Segments
		return existing, nil
	}
	input.ID = "scan-" + input.ScanDate
	input.UserID = userID
	input.IngestedAt = time.Now().UTC()
	f.addScan(userID, input)
	return input, nil
}

func (f *fakeBodyCompStore) HasBodyComposition(_ context.Context, userID string) (bool, error) {
	return len(f.byUser[userID]) > 0, nil
}

func testScan(date string, weight, bf, smm, fat float64, vf int) *storage.BodyCompositionScanRecord {
	return &storage.BodyCompositionScanRecord{
		ScanDate: date, WeightKg: weight, BodyFatPct: bf,
		SmmKg: smm, FatMassKg: fat, VisceralFatLevel: vf,
		Segments: []storage.BodyCompositionSegmentRecord{
			{Segment: storage.SegLeftArm, LeanMassKg: 2.5, FatMassKg: 1.2, LeanPctOfStandard: floatPtr(95.0), FatPctOfStandard: floatPtr(110.0)},
			{Segment: storage.SegRightArm, LeanMassKg: 2.6, FatMassKg: 1.3, LeanPctOfStandard: floatPtr(96.0), FatPctOfStandard: floatPtr(108.0)},
			{Segment: storage.SegTrunk, LeanMassKg: 18.0, FatMassKg: 8.0, LeanPctOfStandard: floatPtr(102.0), FatPctOfStandard: floatPtr(95.0)},
			{Segment: storage.SegLeftLeg, LeanMassKg: 8.0, FatMassKg: 3.5, LeanPctOfStandard: floatPtr(90.0), FatPctOfStandard: floatPtr(120.0)},
			{Segment: storage.SegRightLeg, LeanMassKg: 8.1, FatMassKg: 3.6, LeanPctOfStandard: floatPtr(91.0), FatPctOfStandard: floatPtr(118.0)},
		},
	}
}

// ─── harness ────────────────────────────────────────────────────────────────

type bcHarness struct {
	svc *Service
	key *rsa.PrivateKey
}

func newBCHarness(t *testing.T, store BodyCompositionStore) *bcHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	svc := NewService(Config{
		Enqueuer:                newFakeJobs(),
		Jobs:                    newFakeJobs(),
		JobsIdem:                newFakeJobs(),
		Pipelines:               newFakeRuns(),
		Runs:                    newFakeRuns(),
		RunsList:                newFakeRuns(),
		RunsIdem:                newFakeRuns(),
		JobUserInitiable:        map[string]bool{},
		PipelineUserInitiable:   map[string]bool{},
		WatchSyncJobType:        "watch_sync",
		SyncPipelineFull:        "onboarding",
		SyncPipelineIncremental: "data_sync",
		Auth:                    NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
		BodyCompositionStore:    store,
	})
	return &bcHarness{svc: svc, key: key}
}

func (h *bcHarness) userToken(t *testing.T, sub string) string {
	t.Helper()
	return signUserToken(t, h.key, sub)
}

func (h *bcHarness) do(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	return doRequest(h.svc, method, path, body, headers)
}

// doRequest mimics the harness.do method from api_test.go.
func doRequest(svc *Service, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	svc.Router().ServeHTTP(w, r)
	return w
}

// ─── tests ──────────────────────────────────────────────────────────────────

func TestBodyComposition_List(t *testing.T) {
	store := newFakeBodyCompStore()
	store.addScan("user-1", testScan("2026-08-15", 70.5, 21.0, 31.5, 14.8, 8))
	store.addScan("user-1", testScan("2026-08-01", 71.0, 21.5, 31.2, 15.3, 9))

	h := newBCHarness(t, store)
	token := h.userToken(t, "user-1")
	w := h.do(http.MethodGet, "/api/user-1/body-composition", "", map[string]string{
		"Authorization": "Bearer " + token,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Scans []map[string]any `json:"scans"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Scans) != 2 {
		t.Fatalf("scan count = %d, want 2", len(resp.Scans))
	}
	if resp.Scans[0]["scan_date"] != "2026-08-15" {
		t.Errorf("first scan date = %v, want 2026-08-15", resp.Scans[0]["scan_date"])
	}
	if _, ok := resp.Scans[0]["leg_smm_delta"]; !ok {
		t.Error("missing leg_smm_delta in response")
	}
	if _, ok := resp.Scans[0]["upper_lower_smm_ratio"]; !ok {
		t.Error("missing upper_lower_smm_ratio in response")
	}
	if _, ok := resp.Scans[0]["left_arm_smm_kg"]; !ok {
		t.Error("missing left_arm_smm_kg in response")
	}
	segs, ok := resp.Scans[0]["segments"].([]any)
	if !ok || len(segs) != 5 {
		t.Fatalf("segments count wrong")
	}
}

func TestBodyComposition_ListWithDays_Invalid(t *testing.T) {
	store := newFakeBodyCompStore()
	h := newBCHarness(t, store)
	token := h.userToken(t, "user-1")

	w := h.do(http.MethodGet, "/api/user-1/body-composition?days=abc", "", map[string]string{
		"Authorization": "Bearer " + token,
	})
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid days status = %d", w.Code)
	}

	w = h.do(http.MethodGet, "/api/user-1/body-composition?days=0", "", map[string]string{
		"Authorization": "Bearer " + token,
	})
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("days=0 status = %d", w.Code)
	}
}

func TestBodyComposition_Summary_WithData(t *testing.T) {
	store := newFakeBodyCompStore()
	store.addScan("user-1", testScan("2026-08-01", 71.0, 21.5, 31.2, 15.3, 9))
	store.addScan("user-1", testScan("2026-08-15", 70.5, 21.0, 31.5, 14.8, 8))

	h := newBCHarness(t, store)
	token := h.userToken(t, "user-1")
	w := h.do(http.MethodGet, "/api/user-1/body-composition/summary", "", map[string]string{
		"Authorization": "Bearer " + token,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["latest"] == nil {
		t.Fatal("latest is nil")
	}
	if resp["deltas"] == nil {
		t.Fatal("deltas is nil")
	}
	deltas := resp["deltas"].(map[string]any)
	if deltas["prev_date"] != "2026-08-01" {
		t.Errorf("prev_date = %v, want 2026-08-01", deltas["prev_date"])
	}
	checkpoints, ok := resp["checkpoints"].([]any)
	if !ok || len(checkpoints) != 3 {
		t.Fatalf("checkpoints count = %v, want 3", len(checkpoints))
	}
}

func TestBodyComposition_Summary_Empty(t *testing.T) {
	store := newFakeBodyCompStore()
	h := newBCHarness(t, store)
	token := h.userToken(t, "user-empty")
	w := h.do(http.MethodGet, "/api/user-empty/body-composition/summary", "", map[string]string{
		"Authorization": "Bearer " + token,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Latest      *json.RawMessage  `json:"latest"`
		Deltas      *json.RawMessage  `json:"deltas"`
		Checkpoints []PhaseCheckpoint `json:"checkpoints"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Latest != nil {
		t.Error("latest should be null for empty user")
	}
	if resp.Deltas != nil {
		t.Error("deltas should be null for empty user")
	}
	if len(resp.Checkpoints) != 3 {
		t.Errorf("checkpoints = %d, want 3", len(resp.Checkpoints))
	}
}

func TestBodyComposition_GetScan_Found(t *testing.T) {
	store := newFakeBodyCompStore()
	store.addScan("user-1", testScan("2026-08-15", 70.5, 21.0, 31.5, 14.8, 8))

	h := newBCHarness(t, store)
	token := h.userToken(t, "user-1")
	w := h.do(http.MethodGet, "/api/user-1/body-composition/2026-08-15", "", map[string]string{
		"Authorization": "Bearer " + token,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var scan map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &scan); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if scan["scan_date"] != "2026-08-15" {
		t.Errorf("scan_date = %v", scan["scan_date"])
	}
}

func TestBodyComposition_GetScan_NotFound(t *testing.T) {
	store := newFakeBodyCompStore()
	h := newBCHarness(t, store)
	token := h.userToken(t, "user-1")
	w := h.do(http.MethodGet, "/api/user-1/body-composition/2020-01-01", "", map[string]string{
		"Authorization": "Bearer " + token,
	})
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestBodyComposition_Upsert_Create(t *testing.T) {
	store := newFakeBodyCompStore()
	h := newBCHarness(t, store)
	token := h.userToken(t, "user-1")

	body := `{"scan_date":"2026-08-15","weight_kg":70.5,"body_fat_pct":21.0,"smm_kg":31.5,"fat_mass_kg":14.8,"visceral_fat_level":8}`
	w := h.do(http.MethodPost, "/api/user-1/body-composition", body, map[string]string{
		"Authorization": "Bearer " + token,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["scan_date"] != "2026-08-15" {
		t.Errorf("scan_date = %v", resp["scan_date"])
	}
}

func TestBodyComposition_Upsert_ValidationError(t *testing.T) {
	store := newFakeBodyCompStore()
	h := newBCHarness(t, store)
	token := h.userToken(t, "user-1")

	// Missing required fields → ShouldBindJSON fails → 422
	body := `{"scan_date":"2026-08-15"}`
	w := h.do(http.MethodPost, "/api/user-1/body-composition", body, map[string]string{
		"Authorization": "Bearer " + token,
	})
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", w.Code)
	}
}

func TestBodyComposition_Auth_Forbidden(t *testing.T) {
	store := newFakeBodyCompStore()
	h := newBCHarness(t, store)
	token := h.userToken(t, "user-A")
	w := h.do(http.MethodGet, "/api/user-B/body-composition", "", map[string]string{
		"Authorization": "Bearer " + token,
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestBodyComposition_Auth_Internal(t *testing.T) {
	store := newFakeBodyCompStore()
	store.addScan("user-1", testScan("2026-08-15", 70.5, 21.0, 31.5, 14.8, 8))

	h := newBCHarness(t, store)
	w := h.do(http.MethodGet, "/api/user-1/body-composition/summary", "", internalHdr())
	if w.Code != http.StatusOK {
		t.Fatalf("internal status = %d", w.Code)
	}
}

func TestBodyComposition_List_ServerError(t *testing.T) {
	store := newFakeBodyCompStore()
	store.listErr = errors.New("db down")
	h := newBCHarness(t, store)
	token := h.userToken(t, "user-1")
	w := h.do(http.MethodGet, "/api/user-1/body-composition", "", map[string]string{
		"Authorization": "Bearer " + token,
	})
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", w.Code)
	}
}

// ─── derivation unit tests ──────────────────────────────────────────────────

func TestToScanDTO_DerivedFields(t *testing.T) {
	scan := testScan("2026-08-15", 70.5, 21.0, 31.5, 14.8, 8)
	dto := toScanDTO(scan)

	// leg_smm_delta = right_leg - left_leg = 8.1 - 8.0 = 0.1
	if dto.LegSmmDelta == nil || *dto.LegSmmDelta != 0.1 {
		t.Errorf("leg_smm_delta = %v, want 0.1", ptrValF(dto.LegSmmDelta))
	}
	// leg_fat_delta = 3.6 - 3.5 = 0.1
	if dto.LegFatDelta == nil || *dto.LegFatDelta != 0.1 {
		t.Errorf("leg_fat_delta = %v, want 0.1", ptrValF(dto.LegFatDelta))
	}
	// arm_smm_delta = 2.6 - 2.5 = 0.1
	if dto.ArmSmmDelta == nil || *dto.ArmSmmDelta != 0.1 {
		t.Errorf("arm_smm_delta = %v, want 0.1", ptrValF(dto.ArmSmmDelta))
	}
	// upper = 2.5 + 2.6 + 18.0 = 23.1; lower = 8.0 + 8.1 = 16.1; ratio = 23.1/16.1
	if dto.UpperLowerSmmRatio == nil {
		t.Fatal("upper_lower_smm_ratio is nil")
	}
	ratio := *dto.UpperLowerSmmRatio
	expected := 23.1 / 16.1
	if absF(ratio-expected) > 0.001 {
		t.Errorf("upper_lower_smm_ratio = %v, want ~%v", ratio, expected)
	}
	// Flat per-segment fields
	if dto.LeftArmSmmKg == nil || *dto.LeftArmSmmKg != 2.5 {
		t.Errorf("left_arm_smm_kg = %v, want 2.5", ptrValF(dto.LeftArmSmmKg))
	}
	if dto.TrunkFatKg == nil || *dto.TrunkFatKg != 8.0 {
		t.Errorf("trunk_fat_kg = %v, want 8.0", ptrValF(dto.TrunkFatKg))
	}
	if dto.RightLegLeanPctStd == nil || *dto.RightLegLeanPctStd != 91.0 {
		t.Errorf("right_leg_lean_pct_std = %v, want 91.0", ptrValF(dto.RightLegLeanPctStd))
	}
	// Segments array
	if len(dto.Segments) != 5 {
		t.Fatalf("segments count = %d, want 5", len(dto.Segments))
	}
}

func floatPtr(v float64) *float64 { return &v }

func ptrValF(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func absF(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// signUserToken creates a user JWT, matching the pattern from api_test.go.
func signUserToken(t *testing.T, key *rsa.PrivateKey, sub string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": sub,
		"iss": testIssuer,
		"aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Unix(),
	})
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}
