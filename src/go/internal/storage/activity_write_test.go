package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestSetActivityFeelNote covers the athlete-facing feel-note write (#508):
// the happy path, the missing-activity miss, and that only the feel_note
// column moves (vendor feel and feel_type stay untouched).
func TestSetActivityFeelNote(t *testing.T) {
	st := openWatchTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	seedActivity(t, st, uid, &Activity{
		LabelID: "run-1", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), DistanceM: f(3000), DurationS: f(1200),
		FeelType: iptr(3), Feel: f(6),
	}, nil, nil, nil)

	// Happy path: overwrite an existing value.
	note := "前面4组体感6，最后两组7-8"
	found, err := st.SetActivityFeelNote(ctx, uid, "run-1", note)
	if err != nil || !found {
		t.Fatalf("found=%v err=%v", found, err)
	}
	a, err := st.ActivityByID(ctx, uid, "run-1")
	if err != nil || a == nil || a.FeelNote == nil || *a.FeelNote != note {
		t.Fatalf("feel_note = %v err=%v", a, err)
	}
	// Vendor feel and raw feel_type must not move.
	if a.Feel == nil || *a.Feel != 6 {
		t.Fatalf("feel = %v, want 6 (untouched)", a.Feel)
	}
	if a.FeelType == nil || *a.FeelType != 3 {
		t.Fatalf("feel_type = %v, want 3 (untouched)", a.FeelType)
	}

	// Unknown label id reports a miss.
	found, err = st.SetActivityFeelNote(ctx, uid, "nope", "轻松")
	if err != nil || found {
		t.Fatalf("missing activity: found=%v err=%v", found, err)
	}
}

// TestUpsertPreservesAthleteFeel locks the vendor-sync policy for the numeric
// feel (#508): a resync payload without a feel must not erase a previously
// synced one, while a resync that does carry one (rated in the vendor app)
// overwrites it as the newer statement of the same signal. (The athlete no
// longer writes this column — their subjective feel is feel_note free text,
// covered by TestUpsertPreservesFeelNote.)
func TestUpsertPreservesAthleteFeel(t *testing.T) {
	st := openWatchTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	// Seed via a vendor upsert carrying feel=8.
	seedActivity(t, st, uid, &Activity{
		LabelID: "run-1", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), DistanceM: f(3000), DurationS: f(1200),
		Feel: f(8),
	}, nil, nil, nil)

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

// TestUpsertPreservesFeelNote locks the feel_note resync policy: the note is
// athlete-authored free text that a vendor payload never carries, so every
// resync — with or without a numeric feel — must leave it untouched.
func TestUpsertPreservesFeelNote(t *testing.T) {
	st := openWatchTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	seedActivity(t, st, uid, &Activity{
		LabelID: "run-1", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), DistanceM: f(3000), DurationS: f(1200),
	}, nil, nil, nil)
	note := "前半轻松，后半顶到 7-8"
	if found, err := st.SetActivityFeelNote(ctx, uid, "run-1", note); err != nil || !found {
		t.Fatalf("set feel_note: found=%v err=%v", found, err)
	}

	// Resync without a feel: the note survives.
	if err := st.UpsertActivity(ctx, &Activity{
		UserID: uid, LabelID: "run-1", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), DistanceM: f(3100), DurationS: f(1210),
		SyncedAt: time.Now().UTC(),
	}, nil, nil, nil); err != nil {
		t.Fatalf("resync: %v", err)
	}
	a, err := st.ActivityByID(ctx, uid, "run-1")
	if err != nil || a == nil || a.FeelNote == nil || *a.FeelNote != note {
		t.Fatalf("feel_note not preserved after NULL resync: %v err=%v", a, err)
	}

	// Resync that carries a vendor feel: the note still survives.
	if err := st.UpsertActivity(ctx, &Activity{
		UserID: uid, LabelID: "run-1", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), DistanceM: f(3100), DurationS: f(1210),
		Feel: f(4), SyncedAt: time.Now().UTC(),
	}, nil, nil, nil); err != nil {
		t.Fatalf("resync with feel: %v", err)
	}
	a, err = st.ActivityByID(ctx, uid, "run-1")
	if err != nil || a == nil || a.FeelNote == nil || *a.FeelNote != note {
		t.Fatalf("feel_note not preserved after feel resync: %v err=%v", a, err)
	}
	if a.Feel == nil || *a.Feel != 4 {
		t.Fatalf("vendor feel not applied: %v", a.Feel)
	}
}
