package storage

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

func TestMasterPlanConcurrentSameTokenCommitsOneBatch(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	migrateBatchWeeklyPlans(t, st)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatal(err)
	}
	uid, goal, token := uuid.NewString(), uuid.NewString(), uuid.NewString()
	week := timefmt.ShanghaiWeekStart(time.Now()).AddDate(0, 0, 7).Format("2006-01-02")
	items := []WeeklyPlanBatchItem{{WeekStart: week, Content: batchWeeklyContent(week, week, "one")}}
	type result struct {
		plan *MasterPlan
		err  error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	for range 2 {
		go func() {
			<-start
			plan, _, err := st.ApplyStructuredMasterPlanWithWeeks(ctx, uid, goal, `{"goal":{}}`, token, nil, items)
			results <- result{plan, err}
		}()
	}
	close(start)
	one, two := <-results, <-results
	if one.err != nil || two.err != nil || one.plan == nil || two.plan == nil || one.plan.PlanID != two.plan.PlanID {
		t.Fatalf("one=%+v two=%+v", one, two)
	}
	workouts, err := st.ListPlanSessions(ctx, uid, week, week)
	if err != nil || len(workouts) != 1 {
		t.Fatalf("workouts=%+v err=%v", workouts, err)
	}
	plans, err := st.ListActiveWeeklyPlans(ctx, uid)
	if err != nil || len(plans) != 1 || plans[0].Revision != 1 {
		t.Fatalf("weeks=%+v err=%v", plans, err)
	}
}

func TestRollingBatchCannotWriteAfterSeasonIsReplaced(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	migrateBatchWeeklyPlans(t, st)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatal(err)
	}
	uid, goal := uuid.NewString(), uuid.NewString()
	old, _, err := st.ApplyStructuredMasterPlan(ctx, uid, goal, `{"goal":{}}`, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = st.ApplyStructuredMasterPlanWithWeeks(ctx, uid, goal, `{"goal":{}}`, "", &MasterPlanReplacement{PlanID: old.PlanID, Revision: *old.Revision}, nil)
	if err != nil {
		t.Fatal(err)
	}
	week := timefmt.ShanghaiWeekStart(time.Now()).AddDate(0, 0, 7).Format("2006-01-02")
	items := []WeeklyPlanBatchItem{{WeekStart: week, Content: batchWeeklyContent(week, week, "stale")}}
	_, err = st.ApplyStructuredWeeklyPlansBatch(ctx, uid, items, old.PlanID)
	if !errors.Is(err, ErrMasterPlanConflict) {
		t.Fatalf("stale rolling batch err=%v", err)
	}
	row, err := st.GetActiveWeeklyPlan(ctx, uid, week)
	if err != nil || row != nil {
		t.Fatalf("stale week=%+v err=%v", row, err)
	}
}
