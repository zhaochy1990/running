package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

// Race-strategy endpoint tests (#396), riding the engagement harness so tier
// guards run against the real auth middleware. The offboarding / gap-lock
// rules of the store are pinned against real MySQL in internal/storage.

// fakeRaceStrategyStore is an in-memory RaceStrategyStore. It keeps one
// strategy per (user, race) like the UNIQUE(user, event) row and overwrites in
// place (latest-version-only contract).
type fakeRaceStrategyStore struct {
	strategies map[string]map[uint64]*storage.RaceStrategy
	missing    map[uint64]bool
}

func newFakeRaceStrategyStore() *fakeRaceStrategyStore {
	return &fakeRaceStrategyStore{
		strategies: map[string]map[uint64]*storage.RaceStrategy{},
		missing:    map[uint64]bool{},
	}
}

func (f *fakeRaceStrategyStore) UpsertRaceStrategy(_ context.Context, userID string, raceEventID uint64, itemType, content string) (*storage.RaceStrategy, bool, error) {
	if f.missing[raceEventID] {
		return nil, false, storage.ErrRaceCalendarNotFound
	}
	byRace := f.strategies[userID]
	if byRace == nil {
		byRace = map[uint64]*storage.RaceStrategy{}
		f.strategies[userID] = byRace
	}
	now := time.Now().UTC()
	if cur := byRace[raceEventID]; cur != nil {
		cur.ItemType = itemType
		cur.Content = content
		cur.UpdatedAt = now
		return cur, false, nil
	}
	row := &storage.RaceStrategy{
		UserID: userID, RaceEventID: raceEventID,
		ItemType: itemType, Content: content,
		CreatedAt: now, UpdatedAt: now,
	}
	byRace[raceEventID] = row
	return row, true, nil
}

func (f *fakeRaceStrategyStore) GetRaceStrategy(_ context.Context, userID string, raceEventID uint64) (*storage.RaceStrategy, error) {
	if row := f.strategies[userID][raceEventID]; row != nil {
		return row, nil
	}
	return nil, storage.ErrRaceStrategyNotFound
}

const strategyUserPath = "/api/users/11111111-2222-4333-8333-333333333333/race-strategies"

func TestRaceStrategy_TierGuards(t *testing.T) {
	h := newEngagementHarness(t)

	// The user surface refuses anonymous / internal callers like every other
	// "me" surface.
	for _, tc := range []struct{ name, method, path string }{
		{"get", http.MethodGet, "/api/users/me/race-strategies/7"},
		{"put", http.MethodPut, "/api/users/me/race-strategies/7"},
	} {
		if w := h.do(t, tc.method, tc.path, nil, nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s without token = %d, want 401", tc.name, w.Code)
		}
		if w := h.do(t, tc.method, tc.path, nil, internalHdr()); w.Code != http.StatusUnauthorized {
			t.Errorf("%s as internal = %d, want 401", tc.name, w.Code)
		}
	}

	// The internal insert refuses end users (and anonymous callers).
	body := map[string]any{"race_event_id": 7, "item_type": "Marathon", "content": map[string]any{"race_name": "x"}}
	if w := h.do(t, http.MethodPost, strategyUserPath, body, h.userToken(t)); w.Code != http.StatusForbidden {
		t.Errorf("insert as user = %d, want 403", w.Code)
	}
	if w := h.do(t, http.MethodPost, strategyUserPath, body, nil); w.Code != http.StatusUnauthorized {
		t.Errorf("insert without token = %d, want 401", w.Code)
	}
}

func TestRaceStrategy_InternalInsertKeepsLatest(t *testing.T) {
	h := newEngagementHarness(t)

	w := h.do(t, http.MethodPost, strategyUserPath, map[string]any{
		"race_event_id": 30,
		"item_type":     "Marathon",
		"content":       map[string]any{"race_name": "杭州马拉松", "target_finish_time": "3:59:59"},
	}, internalHdr())
	if w.Code != http.StatusCreated {
		t.Fatalf("first insert = %d: %s", w.Code, w.Body.String())
	}

	w = h.do(t, http.MethodPost, strategyUserPath, map[string]any{
		"race_event_id": 30,
		"item_type":     "Marathon",
		"content":       map[string]any{"race_name": "杭州马拉松", "target_finish_time": "3:55:00"},
	}, internalHdr())
	if w.Code != http.StatusOK {
		t.Fatalf("overwrite insert = %d: %s", w.Code, w.Body.String())
	}

	// The runner reads the latest version only.
	w = h.do(t, http.MethodGet, "/api/users/me/race-strategies/30", nil, h.userToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("get = %d: %s", w.Code, w.Body.String())
	}
	var dto raceStrategyDTO
	if err := json.Unmarshal(w.Body.Bytes(), &dto); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if dto.RaceID != 30 || dto.ItemType != "Marathon" {
		t.Fatalf("dto projection: %+v", dto)
	}
	if dto.Content["target_finish_time"] != "3:55:00" {
		t.Fatalf("latest version not kept: %v", dto.Content)
	}
}

func TestRaceStrategy_InternalInsertValidation(t *testing.T) {
	h := newEngagementHarness(t)

	if w := h.do(t, http.MethodPost, strategyUserPath, map[string]any{
		"race_event_id": 30, "item_type": "Marathon", "content": "not-an-object",
	}, internalHdr()); w.Code != http.StatusUnprocessableEntity {
		t.Errorf("scalar content = %d, want 422", w.Code)
	}
	if w := h.do(t, http.MethodPost, strategyUserPath, map[string]any{
		"race_event_id": 30, "item_type": "Sprint", "content": map[string]any{"race_name": "x"},
	}, internalHdr()); w.Code != http.StatusUnprocessableEntity {
		t.Errorf("unknown item_type = %d, want 422", w.Code)
	}
	if w := h.do(t, http.MethodPost, strategyUserPath, map[string]any{
		"race_event_id": 30, "item_type": "Marathon",
	}, internalHdr()); w.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing content = %d, want 422", w.Code)
	}
	if w := h.do(t, http.MethodPost, "/api/users/not-a-uuid/race-strategies", map[string]any{
		"race_event_id": 30, "item_type": "Marathon", "content": map[string]any{"race_name": "x"},
	}, internalHdr()); w.Code != http.StatusBadRequest {
		t.Errorf("invalid user = %d, want 400", w.Code)
	}

	h.strategies.missing[31] = true
	if w := h.do(t, http.MethodPost, strategyUserPath, map[string]any{
		"race_event_id": 31, "item_type": "Marathon", "content": map[string]any{"race_name": "x"},
	}, internalHdr()); w.Code != http.StatusNotFound {
		t.Errorf("unknown race = %d, want 404", w.Code)
	}
}

func TestRaceStrategy_UserPutEdits(t *testing.T) {
	h := newEngagementHarness(t)

	if w := h.do(t, http.MethodPut, "/api/users/me/race-strategies/30", map[string]any{
		"item_type": "Marathon", "content": map[string]any{"race_name": "杭州马拉松", "target_finish_time": "3:59:59"},
	}, h.userToken(t)); w.Code != http.StatusCreated {
		t.Fatalf("put create = %d: %s", w.Code, w.Body.String())
	}
	if w := h.do(t, http.MethodPut, "/api/users/me/race-strategies/30", map[string]any{
		"item_type": "Marathon", "content": map[string]any{"race_name": "杭州马拉松", "target_finish_time": "4:05:00"},
	}, h.userToken(t)); w.Code != http.StatusOK {
		t.Fatalf("put update = %d: %s", w.Code, w.Body.String())
	}

	w := h.do(t, http.MethodGet, "/api/users/me/race-strategies/30", nil, h.userToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("get = %d", w.Code)
	}
	var dto raceStrategyDTO
	_ = json.Unmarshal(w.Body.Bytes(), &dto)
	if dto.Content["target_finish_time"] != "4:05:00" {
		t.Fatalf("edit not kept: %v", dto.Content)
	}
}

func TestRaceStrategy_GetMissing(t *testing.T) {
	h := newEngagementHarness(t)
	if w := h.do(t, http.MethodGet, "/api/users/me/race-strategies/404", nil, h.userToken(t)); w.Code != http.StatusNotFound {
		t.Fatalf("missing strategy = %d, want 404", w.Code)
	}
}
