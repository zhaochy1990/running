package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestSetActivityFeel covers the athlete-facing feel write (#508): the happy
// path, the missing-activity miss, and that only the normalized feel column
// moves (feel_type stays untouched).
func TestSetActivityFeel(t *testing.T) {
	st := openWatchTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	seedActivity(t, st, uid, &Activity{
		LabelID: "run-1", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), DistanceM: f(3000), DurationS: f(1200),
		FeelType: iptr(3), Feel: f(6),
	}, nil, nil, nil)

	// Happy path: overwrite an existing value.
	found, err := st.SetActivityFeel(ctx, uid, "run-1", 7.5)
	if err != nil || !found {
		t.Fatalf("found=%v err=%v", found, err)
	}
	a, err := st.ActivityByID(ctx, uid, "run-1")
	if err != nil || a == nil || a.Feel == nil || *a.Feel != 7.5 {
		t.Fatalf("feel = %v err=%v", a, err)
	}
	// Vendor raw feel_type must not move.
	if a.FeelType == nil || *a.FeelType != 3 {
		t.Fatalf("feel_type = %v, want 3 (untouched)", a.FeelType)
	}

	// Unknown label id reports a miss.
	found, err = st.SetActivityFeel(ctx, uid, "nope", 4)
	if err != nil || found {
		t.Fatalf("missing activity: found=%v err=%v", found, err)
	}
}

// TestUpsertPreservesAthleteFeel locks the user-write vs vendor-sync policy:
// a resync payload without a feel must not erase an athlete-set feel (#508),
// while a resync that does carry one (rated in the vendor app) overwrites it.
func TestUpsertPreservesAthleteFeel(t *testing.T) {
	st := openWatchTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	seedActivity(t, st, uid, &Activity{
		LabelID: "run-1", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), DistanceM: f(3000), DurationS: f(1200),
	}, nil, nil, nil)
	if found, err := st.SetActivityFeel(ctx, uid, "run-1", 8); err != nil || !found {
		t.Fatalf("set feel: found=%v err=%v", found, err)
	}

	// Full-mode resync with feel=NULL (the common vendor payload): must preserve.
	if err := st.UpsertActivity(ctx, &Activity{
		UserID: uid, LabelID: "run-1", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), DistanceM: f(3100), DurationS: f(1210),
		SyncedAt: time.Now().UTC(),
	}, nil, nil, nil); err != nil {
		t.Fatalf("resync: %v", err)
	}
	a, err := st.ActivityByID(ctx, uid, "run-1")
	if err != nil || a == nil || a.Feel == nil || *a.Feel != 8 {
		t.Fatalf("feel not preserved after NULL resync: %v err=%v", a, err)
	}

	// Resync with a real vendor feel (rated in the vendor app): overwrites.
	if err := st.UpsertActivity(ctx, &Activity{
		UserID: uid, LabelID: "run-1", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), DistanceM: f(3100), DurationS: f(1210),
		Feel: f(4), SyncedAt: time.Now().UTC(),
	}, nil, nil, nil); err != nil {
		t.Fatalf("resync with feel: %v", err)
	}
	a, err = st.ActivityByID(ctx, uid, "run-1")
	if err != nil || a == nil || a.Feel == nil || *a.Feel != 4 {
		t.Fatalf("vendor feel not applied: %v err=%v", a, err)
	}
}
