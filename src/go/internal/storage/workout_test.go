package storage

import (
	"context"
	"fmt"
	"testing"

	"github.com/google/uuid"
)

// weeklyContentFor builds a minimal structured weekly-plan content JSON for the
// given dates (all inside one Shanghai week starting Monday 2026-01-19).
func weeklyContentFor(name string, dose float64) string {
	return fmt.Sprintf(`{
		"week_name": "2026-01-19_01-25",
		"sessions": [
			{
				"date": "2026-01-19", "session_index": 0, "kind": "run",
				"summary": %q, "spec": {"name": %q, "date": "2026-01-19", "note": null,
					"blocks": [{"repeat": 1, "steps": []}]},
				"total_distance_m": 5000, "total_duration_s": 1800, "estimated_dose": %f
			},
			{"date": "2026-01-21", "session_index": 0, "kind": "rest", "summary": "休息", "spec": null}
		],
		"nutrition": []
	}`, name, name, dose)
}

// TestWorkoutAutoMigrateIdempotent guards the generated-column DDL: a second
// run must be a no-op, not a duplicate-column/index error.
func TestWorkoutAutoMigrateIdempotent(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if err := st.AutoMigrateWorkout(ctx); err != nil {
			t.Fatalf("AutoMigrateWorkout run %d: %v", i+1, err)
		}
	}
}

func TestWeeklyPlanMaterialization(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	weekStart := "2026-01-19"

	created, _, err := st.ApplyStructuredWeeklyPlan(ctx, uid, weekStart, weeklyContentFor("轻松跑 5km", 42.5), nil)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}

	rows, err := st.ListPlanSessions(ctx, uid, "2026-01-01", "2026-12-31")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("materialized rows = %d, want 2 (%+v)", len(rows), rows)
	}
	run := rows[0]
	if run.Source != WorkoutSourceWeekly || run.Kind != "run" || run.Name != "轻松跑 5km" {
		t.Fatalf("run row = %+v", run)
	}
	if run.PlanID == nil || *run.PlanID != created.PlanID || run.SessionIndex == nil || *run.SessionIndex != 0 {
		t.Fatalf("weekly lineage missing: %+v", run)
	}
	if run.EstimatedDose == nil || *run.EstimatedDose != 42.5 {
		t.Fatalf("dose not materialized: %+v", run.EstimatedDose)
	}

	// Same-week re-apply (#523): old rows archived, fresh ids inserted, and the
	// new rows carry the new plan's identity (old identity rows must not block).
	replacement := WeeklyPlanReplacement{PlanID: created.PlanID, Revision: created.Revision}
	created2, replaced, err := st.ApplyStructuredWeeklyPlan(ctx, uid, weekStart, weeklyContentFor("换课节奏跑", 50), &replacement)
	if err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	if replaced == nil || replaced.PlanID != created.PlanID {
		t.Fatalf("replaced = %+v", replaced)
	}
	rows, err = st.ListPlanSessions(ctx, uid, "2026-01-01", "2026-12-31")
	if err != nil {
		t.Fatalf("list after re-apply: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("active rows after re-apply = %d, want 2", len(rows))
	}
	for _, row := range rows {
		if row.PlanID == nil || *row.PlanID != created2.PlanID {
			t.Fatalf("row not re-materialized under new plan: %+v", row)
		}
		if row.Name != "换课节奏跑" && row.Name != "休息" {
			t.Fatalf("stale row survived: %+v", row)
		}
	}
	// dose updated on the re-materialized run row
	if rows[0].EstimatedDose == nil || *rows[0].EstimatedDose != 50 {
		t.Fatalf("re-materialized dose = %v, want 50", rows[0].EstimatedDose)
	}
}

func TestCustomWorkoutUpsertAndArchive(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	in := UpsertCustomWorkoutInput{
		Date: "2026-02-02", Kind: "run", Name: "自建节奏跑",
		EstimatedDose: float64Ptr(12.5), SaveToken: "token-abc",
	}
	row1, err := st.UpsertCustomWorkout(ctx, uid, in)
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	// Idempotent replay: same save_token updates the same row in place.
	in.Name = "改名节奏跑"
	row2, err := st.UpsertCustomWorkout(ctx, uid, in)
	if err != nil {
		t.Fatalf("upsert replay: %v", err)
	}
	if row1.WorkoutID != row2.WorkoutID || row2.Name != "改名节奏跑" {
		t.Fatalf("replay not idempotent: %s vs %s (%s)", row1.WorkoutID, row2.WorkoutID, row2.Name)
	}

	// Distinct token → distinct row.
	in2 := UpsertCustomWorkoutInput{Date: "2026-02-03", Kind: "strength", Name: "自建力量", SaveToken: "token-xyz"}
	if _, err := st.UpsertCustomWorkout(ctx, uid, in2); err != nil {
		t.Fatalf("upsert 2: %v", err)
	}
	customs, err := st.ListCustomWorkouts(ctx, uid, "2026-02-01", "2026-02-08")
	if err != nil {
		t.Fatalf("list custom: %v", err)
	}
	if len(customs) != 2 {
		t.Fatalf("custom rows = %d, want 2", len(customs))
	}

	// Soft delete archives; the save_token identity is freed, so re-creating
	// with the same token must mint a fresh workout_id.
	ok, err := st.ArchiveCustomWorkout(ctx, uid, row1.WorkoutID)
	if err != nil || !ok {
		t.Fatalf("archive: ok=%v err=%v", ok, err)
	}
	ok, err = st.ArchiveCustomWorkout(ctx, uid, row1.WorkoutID)
	if err != nil || ok {
		t.Fatalf("double archive: ok=%v err=%v", ok, err)
	}
	row3, err := st.UpsertCustomWorkout(ctx, uid, UpsertCustomWorkoutInput{
		Date: "2026-02-02", Kind: "run", Name: "重建节奏跑", SaveToken: "token-abc",
	})
	if err != nil {
		t.Fatalf("upsert after archive: %v", err)
	}
	if row3.WorkoutID == row1.WorkoutID {
		t.Fatalf("archived row identity not freed: %s", row3.WorkoutID)
	}
	// The unified projection sees custom rows too, archived ones never.
	sessions, err := st.ListPlanSessions(ctx, uid, "2026-02-01", "2026-02-08")
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	// 2026-02-02 rebuilt row + 2026-02-03 strength row.
	if len(sessions) != 2 {
		t.Fatalf("plan sessions = %d, want 2 (%+v)", len(sessions), sessions)
	}
	if sessions[0].Source != WorkoutSourceCustom || sessions[0].Date != "2026-02-02" {
		t.Fatalf("first session = %+v", sessions[0])
	}
}

func TestListPlanSessionsWindowValidation(t *testing.T) {
	st := openTestStore(t)
	if _, err := st.ListPlanSessions(context.Background(), "u1", "bad", "2026-01-01"); err == nil {
		t.Fatal("expected invalid date_from error")
	}
}

func float64Ptr(f float64) *float64 { return &f }

// TestWatchWorkoutUpsertAndWindowCleanup locks the devops#588 watch-source
// contract: idempotent upsert on the provider:entity identity, re-activation
// after archive mints a fresh row, and the −7/+90 out-of-window cleanup
// archives only watch rows — weekly / custom rows are never touched.
func TestWatchWorkoutUpsertAndWindowCleanup(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	run := func(name, date, spec string) WatchWorkoutInput {
		return WatchWorkoutInput{
			Provider: "coros", EntityID: "ent-1", Date: date, Kind: "run",
			Name: name, SpecJSON: spec,
		}
	}

	// Seed a weekly row (same user, outside any window edge) and a custom row
	// that must survive every cleanup below.
	_, _, err := st.ApplyStructuredWeeklyPlan(ctx, uid, "2026-01-19", weeklyContentFor("周计划课", 40), nil)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	custom, err := st.UpsertCustomWorkout(ctx, uid, UpsertCustomWorkoutInput{
		Date: "2026-01-01", Kind: "run", Name: "自建跑", SaveToken: "tok-watch-test",
	})
	if err != nil {
		t.Fatalf("custom: %v", err)
	}

	if err := st.UpsertWatchWorkouts(ctx, uid, []WatchWorkoutInput{run("表上轻松跑", "2026-03-10", `{"schema":"run-workout/v1","name":"表上轻松跑","date":"2026-03-10","blocks":[{"repeat":1,"steps":[]}]}`)}, "2026-01-20", "2026-04-10"); err != nil {
		t.Fatalf("upsert 1: %v", err)
	}

	// Re-pull the same entity with new content: updated in place, no duplicate.
	if err := st.UpsertWatchWorkouts(ctx, uid, []WatchWorkoutInput{run("表上轻松跑(改)", "2026-03-10", `{"schema":"run-workout/v1","name":"表上轻松跑(改)","date":"2026-03-10","blocks":[{"repeat":1,"steps":[]}]}`)}, "2026-01-20", "2026-04-10"); err != nil {
		t.Fatalf("upsert replay: %v", err)
	}
	sessions, err := st.ListPlanSessions(ctx, uid, "2025-12-01", "2026-12-31")
	if err != nil {
		t.Fatalf("list 1: %v", err)
	}
	// weeklyContentFor materializes two weekly rows (run + rest).
	if len(sessions) != 4 {
		t.Fatalf("plan sessions = %d, want 4 (%+v)", len(sessions), sessions)
	}
	// Ordering: date ASC first, then weekly → custom → watch (devops#525).
	for i, want := range []string{WorkoutSourceCustom, WorkoutSourceWeekly, WorkoutSourceWeekly, WorkoutSourceWatch} {
		if sessions[i].Source != want {
			t.Fatalf("session %d source = %s, want %s", i, sessions[i].Source, want)
		}
	}
	watch := sessions[3]
	if watch.Name != "表上轻松跑(改)" || watch.Provider == nil || *watch.Provider != "coros" ||
		watch.ProviderEntityID == nil || *watch.ProviderEntityID != "ent-1" {
		t.Fatalf("watch row = %+v", watch)
	}
	firstID := watch.WorkoutID

	// A pull whose window no longer covers the row archives it — and nothing else.
	if err := st.UpsertWatchWorkouts(ctx, uid, nil, "2026-04-01", "2026-06-30"); err != nil {
		t.Fatalf("upsert 2: %v", err)
	}
	sessions, err = st.ListPlanSessions(ctx, uid, "2025-12-01", "2026-12-31")
	if err != nil {
		t.Fatalf("list 2: %v", err)
	}
	// Cleanup archived only the watch row: custom + both weekly rows survive
	// even though their dates sit outside the new window (scoped by source).
	if len(sessions) != 3 || sessions[0].WorkoutID != custom.WorkoutID ||
		sessions[1].Source != WorkoutSourceWeekly || sessions[2].Source != WorkoutSourceWeekly {
		t.Fatalf("after cleanup sessions = %+v, want weekly+custom only", sessions)
	}

	// The identity is freed while archived: a re-pull mints a fresh row.
	if err := st.UpsertWatchWorkouts(ctx, uid, []WatchWorkoutInput{run("表上轻松跑", "2026-05-01", `{"schema":"run-workout/v1","name":"表上轻松跑","date":"2026-05-01","blocks":[{"repeat":1,"steps":[]}]}`)}, "2026-04-01", "2026-06-30"); err != nil {
		t.Fatalf("upsert 3: %v", err)
	}
	sessions, err = st.ListPlanSessions(ctx, uid, "2025-12-01", "2026-12-31")
	if err != nil {
		t.Fatalf("list 3: %v", err)
	}
	if len(sessions) != 4 {
		t.Fatalf("re-activated sessions = %d, want 4", len(sessions))
	}
	if sessions[3].WorkoutID == firstID {
		t.Fatalf("archived watch identity not freed: %s", firstID)
	}

	// The weekly row keeps its plan lineage through all of this.
	if sessions[1].PlanID == nil {
		t.Fatalf("weekly row lineage lost: %+v", sessions[0])
	}
}
