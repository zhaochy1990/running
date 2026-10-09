package api

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/racetypes"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// fakeUserCustomRaceStore is an in-memory UserCustomRaceStore keyed
// user -> id -> row. It models only what the HTTP layer needs (ownership
// scoping and full-update replacement); the MySQL specifics — column sizes,
// the (user_id, race_date) index, canonical user id — are pinned against a
// real database in internal/storage.
type fakeUserCustomRaceStore struct {
	rows map[string]map[uint64]*storage.UserCustomRace
	next uint64
}

func newFakeUserCustomRaceStore() *fakeUserCustomRaceStore {
	return &fakeUserCustomRaceStore{rows: map[string]map[uint64]*storage.UserCustomRace{}}
}

func (f *fakeUserCustomRaceStore) CreateUserCustomRace(_ context.Context, row *storage.UserCustomRace) error {
	f.next++
	row.ID = f.next
	byUser := f.rows[row.UserID]
	if byUser == nil {
		byUser = map[uint64]*storage.UserCustomRace{}
		f.rows[row.UserID] = byUser
	}
	cp := *row
	byUser[row.ID] = &cp
	return nil
}

func (f *fakeUserCustomRaceStore) UpdateUserCustomRace(_ context.Context, userID string, upd *storage.UserCustomRace) (*storage.UserCustomRace, error) {
	cur := f.rows[userID][upd.ID]
	if cur == nil {
		return nil, storage.ErrUserCustomRaceNotFound
	}
	saved := *upd
	saved.UserID = userID
	saved.CreatedAt = cur.CreatedAt
	saved.UpdatedAt = time.Now().UTC()
	f.rows[userID][upd.ID] = &saved
	cp := saved
	return &cp, nil
}

func (f *fakeUserCustomRaceStore) DeleteUserCustomRace(_ context.Context, userID string, id uint64) error {
	if f.rows[userID][id] == nil {
		return storage.ErrUserCustomRaceNotFound
	}
	delete(f.rows[userID], id)
	return nil
}

func (f *fakeUserCustomRaceStore) ListUserCustomRaces(_ context.Context, userID string) ([]storage.UserCustomRace, error) {
	out := []storage.UserCustomRace{}
	for _, row := range f.rows[userID] {
		out = append(out, *row)
	}
	return out, nil
}

// shDate renders the Shanghai day offset by days from today as YYYY-MM-DD.
func shDate(days int) string {
	return timefmt.ShanghaiToday().AddDate(0, 0, days).Format("2006-01-02")
}

// decodeCustomRace unwraps a customRaceDTO-shaped response body.
func decodeCustomRace(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return got
}

// TestCustomRaces_CreateValidation covers the create-body rules: the
// seven-chip item_type whitelist, YYYY-MM-DD format without bounds, the state
// vocabulary, and the distance sanity range — every rejection is a field-
// scoped 422; the happy paths pin backfill (past date → done) and the
// no-upper-bound far-future date (#457 修正决议).
func TestCustomRaces_CreateValidation(t *testing.T) {
	h := newEngagementHarness(t)
	hdr := h.userToken(t)

	bad := []struct {
		name     string
		field    string
		checkLoc bool // false for type mismatches, whose 422 is body-scoped
		body     map[string]any
	}{
		{"missing name", "name", true, map[string]any{"race_date": shDate(30), "item_type": racetypes.Trail}},
		{"over-long name", "name", true, map[string]any{"name": strings.Repeat("x", 129), "race_date": shDate(30), "item_type": racetypes.Trail}},
		{"missing race_date", "race_date", true, map[string]any{"name": "莫干山越野", "item_type": racetypes.Trail}},
		{"slash date", "race_date", true, map[string]any{"name": "莫干山越野", "race_date": "2026/01/02", "item_type": racetypes.Trail}},
		{"non-padded date", "race_date", true, map[string]any{"name": "莫干山越野", "race_date": "2026-2-3", "item_type": racetypes.Trail}},
		{"impossible date", "race_date", true, map[string]any{"name": "莫干山越野", "race_date": "2026-02-30", "item_type": racetypes.Trail}},
		{"missing item_type", "item_type", true, map[string]any{"name": "莫干山越野", "race_date": shDate(30)}},
		{"distance token not whitelisted", "item_type", true, map[string]any{"name": "莫干山越野", "race_date": shDate(30), "item_type": "21Km"}},
		{"unknown item_type", "item_type", true, map[string]any{"name": "莫干山越野", "race_date": shDate(30), "item_type": racetypes.Unknown}},
		{"lowercase trail", "item_type", true, map[string]any{"name": "莫干山越野", "race_date": shDate(30), "item_type": "trail"}},
		{"unknown state", "state", true, map[string]any{"name": "莫干山越野", "race_date": shDate(30), "item_type": racetypes.Trail, "state": "finished"}},
		{"zero distance", "distance_km", true, map[string]any{"name": "莫干山越野", "race_date": shDate(30), "item_type": racetypes.Trail, "distance_km": 0}},
		{"negative distance", "distance_km", true, map[string]any{"name": "莫干山越野", "race_date": shDate(30), "item_type": racetypes.Trail, "distance_km": -5}},
		{"over-column distance", "distance_km", true, map[string]any{"name": "莫干山越野", "race_date": shDate(30), "item_type": racetypes.Trail, "distance_km": 100000}},
		{"negative ascent", "ascent_m", false, map[string]any{"name": "莫干山越野", "race_date": shDate(30), "item_type": racetypes.Trail, "ascent_m": -3}},
	}
	for _, tt := range bad {
		w := h.do(t, http.MethodPost, "/api/users/me/custom-races", tt.body, hdr)
		if w.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422 (body %s)", tt.name, w.Code, w.Body.String())
			continue
		}
		var got validationErrorResponse
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: unmarshal 422: %v", tt.name, err)
		}
		if tt.checkLoc && (len(got.Detail) == 0 || !reflect.DeepEqual(got.Detail[0].Loc, []string{"body", tt.field})) {
			t.Errorf("%s: detail loc = %v, want [body %s]", tt.name, got.Detail, tt.field)
		}
	}

	// Backfill: a past date is accepted and derives done=true.
	w := h.do(t, http.MethodPost, "/api/users/me/custom-races", map[string]any{
		"name": "已完赛越野", "race_date": shDate(-1), "item_type": racetypes.Trail,
		"distance_km": 50.5, "ascent_m": 2600, "city": "湖州", "state": storage.CustomRaceStateRegistered,
	}, hdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("backfill create: status = %d, body %s", w.Code, w.Body.String())
	}
	got := decodeCustomRace(t, w.Body.Bytes())
	if got["state"] != storage.CustomRaceStateRegistered || got["done"] != true {
		t.Errorf("backfill row: state=%v done=%v, want registered/true", got["state"], got["done"])
	}
	if got["distance_km"] != 50.5 || got["ascent_m"] != 2600.0 {
		t.Errorf("backfill row: distance=%v ascent=%v, want 50.5/2600", got["distance_km"], got["ascent_m"])
	}

	// Far future has no upper bound and derives done=false; absent state
	// defaults to want.
	w = h.do(t, http.MethodPost, "/api/users/me/custom-races", map[string]any{
		"name": "梦想要有的", "race_date": "2999-01-01", "item_type": racetypes.Ultra,
	}, hdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("far-future create: status = %d, body %s", w.Code, w.Body.String())
	}
	got = decodeCustomRace(t, w.Body.Bytes())
	if got["state"] != storage.CustomRaceStateWant || got["done"] != false {
		t.Errorf("far-future row: state=%v done=%v, want want/false", got["state"], got["done"])
	}
}

// TestCustomRaces_FullUpdate pins the PUT semantics: every editable field is
// replaced, absent optionals are cleared, absent state falls back to want —
// and a valid PUT cannot go through without the row already existing.
func TestCustomRaces_FullUpdate(t *testing.T) {
	h := newEngagementHarness(t)
	hdr := h.userToken(t)

	w := h.do(t, http.MethodPost, "/api/users/me/custom-races", map[string]any{
		"name": "原始名", "race_date": shDate(30), "item_type": racetypes.Trail,
		"city": "原始城市", "note": "原始备注", "state": storage.CustomRaceStateRegistered,
	}, hdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: status = %d", w.Code)
	}
	created := decodeCustomRace(t, w.Body.Bytes())
	id := created["id"]

	w = h.do(t, http.MethodPut, "/api/users/me/custom-races/999", map[string]any{
		"name": "x", "race_date": shDate(1), "item_type": racetypes.Trail,
	}, hdr)
	if w.Code != http.StatusNotFound {
		t.Errorf("update nonexistent: status = %d, want 404", w.Code)
	}

	w = h.do(t, http.MethodPut, "/api/users/me/custom-races/"+idToPath(id), map[string]any{
		"name": "改名后", "race_date": shDate(60), "item_type": racetypes.Ultra, "distance_km": 100,
	}, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("update: status = %d, body %s", w.Code, w.Body.String())
	}
	got := decodeCustomRace(t, w.Body.Bytes())
	if got["name"] != "改名后" || got["item_type"] != racetypes.Ultra || got["race_date"] != shDate(60) {
		t.Errorf("update row: %+v, want replaced fields", got)
	}
	if got["city"] != "" || got["note"] != "" {
		t.Errorf("update row: optionals not cleared: city=%q note=%q", got["city"], got["note"])
	}
	if got["state"] != storage.CustomRaceStateWant {
		t.Errorf("update row: state=%v, want want (absent state default)", got["state"])
	}
}

// idToPath renders a decoded JSON id (float64) as the decimal path param.
func idToPath(v any) string {
	return strconv.FormatUint(uint64(v.(float64)), 10)
}

// TestCustomRaces_404Isolation pins the strict user_id scoping: another
// user's row and a missing row are indistinguishable — both 404, on every
// write path (PUT / DELETE).
func TestCustomRaces_404Isolation(t *testing.T) {
	h := newEngagementHarness(t)
	alice := h.userToken(t) // subject 11111111-2222-4333-8333-333333333333
	bob := h.userTokenFor(t, "22222222-3333-4444-8444-444444444444")

	w := h.do(t, http.MethodPost, "/api/users/me/custom-races", map[string]any{
		"name": "莫干山越野", "race_date": shDate(30), "item_type": racetypes.Trail,
	}, alice)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: status = %d", w.Code)
	}
	id := decodeCustomRace(t, w.Body.Bytes())["id"]
	path := "/api/users/me/custom-races/" + idToPath(id)

	// Bob touches Alice's row: PUT and DELETE both 404, and the row survives.
	for _, tc := range []struct {
		name, method string
	}{
		{"foreign PUT", http.MethodPut},
		{"foreign DELETE", http.MethodDelete},
	} {
		var body any
		if tc.method == http.MethodPut {
			body = map[string]any{"name": "抢走", "race_date": shDate(1), "item_type": racetypes.Trail}
		}
		w := h.do(t, tc.method, path, body, bob)
		if w.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", tc.name, w.Code)
		}
	}
	if got := len(h.customs.rows["11111111-2222-4333-8333-333333333333"]); got != 1 {
		t.Errorf("alice rows after foreign writes = %d, want 1 (untouched)", got)
	}

	// Owner deletes: 204 then 404 on the second try.
	w = h.do(t, http.MethodDelete, path, nil, alice)
	if w.Code != http.StatusNoContent {
		t.Errorf("owner DELETE: status = %d, want 204", w.Code)
	}
	w = h.do(t, http.MethodDelete, path, nil, alice)
	if w.Code != http.StatusNotFound {
		t.Errorf("second DELETE: status = %d, want 404", w.Code)
	}
}

// TestMyRaces_AggregationSort pins the unified「我的比赛」order: not-finished
// items ascending by race_date (official and custom interleaved by date),
// finished items sunk below (still ascending), and an offboarded placeholder
// (no race row, hence no date) last of all.
func TestMyRaces_AggregationSort(t *testing.T) {
	h := newEngagementHarness(t)
	hdr := h.userToken(t)
	uid := "11111111-2222-4333-8333-333333333333"
	ctx := context.Background()

	// Official: a future race (+10d), a past race (-5d), and a plan whose
	// race row is gone (offboarded placeholder).
	h.plans.races[101] = &storage.RaceCalendarEvent{ID: 101, Name: "未来马拉松", RaceDate: shDate(10), Published: true}
	h.plans.races[102] = &storage.RaceCalendarEvent{ID: 102, Name: "过去马拉松", RaceDate: shDate(-5), Published: true}
	for _, up := range []storage.RacePlanUpsert{
		{UserID: uid, RaceEventID: 101, ItemType: racetypes.Marathon, State: storage.RacePlanStateConfirmed},
		{UserID: uid, RaceEventID: 102, ItemType: racetypes.Marathon, State: storage.RacePlanStateRegistered},
		{UserID: uid, RaceEventID: 103, ItemType: racetypes.HalfMarathon, State: storage.RacePlanStateRegistered},
	} {
		if _, _, err := h.plans.UpsertRacePlan(ctx, up); err != nil {
			t.Fatalf("seed plan %d: %v", up.RaceEventID, err)
		}
	}

	// Custom: future (+5d, +20d) and past (-10d) rows.
	for _, row := range []storage.UserCustomRace{
		{UserID: uid, Name: "越野+20", RaceDate: shDate(20), ItemType: racetypes.Trail, State: storage.CustomRaceStateWant},
		{UserID: uid, Name: "越野-10", RaceDate: shDate(-10), ItemType: racetypes.Ultra, State: storage.CustomRaceStateRegistered},
		{UserID: uid, Name: "越野+5", RaceDate: shDate(5), ItemType: racetypes.Trail, State: storage.CustomRaceStateRegistered},
	} {
		if err := h.customs.CreateUserCustomRace(ctx, &row); err != nil {
			t.Fatalf("seed custom %s: %v", row.Name, err)
		}
	}

	w := h.do(t, http.MethodGet, "/api/users/me/my-races", nil, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("my-races: status = %d, body %s", w.Code, w.Body.String())
	}
	var got struct {
		Items []struct {
			Source string         `json:"source"`
			Plan   *racePlanDTO   `json:"plan"`
			Race   *customRaceDTO `json:"race"`
		} `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	type item struct {
		source, name string
		done         bool
	}
	want := []item{
		{"custom", "越野+5", false},
		{"official", "未来马拉松", false},
		{"custom", "越野+20", false},
		{"custom", "越野-10", true},
		{"official", "过去马拉松", true},
		{"official", "", true}, // offboarded placeholder: no race row, sinks last
	}
	if len(got.Items) != len(want) {
		t.Fatalf("items = %d, want %d (body %s)", len(got.Items), len(want), w.Body.String())
	}
	for i, wi := range want {
		gi := got.Items[i]
		name := ""
		done := false
		switch gi.Source {
		case "official":
			if gi.Plan == nil || gi.Plan.Race == nil {
				name, done = "", true // offboarded placeholder
				if gi.Plan != nil && !gi.Plan.Offboarded {
					t.Errorf("item %d: placeholder plan not marked offboarded", i)
				}
			} else {
				name = gi.Plan.Race.Name
				done = gi.Plan.Race.RaceDate < shDate(0) // YYYY-MM-DD string compare
			}
		case "custom":
			if gi.Race == nil {
				t.Fatalf("item %d: custom item without race payload", i)
			}
			name, done = gi.Race.Name, gi.Race.Done
		default:
			t.Errorf("item %d: source = %q", i, gi.Source)
		}
		if gi.Source != wi.source || name != wi.name || done != wi.done {
			t.Errorf("item %d = {%s %q done=%v}, want {%s %q done=%v}", i, gi.Source, name, done, wi.source, wi.name, wi.done)
		}
	}
}
