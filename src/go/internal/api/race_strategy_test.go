package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

// Race-strategy endpoint tests (#396), riding the engagement harness so tier
// guards run against the real auth middleware. The offboarding / gap-lock
// rules of the store are pinned against real MySQL in internal/storage.

// fakeRaceStrategyStore is an in-memory RaceStrategyStore. It keeps one row
// per (user, race, target) like the UNIQUE(user, event, target) key: the same
// goal overwrites in place, different goals coexist.
type fakeRaceStrategyStore struct {
	strategies map[string]map[uint64]map[string]*storage.RaceStrategy
	missing    map[uint64]bool
}

func newFakeRaceStrategyStore() *fakeRaceStrategyStore {
	return &fakeRaceStrategyStore{
		strategies: map[string]map[uint64]map[string]*storage.RaceStrategy{},
		missing:    map[uint64]bool{},
	}
}

func (f *fakeRaceStrategyStore) UpsertRaceStrategy(_ context.Context, userID string, raceEventID uint64, targetTime, itemType, content string) (*storage.RaceStrategy, bool, error) {
	if f.missing[raceEventID] {
		return nil, false, storage.ErrRaceCalendarNotFound
	}
	byRace := f.strategies[userID]
	if byRace == nil {
		byRace = map[uint64]map[string]*storage.RaceStrategy{}
		f.strategies[userID] = byRace
	}
	byTarget := byRace[raceEventID]
	if byTarget == nil {
		byTarget = map[string]*storage.RaceStrategy{}
		byRace[raceEventID] = byTarget
	}
	now := time.Now().UTC()
	if cur := byTarget[targetTime]; cur != nil {
		cur.ItemType = itemType
		cur.Content = content
		cur.UpdatedAt = now
		return cur, false, nil
	}
	row := &storage.RaceStrategy{
		UserID: userID, RaceEventID: raceEventID, TargetFinishTime: targetTime,
		ItemType: itemType, Content: content,
		CreatedAt: now, UpdatedAt: now,
	}
	byTarget[targetTime] = row
	return row, true, nil
}

func (f *fakeRaceStrategyStore) GetRaceStrategies(_ context.Context, userID string, raceEventID uint64) ([]storage.RaceStrategy, error) {
	byTarget := f.strategies[userID][raceEventID]
	targets := make([]string, 0, len(byTarget))
	for target := range byTarget {
		targets = append(targets, target)
	}
	sort.Strings(targets)
	rows := make([]storage.RaceStrategy, 0, len(targets))
	for _, target := range targets {
		rows = append(rows, *byTarget[target])
	}
	return rows, nil
}

func (f *fakeRaceStrategyStore) DeleteRaceStrategy(_ context.Context, userID string, raceEventID uint64, targetTime string) error {
	byTarget := f.strategies[userID][raceEventID]
	if byTarget[targetTime] == nil {
		return storage.ErrRaceStrategyNotFound
	}
	delete(byTarget, targetTime)
	return nil
}

const strategyUserPath = "/api/users/11111111-2222-4333-8333-333333333333/race-strategies"

func TestRaceStrategy_TierGuards(t *testing.T) {
	h := newEngagementHarness(t)

	// The user surface refuses anonymous / internal callers like every other
	// "me" surface.
	for _, tc := range []struct{ name, method, path string }{
		{"get", http.MethodGet, "/api/users/me/race-strategies/7"},
		{"put", http.MethodPut, "/api/users/me/race-strategies/7"},
		{"delete", http.MethodDelete, "/api/users/me/race-strategies/7?target=2:55:00"},
	} {
		if w := h.do(t, tc.method, tc.path, nil, nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s without token = %d, want 401", tc.name, w.Code)
		}
		if w := h.do(t, tc.method, tc.path, nil, internalHdr()); w.Code != http.StatusUnauthorized {
			t.Errorf("%s as internal = %d, want 401", tc.name, w.Code)
		}
	}

	// The internal insert refuses end users (and anonymous callers).
	body := map[string]any{"race_event_id": 7, "item_type": "Marathon", "content": map[string]any{"race_name": "x", "target_finish_time": "2:55:00"}}
	if w := h.do(t, http.MethodPost, strategyUserPath, body, h.userToken(t)); w.Code != http.StatusForbidden {
		t.Errorf("insert as user = %d, want 403", w.Code)
	}
	if w := h.do(t, http.MethodPost, strategyUserPath, body, nil); w.Code != http.StatusUnauthorized {
		t.Errorf("insert without token = %d, want 401", w.Code)
	}
}

func TestRaceStrategy_InternalInsertVersionsByGoal(t *testing.T) {
	h := newEngagementHarness(t)

	w := h.do(t, http.MethodPost, strategyUserPath, map[string]any{
		"race_event_id": 30,
		"item_type":     "Marathon",
		"content":       map[string]any{"race_name": "上海马拉松", "target_finish_time": "2:55:00"},
	}, internalHdr())
	if w.Code != http.StatusCreated {
		t.Fatalf("insert 2:55:00 = %d: %s", w.Code, w.Body.String())
	}

	// A different goal is a new version, not an overwrite.
	w = h.do(t, http.MethodPost, strategyUserPath, map[string]any{
		"race_event_id": 30,
		"item_type":     "Marathon",
		"content":       map[string]any{"race_name": "上海马拉松", "target_finish_time": "2:50:00"},
	}, internalHdr())
	if w.Code != http.StatusCreated {
		t.Fatalf("insert 2:50:00 = %d: %s", w.Code, w.Body.String())
	}

	// The same goal overwrites its own version.
	w = h.do(t, http.MethodPost, strategyUserPath, map[string]any{
		"race_event_id": 30,
		"item_type":     "Marathon",
		"content":       map[string]any{"race_name": "上海马拉松", "target_finish_time": "2:55:00", "edited": true},
	}, internalHdr())
	if w.Code != http.StatusOK {
		t.Fatalf("overwrite 2:55:00 = %d: %s", w.Code, w.Body.String())
	}

	// The runner reads both versions, fastest goal first.
	w = h.do(t, http.MethodGet, "/api/users/me/race-strategies/30", nil, h.userToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("get = %d: %s", w.Code, w.Body.String())
	}
	var dto raceStrategyListDTO
	if err := json.Unmarshal(w.Body.Bytes(), &dto); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if dto.RaceID != 30 || len(dto.Strategies) != 2 {
		t.Fatalf("dto projection: %+v", dto)
	}
	first, second := dto.Strategies[0], dto.Strategies[1]
	if first.TargetFinishTime != "2:50:00" || second.TargetFinishTime != "2:55:00" {
		t.Fatalf("order: %+v then %+v, want 2:50:00 first", first, second)
	}
	if first.ItemType != "Marathon" || second.ItemType != "Marathon" {
		t.Fatalf("item types: %+v", dto)
	}
	if second.Content["edited"] != true {
		t.Fatalf("same-goal overwrite not kept: %v", second.Content)
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
		"race_event_id": 30, "item_type": "Sprint", "content": map[string]any{"race_name": "x", "target_finish_time": "2:55:00"},
	}, internalHdr()); w.Code != http.StatusUnprocessableEntity {
		t.Errorf("unknown item_type = %d, want 422", w.Code)
	}
	// The version key must be a well-formed target time — the goal is the
	// athlete's own H:MM:SS expression, not free text.
	for name, content := range map[string]any{
		"missing target": map[string]any{"race_name": "x"},
		"shorthand goal": map[string]any{"race_name": "x", "target_finish_time": "255"},
		"numeric target": map[string]any{"race_name": "x", "target_finish_time": 255},
	} {
		if w := h.do(t, http.MethodPost, strategyUserPath, map[string]any{
			"race_event_id": 30, "item_type": "Marathon", "content": content,
		}, internalHdr()); w.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s = %d, want 422", name, w.Code)
		}
	}
	if w := h.do(t, http.MethodPost, strategyUserPath, map[string]any{
		"race_event_id": 30, "item_type": "Marathon",
	}, internalHdr()); w.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing content = %d, want 422", w.Code)
	}
	if w := h.do(t, http.MethodPost, "/api/users/not-a-uuid/race-strategies", map[string]any{
		"race_event_id": 30, "item_type": "Marathon", "content": map[string]any{"race_name": "x", "target_finish_time": "2:55:00"},
	}, internalHdr()); w.Code != http.StatusBadRequest {
		t.Errorf("invalid user = %d, want 400", w.Code)
	}

	h.strategies.missing[31] = true
	if w := h.do(t, http.MethodPost, strategyUserPath, map[string]any{
		"race_event_id": 31, "item_type": "Marathon", "content": map[string]any{"race_name": "x", "target_finish_time": "2:55:00"},
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
	// Editing a version keeps its own target: same key → overwrite.
	if w := h.do(t, http.MethodPut, "/api/users/me/race-strategies/30", map[string]any{
		"item_type": "Marathon", "content": map[string]any{"race_name": "杭州马拉松", "target_finish_time": "3:59:59", "note": "赛后复盘"},
	}, h.userToken(t)); w.Code != http.StatusOK {
		t.Fatalf("put update = %d: %s", w.Code, w.Body.String())
	}
	// The report page's recompute (用时=距离×配速) may shift the goal by a
	// second — that lands as its own version, not a silent overwrite.
	if w := h.do(t, http.MethodPut, "/api/users/me/race-strategies/30", map[string]any{
		"item_type": "Marathon", "content": map[string]any{"race_name": "杭州马拉松", "target_finish_time": "4:00:00"},
	}, h.userToken(t)); w.Code != http.StatusCreated {
		t.Fatalf("put other goal = %d: %s", w.Code, w.Body.String())
	}

	w := h.do(t, http.MethodGet, "/api/users/me/race-strategies/30", nil, h.userToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("get = %d", w.Code)
	}
	var dto raceStrategyListDTO
	_ = json.Unmarshal(w.Body.Bytes(), &dto)
	if len(dto.Strategies) != 2 {
		t.Fatalf("versions = %d, want 2", len(dto.Strategies))
	}
	if dto.Strategies[0].Content["note"] != "赛后复盘" {
		t.Fatalf("edit not kept: %v", dto.Strategies[0].Content)
	}
}

func TestRaceStrategy_UserDelete(t *testing.T) {
	h := newEngagementHarness(t)
	for _, target := range []string{"2:55:00", "2:50:00"} {
		if w := h.do(t, http.MethodPut, "/api/users/me/race-strategies/30", map[string]any{
			"item_type": "Marathon", "content": map[string]any{"race_name": "上海马拉松", "target_finish_time": target},
		}, h.userToken(t)); w.Code != http.StatusCreated {
			t.Fatalf("put %s = %d", target, w.Code)
		}
	}

	if w := h.do(t, http.MethodDelete, "/api/users/me/race-strategies/30?target=2:50:00", nil, h.userToken(t)); w.Code != http.StatusNoContent {
		t.Fatalf("delete = %d: %s", w.Code, w.Body.String())
	}
	if w := h.do(t, http.MethodDelete, "/api/users/me/race-strategies/30?target=2:50:00", nil, h.userToken(t)); w.Code != http.StatusNotFound {
		t.Fatalf("delete again = %d, want 404", w.Code)
	}
	if w := h.do(t, http.MethodDelete, "/api/users/me/race-strategies/30?target=255", nil, h.userToken(t)); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("delete invalid target = %d, want 422", w.Code)
	}

	w := h.do(t, http.MethodGet, "/api/users/me/race-strategies/30", nil, h.userToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("get = %d", w.Code)
	}
	var dto raceStrategyListDTO
	_ = json.Unmarshal(w.Body.Bytes(), &dto)
	if len(dto.Strategies) != 1 || dto.Strategies[0].TargetFinishTime != "2:55:00" {
		t.Fatalf("after delete: %+v, want only 2:55:00", dto.Strategies)
	}
}

func TestRaceStrategy_GetEmptyIsNotAnError(t *testing.T) {
	h := newEngagementHarness(t)
	w := h.do(t, http.MethodGet, "/api/users/me/race-strategies/404", nil, h.userToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("no strategies yet = %d, want 200 with empty list", w.Code)
	}
	var dto raceStrategyListDTO
	if err := json.Unmarshal(w.Body.Bytes(), &dto); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if dto.Strategies == nil || len(dto.Strategies) != 0 {
		t.Fatalf("strategies = %v, want []", dto.Strategies)
	}
}
