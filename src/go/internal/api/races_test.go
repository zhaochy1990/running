package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/zhaochy1990/stride/internal/storage"
)

// fakeRaceStore returns canned joined race rows. Storage returns them newest
// first already; the handler must preserve that order verbatim. The write side
// is a minimal in-memory races table: label_id present = row exists, so 404s
// and the user_cleared lifecycle are observable.
type fakeRaceStore struct {
	rows  []storage.UserRaceRow
	races map[string]*fakeRaceRow
}

type fakeRaceRow struct {
	displayName *string
	itemID      *int64
	evidence    string
}

func (f *fakeRaceStore) UserRaces(_ context.Context, _ string) ([]storage.UserRaceRow, error) {
	return f.rows, nil
}

func (f *fakeRaceStore) SetRaceDisplayName(_ context.Context, _, labelID string, displayName *string) (bool, error) {
	r, ok := f.races[labelID]
	if !ok {
		return false, nil
	}
	r.displayName = displayName
	return true, nil
}

func (f *fakeRaceStore) ClearRaceCalendarLink(_ context.Context, _, labelID string) (bool, error) {
	r, ok := f.races[labelID]
	if !ok {
		return false, nil
	}
	if r.itemID != nil {
		r.itemID = nil
		r.evidence = "user_cleared"
	}
	return true, nil
}

func f64ptr(v float64) *float64 { return &v }
func iptr2(v int) *int          { return &v }
func i64ptr2(v int64) *int64    { return &v }
func sptr2(v string) *string    { return &v }

func TestGetRaces_ListAndBands(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	// Inject an internal-tier caller (authorizeUser passes any user path).
	r.Use(func(c *gin.Context) { c.Set(callerContextKey, Caller{Tier: TierInternal}) })

	marathonM, hmM := 42195.0, 21097.5
	oddM := 25000.0
	store := &fakeRaceStore{rows: []storage.UserRaceRow{
		{LabelID: "l-hm", Name: sptr2("杭州半程马拉松"), Date: time.Date(2026, 3, 22, 1, 0, 0, 0, time.UTC),
			DistanceM: &hmM, DurationS: f64ptr(5700), AvgPaceSKm: f64ptr(270), AvgHR: iptr2(168), MaxHR: iptr2(182)},
		{LabelID: "l-fm", Name: sptr2("上海马拉松"), Date: time.Date(2025, 11, 30, 0, 30, 0, 0, time.UTC),
			DistanceM: &marathonM, DurationS: f64ptr(13980), AvgPaceSKm: f64ptr(331), AvgHR: iptr2(158), MaxHR: iptr2(177), ThumbURL: sptr2("https://cdn.example/t.png")},
		{LabelID: "l-odd", Name: nil, Date: time.Date(2025, 5, 4, 2, 0, 0, 0, time.UTC),
			DistanceM: &oddM, DurationS: nil, AvgPaceSKm: nil},
	}}
	newRaceRoutes(store, nil).register(r.Group(""))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/u1/races", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}

	var resp racesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.UserID != "u1" {
		t.Errorf("user_id = %q, want u1", resp.UserID)
	}
	if len(resp.Races) != 3 {
		t.Fatalf("races len = %d, want 3 (%+v)", len(resp.Races), resp.Races)
	}

	hm, fm, odd := resp.Races[0], resp.Races[1], resp.Races[2]
	if hm.LabelID != "l-hm" || fm.LabelID != "l-fm" || odd.LabelID != "l-odd" {
		t.Fatalf("order changed: got %s,%s,%s — want storage order preserved", resp.Races[0].LabelID, resp.Races[1].LabelID, resp.Races[2].LabelID)
	}

	if hm.DistanceBand != "half_marathon" {
		t.Errorf("hm distance_band = %q, want half_marathon", hm.DistanceBand)
	}
	if fm.DistanceBand != "marathon" {
		t.Errorf("fm distance_band = %q, want marathon", fm.DistanceBand)
	}
	if odd.DistanceBand != "other" {
		t.Errorf("odd distance_band = %q, want other", odd.DistanceBand)
	}
	if hm.DistanceKm != 21.1 {
		t.Errorf("hm distance_km = %v, want 21.1", hm.DistanceKm)
	}
	if hm.DurationFmt != "01:35:00" {
		t.Errorf("hm duration_fmt = %q, want 01:35:00", hm.DurationFmt)
	}
	if fm.PaceFmt == "" || fm.PaceFmt == "—" {
		t.Errorf("fm pace_fmt = %q, want a formatted pace", fm.PaceFmt)
	}
	if odd.DurationFmt != "—" && odd.DurationS != nil {
		t.Errorf("nil duration must format as the placeholder, got %q", odd.DurationFmt)
	}
	if fm.ThumbURL == nil || *fm.ThumbURL != "https://cdn.example/t.png" {
		t.Errorf("fm thumb_url = %v, want pass-through", fm.ThumbURL)
	}
	// Dates are Shanghai ISO strings with offset (house convention, same as
	// activities) so a client new Date() resolves to the same instant.
	if hm.Date != "2026-03-22T09:00:00+08:00" {
		t.Errorf("hm date = %q, want 2026-03-22T09:00:00+08:00", hm.Date)
	}
}

func TestGetRaces_UserTierForbiddenForOtherUser(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set(callerContextKey, Caller{Tier: TierUser, UserID: "u1"}) })
	newRaceRoutes(&fakeRaceStore{}, nil).register(r.Group(""))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/u2/races", nil))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestRenameRace(t *testing.T) {
	gin.SetMode(gin.TestMode)
	newRouter := func(store *fakeRaceStore) *gin.Engine {
		r := gin.New()
		r.Use(func(c *gin.Context) { c.Set(callerContextKey, Caller{Tier: TierUser, UserID: "u1"}) })
		newRaceRoutes(store, nil).register(r.Group(""))
		return r
	}
	patch := func(store *fakeRaceStore, labelID, body string) *httptest.ResponseRecorder {
		r := newRouter(store)
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPatch, "/api/u1/races/"+labelID, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		return w
	}
	store := &fakeRaceStore{races: map[string]*fakeRaceRow{"l1": {evidence: "model_score"}}}

	// Normal rename: 204 and the trimmed name lands in the store.
	w := patch(store, "l1", `{"display_name": "  锡马  "}`)
	if w.Code != http.StatusNoContent {
		t.Fatalf("rename status = %d, want 204, body=%s", w.Code, w.Body.String())
	}
	if got := store.races["l1"].displayName; got == nil || *got != "锡马" {
		t.Fatalf("stored display_name = %v, want trimmed 锡马", got)
	}

	// Blank after trim clears (NULL), still 204.
	w = patch(store, "l1", `{"display_name": "   "}`)
	if w.Code != http.StatusNoContent {
		t.Fatalf("clear status = %d, want 204, body=%s", w.Code, w.Body.String())
	}
	if got := store.races["l1"].displayName; got != nil {
		t.Fatalf("cleared display_name = %v, want nil", got)
	}

	// Over the 50-rune cap: 400, nothing stored.
	w = patch(store, "l1", `{"display_name": "`+strings.Repeat("马", 51)+`"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("overlong status = %d, want 400", w.Code)
	}
	w = patch(store, "l1", `{"display_name": "`+strings.Repeat("马", 50)+`"}`)
	if w.Code != http.StatusNoContent {
		t.Fatalf("50-rune status = %d, want 204", w.Code)
	}

	// Contract violations: missing body field, unknown race, foreign user.
	if w := patch(store, "l1", `{}`); w.Code != http.StatusBadRequest {
		t.Fatalf("missing field status = %d, want 400", w.Code)
	}
	if w := patch(store, "nope", `{"display_name": "x"}`); w.Code != http.StatusNotFound {
		t.Fatalf("unknown race status = %d, want 404", w.Code)
	}
	r := newRouter(&fakeRaceStore{races: map[string]*fakeRaceRow{"l1": {evidence: "model_score"}}})
	w2 := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/u2/races/l1", strings.NewReader(`{"display_name": "x"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w2, req)
	if w2.Code != http.StatusForbidden {
		t.Fatalf("foreign user status = %d, want 403", w2.Code)
	}
}

func TestClearRaceCalendarMatch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	newRouter := func(store *fakeRaceStore) *gin.Engine {
		r := gin.New()
		r.Use(func(c *gin.Context) { c.Set(callerContextKey, Caller{Tier: TierUser, UserID: "u1"}) })
		newRaceRoutes(store, nil).register(r.Group(""))
		return r
	}

	// Linked race: DELETE severs the link and stamps user_cleared.
	store := &fakeRaceStore{races: map[string]*fakeRaceRow{"l1": {itemID: i64ptr2(77), evidence: "calendar_match"}}}
	w := httptest.NewRecorder()
	newRouter(store).ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/u1/races/l1/calendar-match", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("clear status = %d, want 204, body=%s", w.Code, w.Body.String())
	}
	row := store.races["l1"]
	if row.itemID != nil || row.evidence != "user_cleared" {
		t.Fatalf("after clear = %+v, want unlinked with user_cleared", row)
	}

	// Already unlinked: still 204, evidence untouched.
	w = httptest.NewRecorder()
	newRouter(store).ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/u1/races/l1/calendar-match", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("no-op status = %d, want 204", w.Code)
	}
	if row.evidence != "user_cleared" {
		t.Fatalf("no-op must not touch evidence, got %q", row.evidence)
	}

	// Unknown race: 404.
	w = httptest.NewRecorder()
	newRouter(store).ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/u1/races/nope/calendar-match", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown race status = %d, want 404", w.Code)
	}

	// Foreign user: 403.
	r := newRouter(&fakeRaceStore{races: map[string]*fakeRaceRow{"l1": {itemID: i64ptr2(77), evidence: "calendar_match"}}})
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/u2/races/l1/calendar-match", nil))
	if w.Code != http.StatusForbidden {
		t.Fatalf("foreign user status = %d, want 403", w.Code)
	}
}
