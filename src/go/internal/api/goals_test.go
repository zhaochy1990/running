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
	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// --- fake goal store ---------------------------------------------------------

// fakeGoalStore is an in-memory GoalStore. It models the ≤1-active invariant by
// keeping a single active goal per user; CreateRaceGoal replaces (archives) it.
type fakeGoalStore struct {
	active    map[string]*storage.RaceGoal
	createErr error
	getErr    error
	updateErr error
}

func newFakeGoalStore() *fakeGoalStore {
	return &fakeGoalStore{active: map[string]*storage.RaceGoal{}}
}

func (f *fakeGoalStore) GetActiveRaceGoal(_ context.Context, userID string) (*storage.RaceGoal, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	return f.active[userID], nil
}

func (f *fakeGoalStore) CreateRaceGoal(_ context.Context, g *storage.RaceGoal) (*storage.RaceGoal, error) {
	if f.createErr != nil {
		return nil, f.createErr
	}
	cp := *g
	if cp.GoalID == "" {
		cp.GoalID = uuid.NewString()
	}
	cp.Status = storage.RaceGoalStatusActive
	one := int8(1)
	cp.ActiveFlag = &one
	now := time.Now().UTC()
	cp.CreatedAt = now
	cp.UpdatedAt = now
	f.active[cp.UserID] = &cp
	return &cp, nil
}

func (f *fakeGoalStore) UpdateActiveRaceGoal(_ context.Context, upd *storage.RaceGoal) (*storage.RaceGoal, error) {
	if f.updateErr != nil {
		return nil, f.updateErr
	}
	cur := f.active[upd.UserID]
	if cur == nil || cur.GoalID != upd.GoalID {
		return nil, nil // 404
	}
	cur.RaceDate = upd.RaceDate
	cur.RaceDistance = upd.RaceDistance
	cur.RaceName = upd.RaceName
	cur.TargetFinishTime = upd.TargetFinishTime
	cur.WeeklyTrainingDays = upd.WeeklyTrainingDays
	cur.AvailableTimeSlots = upd.AvailableTimeSlots
	cur.StrengthWillingness = upd.StrengthWillingness
	cur.RaceLocation = upd.RaceLocation
	cur.RaceTimezone = upd.RaceTimezone
	cur.UpdatedAt = time.Now().UTC()
	return cur, nil
}

// --- harness -----------------------------------------------------------------

type goalHarness struct {
	svc   *Service
	store *fakeGoalStore
	key   *rsa.PrivateKey
}

func newGoalHarness(t *testing.T) *goalHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	store := newFakeGoalStore()
	svc := NewService(Config{
		Auth:      NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
		GoalStore: store,
	})
	return &goalHarness{svc: svc, store: store, key: key}
}

func (h *goalHarness) userToken(t *testing.T, sub string) string {
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
	return s
}

func (h *goalHarness) do(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
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
	h.svc.Router().ServeHTTP(w, r)
	return w
}

func (h *goalHarness) bearer(t *testing.T, sub string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + h.userToken(t, sub)}
}

// futureRaceDate / pastRaceDate are computed relative to today in Shanghai so the
// handler's future-date rule is exercised deterministically.
func futureRaceDate() string {
	return time.Now().In(timefmt.Shanghai).AddDate(1, 0, 0).Format("2006-01-02")
}

func pastRaceDate() string {
	return time.Now().In(timefmt.Shanghai).AddDate(-1, 0, 0).Format("2006-01-02")
}

// --- auth --------------------------------------------------------------------

func TestGoal_RequiresUserTier(t *testing.T) {
	h := newGoalHarness(t)
	const path = "/api/users/me/training-goal"
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut} {
		if w := h.do(method, path, "", nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s no token: code = %d, want 401", method, w.Code)
		}
		if w := h.do(method, path, "", internalHdr()); w.Code != http.StatusUnauthorized {
			t.Errorf("%s internal token: code = %d, want 401", method, w.Code)
		}
	}
}

// --- GET ---------------------------------------------------------------------

func TestGetGoal_NotFound(t *testing.T) {
	h := newGoalHarness(t)
	w := h.do(http.MethodGet, "/api/users/me/training-goal", "", h.bearer(t, testSub))
	if w.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404: %s", w.Code, w.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["detail"] != "No training goal found" {
		t.Errorf("detail = %q, want 'No training goal found'", body["detail"])
	}
}

func TestGetGoal_Found(t *testing.T) {
	h := newGoalHarness(t)
	name := "Chengdu FM"
	h.store.active[testSub] = &storage.RaceGoal{
		GoalID: "goal-1", UserID: testSub, Status: storage.RaceGoalStatusActive,
		RaceDate: futureRaceDate(), RaceDistance: "FM", RaceName: &name,
		WeeklyTrainingDays: 5, AvailableTimeSlots: []string{"morning"},
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	w := h.do(http.MethodGet, "/api/users/me/training-goal", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp goalResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.GoalID != "goal-1" || resp.RaceDistance != "FM" || resp.RaceName == nil || *resp.RaceName != "Chengdu FM" {
		t.Errorf("resp not reflected: %s", w.Body.String())
	}
	if resp.AvailableTimeSlots == nil || len(resp.AvailableTimeSlots) != 1 {
		t.Errorf("time slots = %v, want [morning]", resp.AvailableTimeSlots)
	}
}

func TestGetGoal_StoreError500(t *testing.T) {
	h := newGoalHarness(t)
	h.store.getErr = errors.New("db down")
	w := h.do(http.MethodGet, "/api/users/me/training-goal", "", h.bearer(t, testSub))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d, want 500", w.Code)
	}
}

// --- POST --------------------------------------------------------------------

func TestPostGoal_Valid(t *testing.T) {
	h := newGoalHarness(t)
	body := `{"type":"race","race_date":"` + futureRaceDate() + `","race_distance":"FM","weekly_training_days":5,"available_time_slots":["morning","evening"]}`
	w := h.do(http.MethodPost, "/api/users/me/training-goal", body, h.bearer(t, testSub))
	if w.Code != http.StatusCreated {
		t.Fatalf("code = %d, want 201: %s", w.Code, w.Body.String())
	}
	var resp goalResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.GoalID == "" {
		t.Errorf("goal_id not minted")
	}
	if resp.RaceDistance != "FM" || resp.WeeklyTrainingDays != 5 {
		t.Errorf("fields not reflected: %s", w.Body.String())
	}
	if h.store.active[testSub] == nil {
		t.Errorf("goal not persisted")
	}
}

// The dropped `type` field and any client goal_id are tolerated/ignored (the
// frontend still sends type:'race'; the server owns the id).
func TestPostGoal_ToleratesUnknownFields(t *testing.T) {
	h := newGoalHarness(t)
	body := `{"type":"race","goal_id":"client-supplied","race_date":"` + futureRaceDate() + `","race_distance":"10K","weekly_training_days":4}`
	w := h.do(http.MethodPost, "/api/users/me/training-goal", body, h.bearer(t, testSub))
	if w.Code != http.StatusCreated {
		t.Fatalf("code = %d, want 201: %s", w.Code, w.Body.String())
	}
	// available_time_slots omitted → serialized as [], never null.
	var resp goalResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.AvailableTimeSlots == nil {
		t.Errorf("available_time_slots = null, want [] when omitted")
	}
}

func TestPostGoal_PastDate422(t *testing.T) {
	h := newGoalHarness(t)
	body := `{"race_date":"` + pastRaceDate() + `","race_distance":"FM","weekly_training_days":5}`
	w := h.do(http.MethodPost, "/api/users/me/training-goal", body, h.bearer(t, testSub))
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422: %s", w.Code, w.Body.String())
	}
	var resp validationErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Detail) == 0 || resp.Detail[0].Loc[len(resp.Detail[0].Loc)-1] != "race_date" {
		t.Errorf("expected a body.race_date detail, got %+v", resp.Detail)
	}
	if h.store.active[testSub] != nil {
		t.Errorf("goal must not be persisted on validation failure")
	}
}

func TestPostGoal_BadDistance422(t *testing.T) {
	h := newGoalHarness(t)
	body := `{"race_date":"` + futureRaceDate() + `","race_distance":"marathon","weekly_training_days":5}`
	w := h.do(http.MethodPost, "/api/users/me/training-goal", body, h.bearer(t, testSub))
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422: %s", w.Code, w.Body.String())
	}
}

func TestPostGoal_WeeklyDaysOutOfRange422(t *testing.T) {
	h := newGoalHarness(t)
	body := `{"race_date":"` + futureRaceDate() + `","race_distance":"FM","weekly_training_days":7}`
	w := h.do(http.MethodPost, "/api/users/me/training-goal", body, h.bearer(t, testSub))
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422: %s", w.Code, w.Body.String())
	}
}

func TestPostGoal_BadTimeSlot422(t *testing.T) {
	h := newGoalHarness(t)
	body := `{"race_date":"` + futureRaceDate() + `","race_distance":"FM","weekly_training_days":5,"available_time_slots":["midnight"]}`
	w := h.do(http.MethodPost, "/api/users/me/training-goal", body, h.bearer(t, testSub))
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422: %s", w.Code, w.Body.String())
	}
}

// --- PUT ---------------------------------------------------------------------

func TestPutGoal_Match(t *testing.T) {
	h := newGoalHarness(t)
	h.store.active[testSub] = &storage.RaceGoal{
		GoalID: "goal-1", UserID: testSub, Status: storage.RaceGoalStatusActive,
		RaceDate: futureRaceDate(), RaceDistance: "FM", WeeklyTrainingDays: 5,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	body := `{"goal_id":"goal-1","race_date":"` + futureRaceDate() + `","race_distance":"HM","weekly_training_days":4}`
	w := h.do(http.MethodPut, "/api/users/me/training-goal", body, h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp goalResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.GoalID != "goal-1" || resp.RaceDistance != "HM" || resp.WeeklyTrainingDays != 4 {
		t.Errorf("update not reflected: %s", w.Body.String())
	}
}

func TestPutGoal_MismatchGoalID404(t *testing.T) {
	h := newGoalHarness(t)
	h.store.active[testSub] = &storage.RaceGoal{
		GoalID: "goal-1", UserID: testSub, Status: storage.RaceGoalStatusActive,
		RaceDate: futureRaceDate(), RaceDistance: "FM", WeeklyTrainingDays: 5,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	body := `{"goal_id":"stale-id","race_date":"` + futureRaceDate() + `","race_distance":"HM","weekly_training_days":4}`
	w := h.do(http.MethodPut, "/api/users/me/training-goal", body, h.bearer(t, testSub))
	if w.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404: %s", w.Code, w.Body.String())
	}
	var body2 map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body2); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body2["detail"] != "Training goal 'stale-id' not found" {
		t.Errorf("detail = %q, want \"Training goal 'stale-id' not found\"", body2["detail"])
	}
}

func TestPutGoal_MissingGoalID422(t *testing.T) {
	h := newGoalHarness(t)
	body := `{"race_date":"` + futureRaceDate() + `","race_distance":"HM","weekly_training_days":4}`
	w := h.do(http.MethodPut, "/api/users/me/training-goal", body, h.bearer(t, testSub))
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422 (goal_id required): %s", w.Code, w.Body.String())
	}
}
