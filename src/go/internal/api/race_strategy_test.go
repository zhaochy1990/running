package api

import (
	"context"
	"encoding/json"
	"fmt"
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
	nextID     uint64
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
	f.nextID++
	row := &storage.RaceStrategy{
		ID:     f.nextID,
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
	// Mirror the store's order: non-empty targets by (length, lexical) —
	// "H:MM:SS" hours are not zero-padded, so 2:55:00 sorts before 10:30:00 —
	// with '' last.
	sort.Slice(targets, func(i, j int) bool {
		a, b := targets[i], targets[j]
		if (a == "") != (b == "") {
			return b == ""
		}
		if len(a) != len(b) {
			return len(a) < len(b)
		}
		return a < b
	})
	rows := make([]storage.RaceStrategy, 0, len(targets))
	for _, target := range targets {
		rows = append(rows, *byTarget[target])
	}
	return rows, nil
}

func (f *fakeRaceStrategyStore) GetSharedRaceStrategy(_ context.Context, userID string, raceEventID, versionID uint64) (*storage.SharedRaceStrategyView, error) {
	for _, row := range f.strategies[userID][raceEventID] {
		if row.ID == versionID {
			return &storage.SharedRaceStrategyView{
				RaceName: "策略赛", RaceDate: "2032-04-10", Strategy: *row,
			}, nil
		}
	}
	// Wrong owner, wrong race and dead version are one uniform miss (#506).
	return nil, storage.ErrRaceStrategyNotFound
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
	// Editing a version keeps its own target: same key → overwrite, not a fork.
	if w := h.do(t, http.MethodPut, "/api/users/me/race-strategies/30", map[string]any{
		"item_type": "Marathon", "content": map[string]any{"race_name": "杭州马拉松", "target_finish_time": "3:59:59", "note": "赛后复盘"},
	}, h.userToken(t)); w.Code != http.StatusOK {
		t.Fatalf("put update = %d: %s", w.Code, w.Body.String())
	}

	w := h.do(t, http.MethodGet, "/api/users/me/race-strategies/30", nil, h.userToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("get = %d", w.Code)
	}
	var dto raceStrategyListDTO
	_ = json.Unmarshal(w.Body.Bytes(), &dto)
	if len(dto.Strategies) != 1 {
		t.Fatalf("versions = %d, want 1 (same-target edit must not fork)", len(dto.Strategies))
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
	if w := h.do(t, http.MethodDelete, "/api/users/me/race-strategies/30", nil, h.userToken(t)); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("delete without target = %d, want 422", w.Code)
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

func TestRaceStrategy_ShareLink(t *testing.T) {
	h := newEngagementHarness(t)
	uid := "11111111-2222-4333-8333-333333333333"
	userPath := "/api/users/" + uid + "/race-strategies"

	// Seed two versions; the share path carries the row id of the version
	// being shared, so capture them from the list DTO.
	for _, target := range []string{"2:55:00", "2:50:00"} {
		w := h.do(t, http.MethodPost, userPath, map[string]any{
			"race_event_id": 30, "item_type": "Marathon",
			"content": map[string]any{"race_name": "上海马拉松", "target_finish_time": target},
		}, internalHdr())
		if w.Code != http.StatusCreated {
			t.Fatalf("seed %s = %d: %s", target, w.Code, w.Body.String())
		}
	}
	w := h.do(t, http.MethodGet, "/api/users/me/race-strategies/30", nil, h.userToken(t))
	var list raceStrategyListDTO
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.Strategies) != 2 || list.Strategies[0].ID == 0 || list.Strategies[1].ID == 0 {
		t.Fatalf("list ids: %+v", list.Strategies)
	}
	v250 := list.Strategies[0] // fastest goal first
	if v250.TargetFinishTime != "2:50:00" {
		t.Fatalf("first version = %s, want 2:50:00", v250.TargetFinishTime)
	}

	// Anonymous GET — no token: this is the whole point of the share link.
	w = h.do(t, http.MethodGet, fmt.Sprintf("/api/race-strategies/shared/%s/30/%d", uid, v250.ID), nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("anonymous shared get = %d: %s", w.Code, w.Body.String())
	}
	var shared raceStrategySharedDTO
	if err := json.Unmarshal(w.Body.Bytes(), &shared); err != nil {
		t.Fatalf("decode shared: %v", err)
	}
	if shared.Race.Name == "" || shared.Race.RaceDate == "" {
		t.Fatalf("race context: %+v", shared.Race)
	}
	// The exact shared version — a logged-in friend must not see their own
	// (empty) strategies either.
	if shared.Strategy.ID != v250.ID || shared.Strategy.TargetFinishTime != "2:50:00" {
		t.Fatalf("shared version: %+v, want row %d (2:50:00)", shared.Strategy, v250.ID)
	}

	// Wrong owner / wrong race / dead version: one uniform 404, never a hint
	// about which part of the triple missed.
	other := "44444444-4444-4444-8444-444444444444"
	for name, path := range map[string]string{
		"wrong owner":  fmt.Sprintf("/api/race-strategies/shared/%s/30/%d", other, v250.ID),
		"wrong race":   fmt.Sprintf("/api/race-strategies/shared/%s/31/%d", uid, v250.ID),
		"dead version": fmt.Sprintf("/api/race-strategies/shared/%s/30/999", uid),
	} {
		if w := h.do(t, http.MethodGet, path, nil, nil); w.Code != http.StatusNotFound {
			t.Errorf("%s = %d, want 404", name, w.Code)
		}
	}

	// Malformed params are rejected before any lookup.
	for name, path := range map[string]string{
		"bad uuid":     "/api/race-strategies/shared/not-a-uuid/30/1",
		"zero race":    fmt.Sprintf("/api/race-strategies/shared/%s/0/1", uid),
		"zero version": fmt.Sprintf("/api/race-strategies/shared/%s/30/0", uid),
		"bad version":  fmt.Sprintf("/api/race-strategies/shared/%s/30/x", uid),
	} {
		if w := h.do(t, http.MethodGet, path, nil, nil); w.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, w.Code)
		}
	}
}
