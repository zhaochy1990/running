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

func TestRaceStrategy_TargetKeyedVersions(t *testing.T) {
	st := openTestStore(t)
	migrateRaceStrategy(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	pub := seedEngagementRace(t, st, "策略赛", "2032-04-10", true)

	// Two goals coexist: 2:55:00 and 2:50:00 (the athlete's own targets).
	if _, isNew, err := st.UpsertRaceStrategy(ctx, uid, pub, "2:55:00", "Marathon", `{"target_finish_time":"2:55:00","v":1}`); err != nil || !isNew {
		t.Fatalf("upsert 2:55:00: isNew=%v err=%v", isNew, err)
	}
	row250, isNew, err := st.UpsertRaceStrategy(ctx, uid, pub, "2:50:00", "Marathon", `{"target_finish_time":"2:50:00","v":1}`)
	if err != nil || !isNew {
		t.Fatalf("upsert 2:50:00: isNew=%v err=%v", isNew, err)
	}
	firstCreatedAt := row250.CreatedAt

	// Regenerating the same goal overwrites only that version.
	updated, isNew, err := st.UpsertRaceStrategy(ctx, uid, pub, "2:50:00", "Marathon", `{"target_finish_time":"2:50:00","v":2}`)
	if err != nil || isNew {
		t.Fatalf("re-upsert 2:50:00: isNew=%v err=%v", isNew, err)
	}
	if updated.Content != `{"target_finish_time":"2:50:00","v":2}` {
		t.Fatalf("same-target overwrite not kept: %s", updated.Content)
	}
	// MySQL datetime 精度截到毫秒：按毫秒比较（覆盖不得重置创建时间）。
	if !updated.CreatedAt.Truncate(time.Millisecond).Equal(firstCreatedAt.Truncate(time.Millisecond)) {
		t.Fatalf("overwrite must keep created_at: %v vs %v", updated.CreatedAt, firstCreatedAt)
	}

	versions, err := st.GetRaceStrategies(ctx, uid, pub)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(versions) != 2 {
		t.Fatalf("versions = %d, want 2 (per-goal rows, not latest-only)", len(versions))
	}
	// Fastest goal first — the report page's pill order.
	if versions[0].TargetFinishTime != "2:50:00" || versions[1].TargetFinishTime != "2:55:00" {
		t.Fatalf("order: %s then %s, want 2:50:00 first", versions[0].TargetFinishTime, versions[1].TargetFinishTime)
	}
	if versions[0].Content != `{"target_finish_time":"2:50:00","v":2}` {
		t.Fatalf("latest 2:50:00 content: %s", versions[0].Content)
	}
}

func TestRaceStrategy_DeleteRemovesOnlyThatGoal(t *testing.T) {
	st := openTestStore(t)
	migrateRaceStrategy(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	pub := seedEngagementRace(t, st, "删除策略赛", "2032-04-12", true)

	if _, _, err := st.UpsertRaceStrategy(ctx, uid, pub, "2:55:00", "Marathon", `{"target_finish_time":"2:55:00"}`); err != nil {
		t.Fatalf("upsert 2:55:00: %v", err)
	}
	if _, _, err := st.UpsertRaceStrategy(ctx, uid, pub, "2:50:00", "Marathon", `{"target_finish_time":"2:50:00"}`); err != nil {
		t.Fatalf("upsert 2:50:00: %v", err)
	}

	if err := st.DeleteRaceStrategy(ctx, uid, pub, "2:50:00"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := st.DeleteRaceStrategy(ctx, uid, pub, "2:50:00"); !errors.Is(err, ErrRaceStrategyNotFound) {
		t.Fatalf("delete again: err=%v want ErrRaceStrategyNotFound", err)
	}

	versions, err := st.GetRaceStrategies(ctx, uid, pub)
	if err != nil || len(versions) != 1 || versions[0].TargetFinishTime != "2:55:00" {
		t.Fatalf("after delete: versions=%+v err=%v, want only 2:55:00", versions, err)
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
	if _, _, err := st.UpsertRaceStrategy(ctx, uid, unpub, "2:55:00", "Marathon", `{}`); !errors.Is(err, ErrRaceCalendarNotFound) {
		t.Fatalf("upsert unpublished race: err=%v want ErrRaceCalendarNotFound", err)
	}
	if _, _, err := st.UpsertRaceStrategy(ctx, uid, 999999, "2:55:00", "Marathon", `{}`); !errors.Is(err, ErrRaceCalendarNotFound) {
		t.Fatalf("upsert missing race: err=%v want ErrRaceCalendarNotFound", err)
	}
	versions, err := st.GetRaceStrategies(ctx, uid, unpub)
	if err != nil || len(versions) != 0 {
		t.Fatalf("list missing: versions=%d err=%v, want empty (not an error)", len(versions), err)
	}
}

// TestRaceStrategy_MigratesLegacySingleRow pins the pre-v3 → v3 move on the
// real database: a legacy one-strategy-per-(user, race) table (unique index on
// (user, event), no target column) must come out of AutoMigrateRaceStrategies
// with the target key backfilled from the content JSON.
func TestRaceStrategy_MigratesLegacySingleRow(t *testing.T) {
	st := openTestStore(t)
	migrateRaceStrategy(t, st)
	ctx := context.Background()
	m := st.db.WithContext(ctx).Migrator()

	// Rewind the table to the pre-v3 shape.
	if err := m.DropIndex(&RaceStrategy{}, "uidx_race_strategy_user_target"); err != nil {
		t.Fatalf("drop v3 index: %v", err)
	}
	if err := m.DropColumn(&RaceStrategy{}, "TargetFinishTime"); err != nil {
		t.Fatalf("drop target column: %v", err)
	}
	if err := st.db.WithContext(ctx).Exec("ALTER TABLE race_strategy ADD UNIQUE INDEX uidx_race_strategy_user_event (user_id, race_event_id)").Error; err != nil {
		t.Fatalf("re-add legacy index: %v", err)
	}

	uid := uuid.NewString()
	pub := seedEngagementRace(t, st, "迁移策略赛", "2032-04-13", true)
	if err := st.db.WithContext(ctx).Exec(
		"INSERT INTO race_strategy (user_id, race_event_id, item_type, content, created_at, updated_at) VALUES (?, ?, 'Marathon', ?, NOW(), NOW())",
		uid, pub, `{"race_name":"上海马拉松","target_finish_time":"3:04:00"}`,
	).Error; err != nil {
		t.Fatalf("seed legacy row: %v", err)
	}

	if err := st.AutoMigrateRaceStrategies(ctx); err != nil {
		t.Fatalf("migrate legacy table: %v", err)
	}
	if m.HasIndex(&RaceStrategy{}, "uidx_race_strategy_user_event") {
		t.Fatal("legacy unique index still present after migration")
	}
	versions, err := st.GetRaceStrategies(ctx, uid, pub)
	if err != nil || len(versions) != 1 {
		t.Fatalf("legacy row lost: versions=%d err=%v", len(versions), err)
	}
	if versions[0].TargetFinishTime != "3:04:00" {
		t.Fatalf("target not backfilled: %q", versions[0].TargetFinishTime)
	}

	// Idempotent: a second migrate is a no-op.
	if err := st.AutoMigrateRaceStrategies(ctx); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
}
