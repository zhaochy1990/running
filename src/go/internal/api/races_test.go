package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/zhaochy1990/stride/internal/storage"
)

// fakeRaceStore returns canned joined race rows. Storage returns them newest
// first already; the handler must preserve that order verbatim.
type fakeRaceStore struct {
	rows []storage.UserRaceRow
}

func (f *fakeRaceStore) UserRaces(_ context.Context, _ string) ([]storage.UserRaceRow, error) {
	return f.rows, nil
}

func f64ptr(v float64) *float64 { return &v }
func iptr2(v int) *int          { return &v }
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
