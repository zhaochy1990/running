package storage

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func migrateRaceStrategy(t *testing.T, st *Store) {
	t.Helper()
	ctx := context.Background()
	migrateRaceCalendar(t, st)
	if err := st.AutoMigrateRaceStrategies(ctx); err != nil {
		t.Fatalf("automigrate race_strategy: %v", err)
	}
	if err := st.db.WithContext(ctx).Exec("DELETE FROM race_strategy").Error; err != nil {
		t.Fatalf("clear race_strategy: %v", err)
	}
}

func TestRaceStrategy_UpsertKeepsLatestOnly(t *testing.T) {
	st := openTestStore(t)
	migrateRaceStrategy(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	pub := seedEngagementRace(t, st, "策略赛", "2032-04-10", true)

	created, isNew, err := st.UpsertRaceStrategy(ctx, uid, pub, "Marathon", `{"target_finish_time":"3:59:59"}`)
	if err != nil || !isNew {
		t.Fatalf("first upsert: created=%v isNew=%v err=%v", created, isNew, err)
	}
	firstCreatedAt := created.CreatedAt

	updated, isNew, err := st.UpsertRaceStrategy(ctx, uid, pub, "Marathon", `{"target_finish_time":"3:55:00"}`)
	if err != nil || isNew {
		t.Fatalf("second upsert: isNew=%v err=%v", isNew, err)
	}
	if updated.Content != `{"target_finish_time":"3:55:00"}` {
		t.Fatalf("latest version not kept: %s", updated.Content)
	}
	// MySQL datetime 精度截到毫秒：按毫秒比较（覆盖不得重置创建时间）。
	if !updated.CreatedAt.Truncate(time.Millisecond).Equal(firstCreatedAt.Truncate(time.Millisecond)) {
		t.Fatalf("overwrite must keep created_at: %v vs %v", updated.CreatedAt, firstCreatedAt)
	}

	// UNIQUE(user, event): the overwrite did not add a second row.
	var count int64
	if err := st.db.WithContext(ctx).Model(&RaceStrategy{}).Where("user_id = ? AND race_event_id = ?", uid, pub).Count(&count).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("rows for (user, race) = %d, want 1", count)
	}

	// Reads see the same row back.
	row, err := st.GetRaceStrategy(ctx, uid, pub)
	if err != nil || row.Content != `{"target_finish_time":"3:55:00"}` {
		t.Fatalf("get: row=%+v err=%v", row, err)
	}
}

func TestRaceStrategy_Guards(t *testing.T) {
	st := openTestStore(t)
	migrateRaceStrategy(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	unpub := seedEngagementRace(t, st, "未发布策略赛", "2032-04-11", false)

	// A nonexistent or unpublished race is not strategizable: 404 sentinel,
	// the same freeze as race_plan.
	if _, _, err := st.UpsertRaceStrategy(ctx, uid, unpub, "Marathon", `{}`); !errors.Is(err, ErrRaceCalendarNotFound) {
		t.Fatalf("upsert unpublished race: err=%v want ErrRaceCalendarNotFound", err)
	}
	if _, _, err := st.UpsertRaceStrategy(ctx, uid, 999999, "Marathon", `{}`); !errors.Is(err, ErrRaceCalendarNotFound) {
		t.Fatalf("upsert missing race: err=%v want ErrRaceCalendarNotFound", err)
	}
	if _, err := st.GetRaceStrategy(ctx, uid, unpub); !errors.Is(err, ErrRaceStrategyNotFound) {
		t.Fatalf("get missing strategy: err=%v want ErrRaceStrategyNotFound", err)
	}
}
