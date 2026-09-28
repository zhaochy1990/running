// home_city_test.go covers the user_home_city upsert + change-history
// semantics against a live MySQL (STRIDE_WORKER_TEST_MYSQL_DSN), matching the
// other storage integration tests: first detection records "new", an identical
// re-detection records nothing, a changed city appends a history row with the
// matching reason, and a dropped detection records "cleared".
package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/homecity"
)

func openHomeCityTestStore(t *testing.T) *Store {
	t.Helper()
	st := openTestStore(t)
	if err := st.AutoMigrateHomeCity(context.Background()); err != nil {
		t.Fatalf("automigrate home city: %v", err)
	}
	return st
}

func homeCityResult(city string) homecity.Result {
	return homecity.Result{
		City: city, Confidence: homecity.ConfidenceHigh, Source: "gps",
		WeightedShare: 0.9, VoteCount: 40, TotalVotes: 45,
		Secondary: []homecity.SecondaryCity{{City: "昆明市", Kind: homecity.SecondaryTransient, WeightedShare: 0.1, SpanDays: 29}},
	}
}

func countHomeCityHistory(t *testing.T, st *Store, uid string) int64 {
	t.Helper()
	var count int64
	if err := st.db.Model(&UserHomeCityHistory{}).Where("user_id = ?", uid).Count(&count).Error; err != nil {
		t.Fatalf("count history: %v", err)
	}
	return count
}

func TestPutUserHomeCity_FirstDetectionAndNoChange(t *testing.T) {
	st := openHomeCityTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	computed := time.Date(2026, 9, 28, 16, 0, 0, 0, time.UTC)

	if reason, err := st.PutUserHomeCity(ctx, uid, homeCityResult("上海市"), computed); err != nil {
		t.Fatalf("put: %v", err)
	} else if reason != HomeCityChangeNew {
		t.Fatalf("first detection reason = %q, want new", reason)
	}

	row, err := st.GetUserHomeCity(ctx, uid)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if row.City != "上海市" || row.Confidence != "high" || row.Source != "gps" || row.VoteCount != 40 {
		t.Fatalf("unexpected row: %+v", row)
	}
	if row.SecondaryJSON == "" || row.ComputedAt.Unix() != computed.Unix() {
		t.Fatalf("secondary/computed_at not persisted: %+v", row)
	}

	// Recompute with the same city: no new history row, no change reason, but
	// the timestamps move so the row still shows a fresh snapshot.
	later := computed.Add(24 * time.Hour)
	if reason, err := st.PutUserHomeCity(ctx, uid, homeCityResult("上海市"), later); err != nil {
		t.Fatalf("re-put: %v", err)
	} else if reason != "" {
		t.Fatalf("unchanged city reason = %q, want empty", reason)
	}
	if got := countHomeCityHistory(t, st, uid); got != 1 {
		t.Fatalf("history rows after no-change recompute = %d, want 1 (only the initial new)", got)
	}
	row, err = st.GetUserHomeCity(ctx, uid)
	if err != nil {
		t.Fatalf("re-get: %v", err)
	}
	if !row.ComputedAt.Equal(later) {
		t.Fatalf("computed_at not refreshed: %v", row.ComputedAt)
	}
}

func TestPutUserHomeCity_CityChangeReasons(t *testing.T) {
	st := openHomeCityTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	computed := time.Date(2026, 9, 28, 16, 0, 0, 0, time.UTC)

	if _, err := st.PutUserHomeCity(ctx, uid, homeCityResult("成都市"), computed); err != nil {
		t.Fatalf("seed: %v", err)
	}

	moved := homeCityResult("昆明市")
	moved.Relocated = true
	moved.PreviousCity = "成都市"
	if reason, err := st.PutUserHomeCity(ctx, uid, moved, computed.Add(time.Hour)); err != nil {
		t.Fatalf("relocate: %v", err)
	} else if reason != HomeCityChangeRelocated {
		t.Fatalf("relocation reason = %q, want relocated", reason)
	}

	drifted := homeCityResult("贵阳市")
	if reason, err := st.PutUserHomeCity(ctx, uid, drifted, computed.Add(2*time.Hour)); err != nil {
		t.Fatalf("drift: %v", err)
	} else if reason != HomeCityChangeDrift {
		t.Fatalf("drift reason = %q, want drift", reason)
	}

	cleared := homecity.Result{Confidence: homecity.ConfidenceNone}
	if reason, err := st.PutUserHomeCity(ctx, uid, cleared, computed.Add(3*time.Hour)); err != nil {
		t.Fatalf("clear: %v", err)
	} else if reason != HomeCityChangeCleared {
		t.Fatalf("cleared reason = %q, want cleared", reason)
	}
	if got := countHomeCityHistory(t, st, uid); got != 4 { // new + relocated + drift + cleared
		t.Fatalf("history rows = %d, want 4", got)
	}

	var last UserHomeCityHistory
	if err := st.db.Where("user_id = ?", uid).Order("id DESC").Take(&last).Error; err != nil {
		t.Fatalf("load last history: %v", err)
	}
	if last.FromCity != "贵阳市" || last.ToCity != "" || last.Reason != HomeCityChangeCleared {
		t.Fatalf("unexpected last history row: %+v", last)
	}

	if _, err := st.GetUserHomeCity(ctx, uuid.NewString()); err != ErrHomeCityNotFound {
		t.Fatalf("missing row error = %v, want ErrHomeCityNotFound", err)
	}
}
