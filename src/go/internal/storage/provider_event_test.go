package storage

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// uniqueSuffix keeps rows from colliding with earlier runs against the same
// local MySQL: without it the unique index makes a re-run's first insert look
// like a duplicate push.
func uniqueSuffix() string {
	return fmt.Sprintf("-%d", time.Now().UnixNano())
}

func TestProviderEvents_CreateIdempotency(t *testing.T) {
	st := openTestStore(t)
	if err := st.AutoMigrateProviderEvents(context.Background()); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	sfx := uniqueSuffix()
	idemKey := "label-idem" + sfx

	first := &ProviderEvent{
		Provider:           "coros",
		ProviderUserID:     "openid-idem" + sfx,
		ProviderActivityID: idemKey,
		EventType:          "activity.create",
		OccurTime:          now.Add(-time.Hour),
		ReceivedAt:         now,
		RawPayload:         []byte(`{"sportDataList":[{"labelId":"…"}]}`),
	}
	created, err := st.CreateProviderEvent(ctx, first)
	if err != nil || !created {
		t.Fatalf("first insert: created=%v err=%v, want created=true", created, err)
	}
	if first.ID == 0 {
		t.Fatal("first insert did not populate the surrogate id the fetch job references")
	}

	// The same (provider, provider_activity_id) — COROS re-pushing the same
	// workout — reports already-recorded, never a second row or an error.
	second := &ProviderEvent{
		Provider:           "coros",
		ProviderUserID:     "openid-idem" + sfx,
		ProviderActivityID: idemKey,
		EventType:          "activity.create",
		OccurTime:          now.Add(-time.Hour),
		ReceivedAt:         now.Add(time.Second),
		RawPayload:         []byte(`{"sportDataList":[{"labelId":"…"}]}`),
	}
	created, err = st.CreateProviderEvent(ctx, second)
	if err != nil {
		t.Fatalf("duplicate insert: %v", err)
	}
	if created {
		t.Fatal("duplicate insert reported created=true; the unique index must make it a no-op")
	}

	// A different activity of the same provider is a new row.
	other, err := st.CreateProviderEvent(ctx, &ProviderEvent{
		Provider:           "coros",
		ProviderUserID:     "openid-idem" + sfx,
		ProviderActivityID: "label-other" + sfx,
		EventType:          "activity.create",
		OccurTime:          now,
		ReceivedAt:         now,
		RawPayload:         []byte(`{}`),
	})
	if err != nil || !other {
		t.Fatalf("distinct activity insert: created=%v err=%v", other, err)
	}

	// The same activity id under another provider is a distinct event: the
	// identity is (provider, provider_activity_id), not the id alone.
	cross, err := st.CreateProviderEvent(ctx, &ProviderEvent{
		Provider:           "garmin",
		ProviderUserID:     "g-id" + sfx,
		ProviderActivityID: idemKey,
		EventType:          "activity.create",
		OccurTime:          now,
		ReceivedAt:         now,
		RawPayload:         []byte(`{}`),
	})
	if err != nil || !cross {
		t.Fatalf("cross-provider insert: created=%v err=%v", cross, err)
	}

	var count int64
	if err := st.db.WithContext(ctx).
		Model(&ProviderEvent{}).
		Where("provider = ? AND provider_activity_id = ?", "coros", idemKey).
		Count(&count).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("rows for (coros,%s) = %d, want 1", idemKey, count)
	}
}

func TestProviderEvents_NullableColumns(t *testing.T) {
	st := openTestStore(t)
	if err := st.AutoMigrateProviderEvents(context.Background()); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	key := "label-null" + uniqueSuffix()

	// A multisport push: no plan workout, no top-level fit url, and no user
	// resolved (unbound or resolution not wired) — all stay NULL, not zero
	// values.
	created, err := st.CreateProviderEvent(ctx, &ProviderEvent{
		Provider:           "coros",
		ProviderUserID:     "openid-null" + uniqueSuffix(),
		ProviderActivityID: key,
		EventType:          "activity.create",
		OccurTime:          now,
		ReceivedAt:         now,
		RawPayload:         []byte(`{}`),
	})
	if err != nil || !created {
		t.Fatalf("insert: created=%v err=%v", created, err)
	}
	var row ProviderEvent
	if err := st.db.WithContext(ctx).
		Where("provider = ? AND provider_activity_id = ?", "coros", key).
		First(&row).Error; err != nil {
		t.Fatalf("read back: %v", err)
	}
	if row.PlanWorkoutID != nil || row.FitURL != nil || row.UserID != nil {
		t.Fatalf("absent values must persist as NULL, got plan=%v fit=%v user=%v",
			row.PlanWorkoutID, row.FitURL, row.UserID)
	}
	if !row.OccurTime.Equal(now) || !row.ReceivedAt.Equal(now) {
		t.Fatalf("timestamps not preserved as stored: occur=%v received=%v want %v",
			row.OccurTime, row.ReceivedAt, now)
	}
}
