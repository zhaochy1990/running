package storage

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestWeeklyPlanStatusSlotAllowsManyDraftsButOneActive(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	userID := uuid.NewString()
	ctx := context.Background()

	// Three drafts for the same week coexist (status_slot NULL is not unique).
	for i := 0; i < 3; i++ {
		seedWeeklyPlan(t, store, weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusDraft))
	}
	// A second active for the same week still violates the unique index.
	seedWeeklyPlan(t, store, weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusActive))
	if err := store.db.WithContext(ctx).Create(weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusActive)).Error; !isDuplicateKey(err) {
		t.Fatalf("second active must be duplicate key, got %v", err)
	}
	// Any number of archived rows are also allowed.
	for i := 0; i < 3; i++ {
		seedWeeklyPlan(t, store, weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusArchived))
	}
}

func TestInsertMasterPlanDraftIsIdempotentByDraftID(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()
	userID, goalID, draftID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	content := "{\"goal\":{\"goal_id\":\"" + goalID + "\",\"target_time\":\"3:30:00\"},\"phases\":[],\"milestones\":[],\"weeks\":[]}"

	first, created, err := st.InsertMasterPlanDraft(ctx, userID, goalID, content, draftID)
	if err != nil || !created || first == nil {
		t.Fatalf("first insert: created=%t plan=%+v err=%v", created, first, err)
	}
	if first.PlanID != draftID || first.Status != MasterPlanStatusDraft || first.ActiveFlag != nil {
		t.Fatalf("draft row = %+v, want status=draft, nil active_flag, plan_id=%s", first, draftID)
	}
	if first.Revision == nil || *first.Revision != 1 {
		t.Fatalf("draft revision = %v, want 1", first.Revision)
	}

	// Replay with the same draft id returns the existing row, not a duplicate.
	again, created, err := st.InsertMasterPlanDraft(ctx, userID, goalID, content, draftID)
	if err != nil || created || again == nil || again.PlanID != draftID {
		t.Fatalf("replay insert: created=%t plan=%+v err=%v", created, again, err)
	}
	var count int64
	if err := st.db.WithContext(ctx).Model(&MasterPlan{}).Where("user_id = ?", userID).Count(&count).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("row count = %d, want 1", count)
	}
}

func TestInsertMasterPlanDraftRejectsInvalidInput(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()
	userID, goalID, draftID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	content := "{\"goal\":{\"goal_id\":\"" + goalID + "\",\"target_time\":\"3:30:00\"},\"phases\":[],\"milestones\":[],\"weeks\":[]}"

	if _, _, err := st.InsertMasterPlanDraft(ctx, "", goalID, content, draftID); err == nil {
		t.Fatal("empty user id must fail")
	}
	if _, _, err := st.InsertMasterPlanDraft(ctx, userID, "bad", content, draftID); err == nil {
		t.Fatal("invalid goal id must fail")
	}
	if _, _, err := st.InsertMasterPlanDraft(ctx, userID, goalID, "", draftID); err == nil {
		t.Fatal("empty content must fail")
	}
	if _, _, err := st.InsertMasterPlanDraft(ctx, userID, goalID, content, "bad-id"); err == nil {
		t.Fatal("invalid draft id must fail")
	}
}

func TestActivateMasterPlanDraftArchivesActiveAndPromotesDraft(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()
	userID, goalID := uuid.NewString(), uuid.NewString()

	active, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID,
		`{"goal":{"goal_id":"`+goalID+`","target_time":"3:30:00"},"phases":[],"milestones":[],"weeks":[]}`, nil)
	if err != nil {
		t.Fatalf("apply active: %v", err)
	}

	content := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:25:00"},"phases":[],"milestones":[],"weeks":[]}`
	draftID := uuid.NewString()
	draft, _, err := st.InsertMasterPlanDraft(ctx, userID, goalID, content, draftID)
	if err != nil {
		t.Fatalf("insert draft: %v", err)
	}
	// A sibling draft that must stay draft after the activate.
	sibling, _, err := st.InsertMasterPlanDraft(ctx, userID, goalID, content, uuid.NewString())
	if err != nil {
		t.Fatalf("insert sibling draft: %v", err)
	}

	activated, replaced, err := st.ActivateMasterPlanDraft(ctx, userID, draftID)
	if err != nil {
		t.Fatalf("activate draft: %v", err)
	}
	if activated == nil || activated.PlanID != draftID || activated.Status != MasterPlanStatusActive || activated.ActiveFlag == nil || *activated.ActiveFlag != 1 {
		t.Fatalf("activated = %+v, want active draft %s", activated, draftID)
	}
	if replaced == nil || replaced.PlanID != active.PlanID || replaced.Status != MasterPlanStatusArchived || replaced.ActiveFlag != nil {
		t.Fatalf("replaced = %+v, want archived prior active %s", replaced, active.PlanID)
	}

	current, err := st.GetCurrentMasterPlan(ctx, userID)
	if err != nil || current == nil || current.PlanID != draftID {
		t.Fatalf("current = %+v err=%v, want the activated draft", current, err)
	}

	// The sibling draft is untouched.
	sib, err := st.GetMasterPlanDraft(ctx, userID, sibling.PlanID)
	if err != nil || sib == nil || sib.Status != MasterPlanStatusDraft {
		t.Fatalf("sibling = %+v err=%v, want still draft", sib, err)
	}
	_ = draft
}

func TestActivateMasterPlanDraftConcurrentActivations(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()
	userID, goalID := uuid.NewString(), uuid.NewString()
	content := "{\"goal\":{\"goal_id\":\"" + goalID + "\",\"target_time\":\"3:30:00\"},\"phases\":[],\"milestones\":[],\"weeks\":[]}"

	errChan := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			draftID := uuid.NewString()
			if _, _, err := st.InsertMasterPlanDraft(ctx, userID, goalID, content, draftID); err != nil {
				errChan <- err
				return
			}
			_, _, err := st.ActivateMasterPlanDraft(ctx, userID, draftID)
			errChan <- err
		}()
	}
	for i := 0; i < 2; i++ {
		if err := <-errChan; err != nil {
			t.Fatalf("concurrent activate: %v", err)
		}
	}
	// Exactly one active remains (the unique index holds), and no invariant error.
	current, err := st.GetCurrentMasterPlan(ctx, userID)
	if err != nil || current == nil {
		t.Fatalf("current after concurrent activates: %+v err=%v", current, err)
	}
	if current.Status != MasterPlanStatusActive {
		t.Fatalf("current = %+v, want active", current)
	}
}

func TestAbandonMasterPlanDraftArchives(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()
	userID, goalID := uuid.NewString(), uuid.NewString()
	content := "{\"goal\":{\"goal_id\":\"" + goalID + "\",\"target_time\":\"3:30:00\"},\"phases\":[],\"milestones\":[],\"weeks\":[]}"

	draft, _, err := st.InsertMasterPlanDraft(ctx, userID, goalID, content, uuid.NewString())
	if err != nil {
		t.Fatalf("insert draft: %v", err)
	}
	abandoned, err := st.AbandonMasterPlanDraft(ctx, userID, draft.PlanID)
	if err != nil {
		t.Fatalf("abandon: %v", err)
	}
	if abandoned == nil || abandoned.Status != MasterPlanStatusArchived || abandoned.ActiveFlag != nil {
		t.Fatalf("abandoned = %+v, want archived", abandoned)
	}
	// The id no longer resolves as a draft; activating/abandoning again errors.
	if _, err := st.AbandonMasterPlanDraft(ctx, userID, draft.PlanID); !errors.Is(err, ErrMasterPlanDraftNotFound) {
		t.Fatalf("second abandon err = %v, want ErrMasterPlanDraftNotFound", err)
	}
}

func TestInsertWeeklyPlanDraftIsIdempotentByDraftID(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	ctx := context.Background()
	userID, draftID := uuid.NewString(), uuid.NewString()
	content := "{\"schema\":\"weekly-plan/v1\",\"week_name\":\"2026-08-17_08-23\",\"sessions\":[],\"nutrition\":[]}"

	first, created, err := store.InsertWeeklyPlanDraft(ctx, userID, "2026-08-17", content, draftID)
	if err != nil || !created || first == nil {
		t.Fatalf("first insert: created=%t plan=%+v err=%v", created, first, err)
	}
	if first.PlanID != draftID || first.Status != WeeklyPlanStatusDraft || first.StatusSlot != nil {
		t.Fatalf("draft row = %+v, want status=draft, nil status_slot", first)
	}
	if first.Revision != 1 {
		t.Fatalf("draft revision = %d, want 1", first.Revision)
	}

	again, created, err := store.InsertWeeklyPlanDraft(ctx, userID, "2026-08-17", content, draftID)
	if err != nil || created || again == nil || again.PlanID != draftID {
		t.Fatalf("replay insert: created=%t plan=%+v err=%v", created, again, err)
	}
	var count int64
	if err := store.db.WithContext(ctx).Model(&WeeklyPlan{}).Where("user_id = ?", userID).Count(&count).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("row count = %d, want 1", count)
	}
}

func TestInsertWeeklyPlanDraftRejectsNonMonday(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	if _, _, err := store.InsertWeeklyPlanDraft(context.Background(), uuid.NewString(), "2026-08-18", "{}", uuid.NewString()); err == nil {
		t.Fatal("non-Monday week_start must fail")
	}
}

func TestActivateWeeklyPlanDraftArchivesActiveAndKeepsSiblings(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	migrateMasterPlan(t, store)
	ctx := context.Background()
	userID := uuid.NewString()
	weekStart := "2026-08-17"
	content := "{\"schema\":\"weekly-plan/v1\",\"week_name\":\"2026-08-17_08-23\",\"sessions\":[],\"nutrition\":[]}"

	active, _, err := store.ApplyStructuredWeeklyPlan(ctx, userID, weekStart, content, nil)
	if err != nil {
		t.Fatalf("apply active: %v", err)
	}

	draft, _, err := store.InsertWeeklyPlanDraft(ctx, userID, weekStart, content, uuid.NewString())
	if err != nil {
		t.Fatalf("insert draft: %v", err)
	}
	sibling, _, err := store.InsertWeeklyPlanDraft(ctx, userID, weekStart, content, uuid.NewString())
	if err != nil {
		t.Fatalf("insert sibling: %v", err)
	}

	activated, replaced, err := store.ActivateWeeklyPlanDraft(ctx, userID, weekStart, draft.PlanID)
	if err != nil {
		t.Fatalf("activate draft: %v", err)
	}
	if activated == nil || activated.PlanID != draft.PlanID || activated.Status != WeeklyPlanStatusActive || activated.StatusSlot == nil || *activated.StatusSlot != WeeklyPlanStatusActive {
		t.Fatalf("activated = %+v, want active draft %s", activated, draft.PlanID)
	}
	if replaced == nil || replaced.PlanID != active.PlanID || replaced.Status != WeeklyPlanStatusArchived || replaced.StatusSlot != nil {
		t.Fatalf("replaced = %+v, want archived prior active %s", replaced, active.PlanID)
	}

	got, err := store.GetActiveWeeklyPlan(ctx, userID, weekStart)
	if err != nil || got == nil || got.PlanID != draft.PlanID {
		t.Fatalf("active = %+v err=%v, want the activated draft", got, err)
	}

	// Sibling stays draft.
	sib, err := store.GetWeeklyPlanDraft(ctx, userID, sibling.PlanID)
	if err != nil || sib == nil || sib.Status != WeeklyPlanStatusDraft {
		t.Fatalf("sibling = %+v err=%v, want still draft", sib, err)
	}
}

func TestActivateWeeklyPlanDraftConcurrentActivations(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	ctx := context.Background()
	userID := uuid.NewString()
	weekStart := "2026-08-17"
	content := "{\"schema\":\"weekly-plan/v1\",\"week_name\":\"2026-08-17_08-23\",\"sessions\":[],\"nutrition\":[]}"

	start := make(chan struct{})
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			draftID := uuid.NewString()
			if _, _, err := store.InsertWeeklyPlanDraft(ctx, userID, weekStart, content, draftID); err != nil {
				errs <- err
				return
			}
			_, _, err := store.ActivateWeeklyPlanDraft(ctx, userID, weekStart, draftID)
			errs <- err
		}()
	}
	close(start)
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent activate: %v", err)
		}
	}
	// Exactly one active row per week remains.
	got, err := store.GetActiveWeeklyPlan(ctx, userID, weekStart)
	if err != nil || got == nil || got.Status != WeeklyPlanStatusActive {
		t.Fatalf("active = %+v err=%v, want exactly one active", got, err)
	}
}

func TestAbandonWeeklyPlanDraftArchives(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	ctx := context.Background()
	userID := uuid.NewString()
	content := "{\"schema\":\"weekly-plan/v1\",\"week_name\":\"2026-08-17_08-23\",\"sessions\":[],\"nutrition\":[]}"

	draft, _, err := store.InsertWeeklyPlanDraft(ctx, userID, "2026-08-17", content, uuid.NewString())
	if err != nil {
		t.Fatalf("insert draft: %v", err)
	}
	abandoned, err := store.AbandonWeeklyPlanDraft(ctx, userID, draft.PlanID)
	if err != nil {
		t.Fatalf("abandon: %v", err)
	}
	if abandoned == nil || abandoned.Status != WeeklyPlanStatusArchived || abandoned.StatusSlot != nil {
		t.Fatalf("abandoned = %+v, want archived", abandoned)
	}
	if _, err := store.AbandonWeeklyPlanDraft(ctx, userID, draft.PlanID); !errors.Is(err, ErrWeeklyPlanDraftNotFound) {
		t.Fatalf("second abandon err = %v, want ErrWeeklyPlanDraftNotFound", err)
	}
}
