package api

import (
	"fmt"
	"testing"
	"time"
)

// mergeAdjustedWeeklyPlan unit tests (#952): the accept-time merge keeps the
// active week's arrangements through today (inclusive) and only replaces
// tomorrow onward, so a delayed accept cannot erase days that became past
// after the proposal was generated.

func mergeTestDoc(weekStart, prefix string, runs []int, dose float64) map[string]any {
	start, _ := time.Parse("2006-01-02", weekStart)
	runSet := map[int]bool{}
	for _, offset := range runs {
		runSet[offset] = true
	}
	sessions := make([]any, 0, 7)
	nutrition := make([]any, 0, 7)
	for offset := range 7 {
		day := start.AddDate(0, 0, offset).Format("2006-01-02")
		kind, sessionDose := "rest", any(nil)
		if runSet[offset] {
			kind, sessionDose = "run", dose
		}
		sessions = append(sessions, map[string]any{
			"schema": "plan-session/v1", "date": day, "session_index": 0, "kind": kind,
			"summary": fmt.Sprintf("%s-%d", prefix, offset), "notes_md": nil,
			"total_distance_m": nil, "total_duration_s": nil, "estimated_dose": sessionDose, "spec": nil,
		})
		nutrition = append(nutrition, map[string]any{
			"schema": "plan-nutrition/v1", "date": day, "kcal_target": float64(offset),
			"carbs_g": nil, "protein_g": nil, "fat_g": nil, "water_ml": nil, "meals": []any{}, "notes_md": nil,
		})
	}
	return map[string]any{
		"schema": "weekly-plan/v1", "week_name": weekNameOf(weekStart),
		"sessions": sessions, "nutrition": nutrition, "notes_md": nil, "coach_notes": nil,
		"planned_dose": 700.0, "is_recovery_week": false,
	}
}

func weekNameOf(weekStart string) string {
	start, _ := time.Parse("2006-01-02", weekStart)
	return weekStart + "_" + start.AddDate(0, 0, 6).Format("01-02")
}

func mergeTestKey(weekStart string, offset int, distance float64) map[string]any {
	start, _ := time.Parse("2006-01-02", weekStart)
	return map[string]any{
		"type": "long_run", "distance_km": distance, "duration_min": nil,
		"intensity": "x", "purpose": nil,
		"workout_structure": map[string]any{"schema": "run-workout/v1", "date": start.AddDate(0, 0, offset).Format("2006-01-02")},
	}
}

func summaryAt(t *testing.T, weekStart string, sessions []any, offset int) string {
	t.Helper()
	start, _ := time.Parse("2006-01-02", weekStart)
	want := start.AddDate(0, 0, offset).Format("2006-01-02")
	for _, item := range sessions {
		record := item.(map[string]any)
		if day, _ := record["date"].(string); day == want {
			return record["summary"].(string)
		}
	}
	t.Fatalf("no session at %s", want)
	return ""
}

func TestMergeAdjustedWeeklyPlanKeepsThroughToday(t *testing.T) {
	weekStart := "2026-08-24"
	old := mergeTestDoc(weekStart, "old", []int{0, 2}, 10)
	newDoc := mergeTestDoc(weekStart, "new", []int{3, 5}, 20)
	for _, item := range newDoc["nutrition"].([]any) {
		record := item.(map[string]any)
		record["kcal_target"] = 100 + record["kcal_target"].(float64)
	}
	old["key_sessions"] = []any{mergeTestKey(weekStart, 0, 20), mergeTestKey(weekStart, 2, 10)}
	newDoc["key_sessions"] = []any{mergeTestKey(weekStart, 3, 30), mergeTestKey(weekStart, 5, 40)}

	merged, ok := mergeAdjustedWeeklyPlan(newDoc, old, "2026-08-26")
	if !ok {
		t.Fatal("merge should apply on Wednesday")
	}
	sessions := merged["sessions"].([]any)
	if len(sessions) != 7 {
		t.Fatalf("sessions=%d want 7", len(sessions))
	}
	for offset := range 3 {
		if got := summaryAt(t, weekStart, sessions, offset); got != fmt.Sprintf("old-%d", offset) {
			t.Fatalf("offset %d kept %q, want old arrangement", offset, got)
		}
	}
	for offset := 3; offset < 7; offset++ {
		if got := summaryAt(t, weekStart, sessions, offset); got != fmt.Sprintf("new-%d", offset) {
			t.Fatalf("offset %d took %q, want new arrangement", offset, got)
		}
	}
	// 营养：今天及以前取旧，明天起取新。
	nutrition := merged["nutrition"].([]any)
	if got := nutrition[2].(map[string]any)["kcal_target"]; got != 2.0 {
		t.Fatalf("nutrition[2]=%v, want old", got)
	}
	if got := nutrition[3].(map[string]any)["kcal_target"]; got != 103.0 {
		t.Fatalf("nutrition[3]=%v, want new", got)
	}
	// key_sessions：旧过去 + 新未来按里程降序截 3（new-40 / new-30 / old-20）。
	keys := merged["key_sessions"].([]any)
	if len(keys) != 3 {
		t.Fatalf("key_sessions=%d want 3", len(keys))
	}
	for index, want := range []float64{40, 30, 20} {
		if got := keys[index].(map[string]any)["distance_km"]; got != want {
			t.Fatalf("key_sessions[%d]=%v want %v", index, got, want)
		}
	}
	// 剂量按合并后的会话重算：旧 10×2 + 新 20×2 = 60。
	if got := merged["planned_dose"]; got != 60.0 {
		t.Fatalf("planned_dose=%v want 60", got)
	}
}

func TestMergeAdjustedWeeklyPlanDelayedAcceptProtectsNewlyPastDays(t *testing.T) {
	weekStart := "2026-08-24"
	old := mergeTestDoc(weekStart, "old", []int{0, 4}, 10)
	newDoc := mergeTestDoc(weekStart, "new", []int{3, 5}, 20)

	// 提案按周三生成，周五才同意：周四/周五已成为过去，必须取旧课表。
	merged, ok := mergeAdjustedWeeklyPlan(newDoc, old, "2026-08-28")
	if !ok {
		t.Fatal("merge should apply on Friday")
	}
	sessions := merged["sessions"].([]any)
	if got := summaryAt(t, weekStart, sessions, 3); got != "old-3" {
		t.Fatalf("Friday accept overwrote a newly-past day: %q", got)
	}
	if got := summaryAt(t, weekStart, sessions, 4); got != "old-4" {
		t.Fatalf("Friday accept overwrote today: %q", got)
	}
	if got := summaryAt(t, weekStart, sessions, 5); got != "new-5" {
		t.Fatalf("tomorrow should take the new arrangement: %q", got)
	}
}

func TestMergeAdjustedWeeklyPlanRejectsUnsafeWeeks(t *testing.T) {
	weekStart := "2026-08-24"
	newDoc := mergeTestDoc(weekStart, "new", []int{3, 5}, 20)

	// 周日：明天起没有任何安排 → 不替换（不把未冻结的新文档写回）。
	if _, ok := mergeAdjustedWeeklyPlan(newDoc, mergeTestDoc(weekStart, "old", []int{0}, 10), "2026-08-30"); ok {
		t.Fatal("Sunday must keep the active week")
	}
	// 合并后没有 run：旧过去全 rest、新未来全 rest → 不替换。
	restOld := mergeTestDoc(weekStart, "old", []int{5, 6}, 10)
	restNew := mergeTestDoc(weekStart, "new", nil, 20)
	if _, ok := mergeAdjustedWeeklyPlan(restNew, restOld, "2026-08-26"); ok {
		t.Fatal("merged week without a run must keep the active week")
	}
	// 历史已结束周 → 不可被调整路径更新。
	if _, ok := mergeAdjustedWeeklyPlan(newDoc, mergeTestDoc(weekStart, "old", []int{0}, 10), "2026-09-10"); ok {
		t.Fatal("ended week must not be replaced")
	}
}

func TestMergeAdjustedWeeklyPlanFutureWeekPassesThrough(t *testing.T) {
	weekStart := "2026-09-07"
	old := mergeTestDoc(weekStart, "old", []int{0}, 10)
	newDoc := mergeTestDoc(weekStart, "new", []int{3, 5}, 20)
	newDoc["key_sessions"] = []any{mergeTestKey(weekStart, 5, 40)}

	merged, ok := mergeAdjustedWeeklyPlan(newDoc, old, "2026-08-26")
	if !ok {
		t.Fatal("future week merge should apply")
	}
	sessions := merged["sessions"].([]any)
	for offset := range 7 {
		if got := summaryAt(t, weekStart, sessions, offset); got != fmt.Sprintf("new-%d", offset) {
			t.Fatalf("future week offset %d=%q, want new", offset, got)
		}
	}
	// 过去没有保留任何安排 → 不重算周剂量（避免无关 churn）。
	if got := merged["planned_dose"]; got != 700.0 {
		t.Fatalf("planned_dose=%v want untouched 700", got)
	}
}

func TestMergeAdjustedWeeklyPlanRecoveryKeyLimit(t *testing.T) {
	weekStart := "2026-08-24"
	old := mergeTestDoc(weekStart, "old", []int{0}, 10)
	old["key_sessions"] = []any{mergeTestKey(weekStart, 0, 20)}
	newDoc := mergeTestDoc(weekStart, "new", []int{3, 5}, 20)
	newDoc["is_recovery_week"] = true
	newDoc["key_sessions"] = []any{mergeTestKey(weekStart, 3, 30), mergeTestKey(weekStart, 5, 40)}

	merged, ok := mergeAdjustedWeeklyPlan(newDoc, old, "2026-08-26")
	if !ok {
		t.Fatal("merge should apply")
	}
	if keys := merged["key_sessions"].([]any); len(keys) != 1 || keys[0].(map[string]any)["distance_km"] != 40.0 {
		t.Fatalf("recovery week key_sessions=%v want only the longest", keys)
	}
}
