package storage

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func migrateWeeklyPlan(t *testing.T, store *Store) {
	t.Helper()
	if err := store.AutoMigrateWeeklyPlan(context.Background()); err != nil {
		t.Fatalf("automigrate weekly_plan: %v", err)
	}
}

func weeklyPlanRow(userID, weekStart, status string) *WeeklyPlan {
	// #585: a row always is the week's applied plan — status and slot stay
	// 'active' on every row.
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := &WeeklyPlan{
		PlanID: uuid.NewString(), UserID: userID, WeekStart: weekStart,
		ContentVersion: WeeklyPlanContentStructured,
		Content:        `{"sessions":[],"nutrition":[]}`,
		Status:         status, Revision: 1, CreatedAt: now, UpdatedAt: now,
	}
	slot := status
	row.StatusSlot = &slot
	return row
}

func seedWeeklyPlan(t *testing.T, store *Store, row *WeeklyPlan) {
	t.Helper()
	if err := store.db.WithContext(context.Background()).Create(row).Error; err != nil {
		t.Fatalf("seed weekly plan: %v", err)
	}
}

func TestWeeklyPlanReadsReturnOnlyActiveRows(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	userID := uuid.NewString()
	otherUser := uuid.NewString()

	older := weeklyPlanRow(userID, "2026-07-20", WeeklyPlanStatusActive)
	newer := weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusActive)
	seedWeeklyPlan(t, store, older)
	seedWeeklyPlan(t, store, newer)
	seedWeeklyPlan(t, store, weeklyPlanRow(otherUser, "2026-07-27", WeeklyPlanStatusActive))

	plans, err := store.ListActiveWeeklyPlans(context.Background(), userID)
	if err != nil {
		t.Fatalf("list active: %v", err)
	}
	if len(plans) != 2 || plans[0].PlanID != newer.PlanID || plans[1].PlanID != older.PlanID {
		t.Fatalf("active plans=%+v", plans)
	}

	plan, err := store.GetActiveWeeklyPlan(context.Background(), userID, "2026-07-27")
	if err != nil || plan == nil || plan.PlanID != newer.PlanID {
		t.Fatalf("get active: plan=%+v err=%v", plan, err)
	}
	missing, err := store.GetActiveWeeklyPlan(context.Background(), userID, "2026-08-03")
	if err != nil || missing != nil {
		t.Fatalf("missing active: plan=%+v err=%v", missing, err)
	}
}

func TestListWeekSummariesFiltersMasterPlanAndAggregatesShanghaiWeek(t *testing.T) {
	store := openWatchTestStore(t)
	migrateWeeklyPlan(t, store)
	if err := store.AutoMigrateWeeklyFeedback(context.Background()); err != nil {
		t.Fatalf("automigrate feedback: %v", err)
	}
	userID := uuid.NewString()
	masterID := uuid.NewString()
	otherMasterID := uuid.NewString()
	week := weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusActive)
	week.MasterPlanID = &masterID
	seedWeeklyPlan(t, store, week)
	other := weeklyPlanRow(userID, "2026-08-03", WeeklyPlanStatusActive)
	other.MasterPlanID = &otherMasterID
	seedWeeklyPlan(t, store, other)
	distance := 5000.0
	duration := 1800.0
	seedActivity(t, store, userID, &Activity{
		LabelID: "week-activity", Date: time.Date(2026, 7, 26, 16, 30, 0, 0, time.UTC),
		DistanceM: &distance, DurationS: &duration,
	}, nil, nil, nil)
	seedActivity(t, store, userID, &Activity{
		LabelID: "activity-only", Date: time.Date(2026, 7, 19, 16, 0, 0, 0, time.UTC),
		DistanceM: &distance, DurationS: &duration,
	}, nil, nil, nil)
	if _, err := store.PutWeeklyFeedback(context.Background(), userID, "2026-07-13", "feedback-only"); err != nil {
		t.Fatalf("put feedback-only: %v", err)
	}

	weeks, err := store.ListWeekSummaries(context.Background(), userID, masterID)
	if err != nil {
		t.Fatalf("list summaries: %v", err)
	}
	if len(weeks) != 1 {
		t.Fatalf("weeks=%+v", weeks)
	}
	got := weeks[0]
	if got.PlanID != week.PlanID || got.ActivityCount != 1 || got.TotalKM != 5 || got.TotalDurationS != 1800 {
		t.Fatalf("summary=%+v", got)
	}
}

func TestListWeekSummariesReturnsUnfilteredSourceUnion(t *testing.T) {
	store := openWatchTestStore(t)
	migrateWeeklyPlan(t, store)
	if err := store.AutoMigrateWeeklyFeedback(context.Background()); err != nil {
		t.Fatalf("automigrate feedback: %v", err)
	}
	userID, otherUser := uuid.NewString(), uuid.NewString()
	plan := weeklyPlanRow(userID, "2026-08-03", WeeklyPlanStatusActive)
	seedWeeklyPlan(t, store, plan)
	distance, duration := 5000.0, 1800.0
	seedActivity(t, store, userID, &Activity{
		LabelID: "shanghai-monday", Date: time.Date(2026, 7, 26, 16, 0, 0, 0, time.UTC),
		DistanceM: &distance, DurationS: &duration,
	}, nil, nil, nil)
	if _, err := store.PutWeeklyFeedback(context.Background(), userID, "2026-07-20", "done"); err != nil {
		t.Fatalf("put feedback: %v", err)
	}
	if _, err := store.PutWeeklyFeedback(context.Background(), userID, "2026-07-13", ""); err != nil {
		t.Fatalf("put empty feedback: %v", err)
	}
	if _, err := store.PutWeeklyFeedback(context.Background(), otherUser, "2026-07-06", "private"); err != nil {
		t.Fatalf("put other feedback: %v", err)
	}
	otherPlan := weeklyPlanRow(otherUser, "2026-06-29", WeeklyPlanStatusActive)
	seedWeeklyPlan(t, store, otherPlan)
	seedActivity(t, store, otherUser, &Activity{
		LabelID: "other-activity", Date: time.Date(2026, 6, 29, 1, 0, 0, 0, time.UTC),
		DistanceM: &distance, DurationS: &duration,
	}, nil, nil, nil)

	weeks, err := store.ListWeekSummaries(context.Background(), userID, "")
	if err != nil {
		t.Fatalf("list summaries: %v", err)
	}
	if len(weeks) != 4 {
		t.Fatalf("weeks=%+v", weeks)
	}
	if weeks[0].WeekStart != "2026-08-03" || weeks[0].PlanID != plan.PlanID {
		t.Fatalf("plan week=%+v", weeks[0])
	}
	if weeks[1].WeekStart != "2026-07-27" || weeks[1].PlanID != "" || weeks[1].ActivityCount != 1 || weeks[1].TotalKM != 5 {
		t.Fatalf("activity week=%+v", weeks[1])
	}
	if weeks[2].WeekStart != "2026-07-20" || !weeks[2].FeedbackRowExists || !weeks[2].HasFeedback {
		t.Fatalf("feedback week=%+v", weeks[2])
	}
	if weeks[3].WeekStart != "2026-07-13" || !weeks[3].FeedbackRowExists || weeks[3].HasFeedback {
		t.Fatalf("empty feedback week=%+v", weeks[3])
	}
}

func TestListWeekActivitiesUsesShanghaiDatesAndChronologicalOrder(t *testing.T) {
	store := openWatchTestStore(t)
	userID := uuid.NewString()
	otherUser := uuid.NewString()
	distance := 5000.0
	seedActivity(t, store, userID, &Activity{
		LabelID: "late", Date: time.Date(2026, 8, 2, 15, 59, 0, 0, time.UTC), DistanceM: &distance,
	}, nil, nil, nil)
	seedActivity(t, store, userID, &Activity{
		LabelID: "early", Date: time.Date(2026, 7, 26, 16, 0, 0, 0, time.UTC), DistanceM: &distance,
	}, nil, nil, nil)
	seedActivity(t, store, userID, &Activity{
		LabelID: "outside", Date: time.Date(2026, 8, 2, 16, 0, 0, 0, time.UTC), DistanceM: &distance,
	}, nil, nil, nil)
	seedActivity(t, store, otherUser, &Activity{
		LabelID: "other", Date: time.Date(2026, 7, 27, 1, 0, 0, 0, time.UTC), DistanceM: &distance,
	}, nil, nil, nil)

	rows, err := store.ListWeekActivities(context.Background(), userID, "2026-07-27", "2026-08-02")
	if err != nil {
		t.Fatalf("list week activities: %v", err)
	}
	if len(rows) != 2 || rows[0].LabelID != "early" || rows[1].LabelID != "late" {
		t.Fatalf("activities=%+v", rows)
	}
}

func TestWeeklyPlanWeekIsUniquePerUser(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	userID := uuid.NewString()

	// #585 convergence: UNIQUE(user_id, week_start) — a week's plan exists
	// exactly once; overwrite happens through ApplyStructuredWeeklyPlan.
	seedWeeklyPlan(t, store, weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusActive))
	if err := store.db.Create(weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusActive)).Error; !isDuplicateKey(err) {
		t.Fatalf("second row for the same week must be duplicate key, got %v", err)
	}
	seedWeeklyPlan(t, store, weeklyPlanRow(userID, "2026-08-03", WeeklyPlanStatusActive))
}

func TestWeeklyPlanCheckConstraints(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)

	invalidJSON := weeklyPlanRow(uuid.NewString(), "2026-07-27", WeeklyPlanStatusActive)
	invalidJSON.Content = "not-json"
	if err := store.db.Create(invalidJSON).Error; err == nil {
		t.Fatal("structured content must be valid JSON")
	}

	invalidRevision := weeklyPlanRow(uuid.NewString(), "2026-07-27", WeeklyPlanStatusActive)
	invalidRevision.Revision = 0
	if err := store.db.Create(invalidRevision).Error; err == nil {
		t.Fatal("revision must be at least 1")
	}

	invalidSlot := weeklyPlanRow(uuid.NewString(), "2026-07-27", WeeklyPlanStatusActive)
	badSlot := "superseded"
	invalidSlot.StatusSlot = &badSlot
	if err := store.db.Create(invalidSlot).Error; err == nil {
		t.Fatal("status_slot must be 'active'")
	}

	missingSlot := weeklyPlanRow(uuid.NewString(), "2026-07-27", WeeklyPlanStatusActive)
	missingSlot.StatusSlot = nil
	if err := store.db.Create(missingSlot).Error; err == nil {
		t.Fatal("active rows must carry a non-null status_slot")
	}
}

func TestApplyStructuredWeeklyPlanCreatesAndReplacesAtomically(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	ctx := context.Background()
	userID := uuid.NewString()
	weekStart := "2026-08-17"
	content := "{\"schema\":\"weekly-plan/v1\",\"week_name\":\"2026-08-17_08-23\",\"sessions\":[],\"nutrition\":[]}"

	first, replaced, err := store.ApplyStructuredWeeklyPlan(ctx, userID, weekStart, content, nil)
	if err != nil || replaced != nil || first == nil || first.Status != WeeklyPlanStatusActive || first.Revision != 1 {
		t.Fatalf("first=%+v replaced=%+v err=%v", first, replaced, err)
	}
	if _, _, err := store.ApplyStructuredWeeklyPlan(ctx, userID, weekStart, content, nil); !errors.Is(err, ErrWeeklyPlanExists) {
		t.Fatalf("apply without replacement err=%v", err)
	}

	second, replaced, err := store.ApplyStructuredWeeklyPlan(ctx, userID, weekStart, content, &WeeklyPlanReplacement{PlanID: first.PlanID, Revision: first.Revision})
	if err != nil || replaced == nil || replaced.PlanID != first.PlanID || second == nil || second.Revision != 1 {
		t.Fatalf("second=%+v replaced=%+v err=%v", second, replaced, err)
	}
	var rows []WeeklyPlan
	if err := store.db.Where("user_id = ? AND week_start = ?", userID, weekStart).Find(&rows).Error; err != nil {
		t.Fatalf("list rows: %v", err)
	}
	// #585 convergence: the overwrite deletes the prior row — the week keeps
	// exactly one applied row.
	if len(rows) != 1 || rows[0].PlanID != second.PlanID || rows[0].Status != WeeklyPlanStatusActive ||
		rows[0].StatusSlot == nil || *rows[0].StatusSlot != WeeklyPlanStatusActive {
		t.Fatalf("rows=%+v", rows)
	}
}

func TestApplyStructuredWeeklyPlanLinksActiveMasterPlan(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	migrateMasterPlan(t, store)
	ctx := context.Background()
	userID := uuid.NewString()
	weekStart := "2026-08-17"
	content := "{\"schema\":\"weekly-plan/v1\",\"week_name\":\"2026-08-17_08-23\",\"sessions\":[],\"nutrition\":[]}"

	seedPlan(t, store, structuredPlan(userID))
	got, err := store.GetCurrentMasterPlan(ctx, userID)
	if err != nil || got == nil {
		t.Fatalf("seed active master plan: got=%+v err=%v", got, err)
	}

	plan, _, err := store.ApplyStructuredWeeklyPlan(ctx, userID, weekStart, content, nil)
	if err != nil || plan == nil {
		t.Fatalf("apply: %+v err=%v", plan, err)
	}
	if plan.MasterPlanID == nil || *plan.MasterPlanID != got.PlanID {
		t.Fatalf("weekly plan master_plan_id=%v, want %q", plan.MasterPlanID, got.PlanID)
	}
}

func TestApplyStructuredWeeklyPlanNoMasterPlanLeavesNil(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	migrateMasterPlan(t, store)
	ctx := context.Background()
	userID := uuid.NewString()
	weekStart := "2026-08-17"
	content := "{\"schema\":\"weekly-plan/v1\",\"week_name\":\"2026-08-17_08-23\",\"sessions\":[],\"nutrition\":[]}"

	plan, _, err := store.ApplyStructuredWeeklyPlan(ctx, userID, weekStart, content, nil)
	if err != nil || plan == nil {
		t.Fatalf("apply: %+v err=%v", plan, err)
	}
	if plan.MasterPlanID != nil {
		t.Fatalf("weekly plan master_plan_id=%v, want nil", *plan.MasterPlanID)
	}
}

func TestApplyStructuredWeeklyPlanRejectsNonMonday(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	userID := uuid.NewString()
	if _, _, err := store.ApplyStructuredWeeklyPlan(context.Background(), userID, "2026-08-18", "{}", nil); err == nil {
		t.Fatal("non-Monday week_start must fail")
	}
}

func TestApplyStructuredWeeklyPlanConcurrentFirstApplyReturnsConflict(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	ctx := context.Background()
	userID := uuid.NewString()
	content := "{\"schema\":\"weekly-plan/v1\",\"week_name\":\"2026-08-17_08-23\",\"sessions\":[],\"nutrition\":[]}"
	start := make(chan struct{})
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			_, _, err := store.ApplyStructuredWeeklyPlan(ctx, userID, "2026-08-17", content, nil)
			errs <- err
		}()
	}
	close(start)

	var successes, conflicts int
	for range 2 {
		err := <-errs
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrWeeklyPlanExists):
			conflicts++
		default:
			t.Fatalf("concurrent apply returned unexpected error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d, want 1 each", successes, conflicts)
	}
}

func TestApplyStructuredWeeklyPlanRejectsStaleReplacement(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	ctx := context.Background()
	userID := uuid.NewString()
	content := `{"sessions":[],"nutrition":[]}`
	active, _, err := store.ApplyStructuredWeeklyPlan(ctx, userID, "2026-08-17", content, nil)
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}
	_, _, err = store.ApplyStructuredWeeklyPlan(ctx, userID, "2026-08-17", content, &WeeklyPlanReplacement{PlanID: active.PlanID, Revision: active.Revision + 1})
	if !errors.Is(err, ErrWeeklyPlanConflict) {
		t.Fatalf("stale replacement err=%v", err)
	}
	got, err := store.GetActiveWeeklyPlan(ctx, userID, "2026-08-17")
	if err != nil || got == nil || got.PlanID != active.PlanID || got.Revision != active.Revision {
		t.Fatalf("active after conflict=%+v err=%v", got, err)
	}
}

func TestAutoMigrateWeeklyPlanConvergesLegacyRows(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	// Recreate the pre-#585 table (draft/archived vocabulary, (user, week,
	// slot) unique index) with legacy rows, then converge: drafts deleted,
	// per week only the newest snapshot survives as the applied row.
	if err := store.db.WithContext(ctx).Exec(`DROP TABLE IF EXISTS weekly_plan`).Error; err != nil {
		t.Fatalf("drop table: %v", err)
	}
	t.Cleanup(func() {
		_ = store.db.WithContext(context.Background()).Exec(`DROP TABLE IF EXISTS weekly_plan`).Error
		// Restore the current-shape table: the drop above must not leak into
		// tests that run after this one in the same package run.
		_ = store.AutoMigrateWeeklyPlan(context.Background())
	})
	legacy := `CREATE TABLE weekly_plan (
		plan_id varchar(36) PRIMARY KEY,
		user_id varchar(64) NOT NULL,
		master_plan_id varchar(36) NULL,
		week_start date NOT NULL,
		content_version tinyint NOT NULL,
		content longtext NOT NULL,
		status varchar(16) NOT NULL,
		status_slot varchar(8) NULL,
		revision bigint NOT NULL,
		created_at datetime(3) NOT NULL,
		updated_at datetime(3) NOT NULL,
		UNIQUE KEY uidx_weekly_plan_status_slot (user_id, week_start, status_slot),
		CONSTRAINT ck_weekly_plan_status CHECK (status IN ('draft','active','archived')),
		CONSTRAINT ck_weekly_plan_status_slot_v2 CHECK ((status = 'active' AND status_slot IS NOT NULL AND status_slot = 'active') OR (status <> 'active' AND status_slot IS NULL))
	)`
	if err := store.db.WithContext(ctx).Exec(legacy).Error; err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	userID := uuid.NewString()
	now := time.Now().UTC().Truncate(time.Millisecond)
	seed := func(planID string, ts time.Time, status string, slot *string) {
		t.Helper()
		if err := store.db.WithContext(ctx).Exec(
			`INSERT INTO weekly_plan (plan_id, user_id, week_start, content_version, content, status, status_slot, revision, created_at, updated_at)
			 VALUES (?, ?, ?, 2, '{}', ?, ?, 1, ?, ?)`,
			planID, userID, "2026-08-17", status, slot, ts, ts,
		).Error; err != nil {
			t.Fatalf("seed legacy row (%s): %v", status, err)
		}
	}
	activeSlot := "active"
	old := now.Add(-2 * time.Hour)
	newest := now.Add(-time.Hour)
	seed(uuid.NewString(), old, "active", &activeSlot) // older active — deduped away
	seed(uuid.NewString(), old, "draft", nil)          // never applied — deleted
	kept := uuid.NewString()
	seed(kept, newest, "archived", nil) // newest snapshot — survives as the applied row

	if err := store.AutoMigrateWeeklyPlan(ctx); err != nil {
		t.Fatalf("converging automigrate: %v", err)
	}

	var rows []WeeklyPlan
	if err := store.db.WithContext(ctx).Where("user_id = ?", userID).Find(&rows).Error; err != nil {
		t.Fatalf("read rows: %v", err)
	}
	if len(rows) != 1 || rows[0].PlanID != kept || rows[0].Status != WeeklyPlanStatusActive {
		t.Fatalf("rows=%+v, want only the newest snapshot as the applied row", rows)
	}
	if rows[0].StatusSlot == nil || *rows[0].StatusSlot != WeeklyPlanStatusActive {
		t.Fatalf("slot=%v, want active", rows[0].StatusSlot)
	}
}

// #858 换计划清理：只删当前/未来周的异链（含 NULL 链）行；已经结束的历史周
// 无论归链还是 legacy 未归链都保留，物化课表也不受清理影响。
func TestDeleteStaleFutureWeeklyPlansKeepsHistory(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	userID := uuid.NewString()
	otherUser := uuid.NewString()
	newPlan := uuid.NewString()
	oldPlan := uuid.NewString()
	// 2026-11-12 是周四，当前上海自然周从 2026-11-09（周一）起算。
	now := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)

	link := func(plan string) *string { return &plan }
	rows := map[string]*WeeklyPlan{}
	add := func(key, user, weekStart string, plan *string) *WeeklyPlan {
		row := weeklyPlanRow(user, weekStart, WeeklyPlanStatusActive)
		row.MasterPlanID = plan
		seedWeeklyPlan(t, store, row)
		rows[key] = row
		return row
	}
	// 历史周：旧链、未归链都必须保留。
	oldHistory := add("oldHistory", userID, "2026-11-02", link(oldPlan))
	add("legacyHistory", userID, "2026-10-26", nil)
	// 当前周旧链、未来周未归链：删。
	add("currentOld", userID, "2026-11-09", link(oldPlan))
	add("futureLegacy", userID, "2026-11-16", nil)
	// 新计划的当前/未来周行：保留。
	newFuture := add("newFuture", userID, "2026-11-23", link(newPlan))
	// 其他用户的行不受影响。
	add("otherUser", otherUser, "2026-11-09", link(oldPlan))

	// 历史周已经物化过课表：清理 weekly 行不得连带删除物化数据。
	if err := store.AutoMigrateWorkout(context.Background()); err != nil {
		t.Fatalf("automigrate workout: %v", err)
	}
	sessionIndex := 0
	workout := &Workout{
		WorkoutID: uuid.NewString(), UserID: userID, Date: "2026-11-03",
		Source: WorkoutSourceWeekly, Kind: "run", Name: "历史课",
		Status: WorkoutStatusActive, PlanID: link(oldHistory.PlanID),
		SessionIndex: &sessionIndex, CreatedAt: now, UpdatedAt: now,
	}
	if err := store.db.WithContext(context.Background()).Create(workout).Error; err != nil {
		t.Fatalf("seed workout: %v", err)
	}

	removed, err := store.DeleteStaleFutureWeeklyPlans(context.Background(), userID, newPlan, now)
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if removed != 2 {
		t.Fatalf("removed=%d want 2 (current cross-chain + future unlinked)", removed)
	}
	var kept []WeeklyPlan
	if err := store.db.WithContext(context.Background()).Where("user_id = ?", userID).Find(&kept).Error; err != nil {
		t.Fatalf("read rows: %v", err)
	}
	keptIDs := map[string]bool{}
	for _, row := range kept {
		keptIDs[row.PlanID] = true
	}
	if len(kept) != 3 || !keptIDs[rows["oldHistory"].PlanID] || !keptIDs[rows["legacyHistory"].PlanID] || !keptIDs[newFuture.PlanID] {
		t.Fatalf("kept rows=%+v, want old history + legacy history + new-plan future", kept)
	}
	// 其他用户的行不受影响
	var otherRows []WeeklyPlan
	if err := store.db.WithContext(context.Background()).Where("user_id = ?", otherUser).Find(&otherRows).Error; err != nil {
		t.Fatalf("read other rows: %v", err)
	}
	if len(otherRows) != 1 {
		t.Fatalf("other user rows=%d want 1", len(otherRows))
	}
	// 历史物化安排仍在且保持可用。
	var sessions []Workout
	if err := store.db.WithContext(context.Background()).
		Where("user_id = ? AND workout_id = ? AND status = ?", userID, workout.WorkoutID, WorkoutStatusActive).
		Find(&sessions).Error; err != nil {
		t.Fatalf("read workout: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("historical workout removed by weekly cleanup: %+v", sessions)
	}
	// 幂等：重复执行无行可删
	again, err := store.DeleteStaleFutureWeeklyPlans(context.Background(), userID, newPlan, now)
	if err != nil || again != 0 {
		t.Fatalf("idempotent re-run: removed=%d err=%v", again, err)
	}
	// 非法 keep id 直接报错（防误删）
	if _, err := store.DeleteStaleFutureWeeklyPlans(context.Background(), userID, "not-a-uuid", now); err == nil {
		t.Fatalf("invalid keep id must fail")
	}
}

// 周界按 Asia/Shanghai 自然周：UTC 周日 15:59 还是上海周日 23:59（当前周从
// 11-02 起），UTC 周日 16:00 已是上海周一 00:00（当前周从 11-09 起）。
func TestDeleteStaleFutureWeeklyPlansShanghaiWeekBoundary(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	userID := uuid.NewString()
	newPlan := uuid.NewString()
	oldPlan := uuid.NewString()

	seed := func() string {
		row := weeklyPlanRow(userID, "2026-11-02", WeeklyPlanStatusActive)
		row.MasterPlanID = &oldPlan
		seedWeeklyPlan(t, store, row)
		return row.PlanID
	}

	// 上海周日 23:59：11-02 仍是当前周，旧链行被清理。
	seed()
	removed, err := store.DeleteStaleFutureWeeklyPlans(
		context.Background(), userID, newPlan, time.Date(2026, 11, 8, 15, 59, 0, 0, time.UTC))
	if err != nil || removed != 1 {
		t.Fatalf("sunday 23:59 cleanup: removed=%d err=%v", removed, err)
	}
	// 上海周一 00:00：11-02 变成历史周，旧链行保留；11-09 是当前周，被清理。
	historyID := seed()
	current := weeklyPlanRow(userID, "2026-11-09", WeeklyPlanStatusActive)
	current.MasterPlanID = &oldPlan
	seedWeeklyPlan(t, store, current)
	removed, err = store.DeleteStaleFutureWeeklyPlans(
		context.Background(), userID, newPlan, time.Date(2026, 11, 8, 16, 0, 0, 0, time.UTC))
	if err != nil || removed != 1 {
		t.Fatalf("monday 00:00 cleanup: removed=%d err=%v", removed, err)
	}
	var rows []WeeklyPlan
	if err := store.db.WithContext(context.Background()).Where("user_id = ?", userID).Find(&rows).Error; err != nil {
		t.Fatalf("read rows: %v", err)
	}
	if len(rows) != 1 || rows[0].PlanID != historyID {
		t.Fatalf("rows=%+v, want only the 11-02 history row", rows)
	}
}
