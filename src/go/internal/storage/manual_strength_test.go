package storage

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestManualStrengthSaveRetriesAndPreservesTrainingWindow(t *testing.T) {
	store := openWatchTestStore(t)
	ctx := context.Background()
	if err := store.AutoMigrateUserDeletionAudit(ctx); err != nil {
		t.Fatal(err)
	}
	owner, other, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	started := time.Date(2026, 3, 31, 15, 54, 0, 0, time.UTC)
	initialEnd := started.Add(8 * time.Minute)
	write := ManualStrengthWrite{
		MutationID: uuid.NewString(), Name: "晚间力量", StartedAt: started,
		Actions: []ManualStrengthAction{{Name: "罗马尼亚硬拉", Sets: []ManualStrengthSet{
			{Load: "20 + 杠", LoadUnit: "kg", Quantity: 12, QuantityUnit: "reps"},
		}}},
	}
	first, err := store.SaveManualStrength(ctx, owner, id, write, initialEnd)
	if err != nil || first.Revision != 1 || !first.EndedAt.Equal(initialEnd) {
		t.Fatalf("first save: %+v, %v", first, err)
	}
	retried, err := store.SaveManualStrength(ctx, owner, id, write, initialEnd.Add(time.Hour))
	if err != nil || retried.Revision != 1 || !retried.EndedAt.Equal(initialEnd) {
		t.Fatalf("retry: %+v, %v", retried, err)
	}
	if _, err := store.SaveManualStrength(ctx, other, id, write, initialEnd); !errors.Is(err, ErrManualStrengthNotFound) {
		t.Fatalf("cross-user save error: %v", err)
	}
	if forbidden, err := store.ManualStrengthByID(ctx, other, id); err != nil || forbidden != nil {
		t.Fatalf("cross-user read: %+v, %v", forbidden, err)
	}
	continued := write
	continued.Revision = 1
	continued.MutationID = uuid.NewString()
	continued.Note = "第二组继续加量"
	end := initialEnd.Add(time.Minute)
	second, err := store.SaveManualStrength(ctx, owner, id, continued, end)
	if err != nil || second.Revision != 2 || !second.EndedAt.Equal(end) {
		t.Fatalf("continued save: %+v, %v", second, err)
	}
	if _, err := store.SaveManualStrength(ctx, owner, id, write, end); !errors.Is(err, ErrManualStrengthConflict) {
		t.Fatalf("stale retry error: %v", err)
	}
	edit := ManualStrengthWrite{
		Revision: 2, MutationID: uuid.NewString(), Name: "补正训练名称", Actions: write.Actions,
	}
	updated, err := store.SaveManualStrength(ctx, owner, id, edit, end.Add(24*time.Hour))
	if err != nil || updated.Revision != 3 || updated.Name != "补正训练名称" ||
		!updated.StartedAt.Equal(started) || !updated.EndedAt.Equal(end) {
		t.Fatalf("history edit: %+v, %v", updated, err)
	}

	seedActivity(t, store, owner, &Activity{
		LabelID: "watch-strength", Name: sptr("手表力量训练"), Date: started.Add(time.Second),
		SportType: 402, SportName: sptr("Strength"), DurationS: f(60),
	}, nil, nil, nil)
	page, err := store.ListActivities(ctx, owner, ActivityListParams{Limit: 1, Offset: 1, IncludeManualStrength: true})
	if err != nil || page.Total != 2 || len(page.Rows) != 1 || page.Rows[0].LabelID != id ||
		page.Rows[0].Provider != ManualStrengthProvider || page.Rows[0].DurationS != nil ||
		page.MonthlySummaries["2026-03"].ActivityCount != 2 || page.MonthlySummaries["2026-03"].DurationS != 60 ||
		page.ManualStrengthSummaries[id] != (ManualStrengthSummary{ActionCount: 1, SetCount: 1}) {
		t.Fatalf("mixed strength page: %+v, %v", page, err)
	}
	watchOnly, err := store.ListActivities(ctx, owner, ActivityListParams{Limit: 50})
	if err != nil || watchOnly.Total != 1 || len(watchOnly.Rows) != 1 || watchOnly.Rows[0].LabelID != "watch-strength" ||
		len(watchOnly.ManualStrengthSummaries) != 0 {
		t.Fatalf("existing watch page: %+v, %v", watchOnly, err)
	}

	retry := make(chan error, 1)
	go func() {
		_, err := store.SaveManualStrength(ctx, owner, id, write, end)
		retry <- err
	}()
	deleteErr := store.DeleteManualStrength(ctx, owner, id)
	if err := <-retry; !errors.Is(err, ErrManualStrengthConflict) && !errors.Is(err, ErrManualStrengthNotFound) {
		t.Fatalf("stale save racing with deletion: %v", err)
	}
	if deleteErr != nil {
		t.Fatal(deleteErr)
	}
	page, err = store.ListActivities(ctx, owner, ActivityListParams{Limit: 50, IncludeManualStrength: true})
	if err != nil || page.Total != 1 || len(page.Rows) != 1 || page.Rows[0].LabelID != "watch-strength" ||
		page.MonthlySummaries["2026-03"].ActivityCount != 1 || len(page.ManualStrengthSummaries) != 0 {
		t.Fatalf("mixed page after deletion: %+v, %v", page, err)
	}
}

func TestListActivities_LargeManualStrengthSummaries(t *testing.T) {
	store := openWatchTestStore(t)
	ctx := t.Context()
	if err := store.AutoMigrateUserDeletionAudit(ctx); err != nil {
		t.Fatal(err)
	}
	owner := uuid.NewString()
	started := time.Date(2026, 3, 31, 2, 0, 0, 0, time.UTC)
	sets := make([]ManualStrengthSet, 1000)
	set := ManualStrengthSet{Load: strings.Repeat("负", 120), LoadUnit: "kg", Quantity: 1, QuantityUnit: "reps"}
	for i := range sets {
		sets[i] = set
	}
	for i := range 3 {
		id := uuid.NewString()
		start := started.Add(time.Duration(i) * time.Hour)
		_, err := store.SaveManualStrength(ctx, owner, id, ManualStrengthWrite{
			MutationID: uuid.NewString(), Name: "力量训练", StartedAt: start,
			Actions: []ManualStrengthAction{{Name: "深蹲", Sets: sets}},
		}, start.Add(time.Minute))
		if err != nil {
			t.Fatal(err)
		}
	}
	page, err := store.ListActivities(ctx, owner, ActivityListParams{Limit: 50, IncludeManualStrength: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Rows) != 3 {
		t.Fatalf("rows: %d, want 3", len(page.Rows))
	}
	for _, row := range page.Rows {
		if summary := page.ManualStrengthSummaries[row.LabelID]; summary != (ManualStrengthSummary{ActionCount: 1, SetCount: 1000}) {
			t.Fatalf("list counts: %+v", summary)
		}
	}
}
