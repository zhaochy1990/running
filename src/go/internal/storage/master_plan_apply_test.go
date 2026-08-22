package storage

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestApplyStructuredMasterPlanCreatesAndReplacesAtomically(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()

	userID := uuid.NewString()
	goalID := uuid.NewString()
	content := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:30:00"},"phases":[],"milestones":[],"weeks":[]}`

	first, replaced, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, nil)
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}
	if first == nil {
		t.Fatalf("first apply returned nil plan")
	}
	if first.UserID != userID || first.GoalID != goalID {
		t.Fatalf("first row identity = %+v", first)
	}
	if first.ContentVersion != MasterPlanContentStructured || first.Status != MasterPlanStatusActive {
		t.Fatalf("first row markers = %d/%s", first.ContentVersion, first.Status)
	}
	if first.ActiveFlag == nil || *first.ActiveFlag != 1 {
		t.Fatalf("first row active_flag = %v", first.ActiveFlag)
	}
	if first.Revision == nil || *first.Revision != 1 {
		t.Fatalf("first row revision = %v, want 1", first.Revision)
	}
	if replaced != nil {
		t.Fatalf("first apply must not replace, got %+v", replaced)
	}

	if _, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, nil); !errors.Is(err, ErrMasterPlanExists) {
		t.Fatalf("second apply without replacement: err = %v, want ErrMasterPlanExists", err)
	}

	updatedContent := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:25:00"},"phases":[],"milestones":[],"weeks":[]}`
	second, replaced2, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, updatedContent, &MasterPlanReplacement{PlanID: first.PlanID, Revision: *first.Revision})
	if err != nil {
		t.Fatalf("replace apply: %v", err)
	}
	if second == nil || second.ContentVersion != MasterPlanContentStructured || second.Status != MasterPlanStatusActive {
		t.Fatalf("replacement row = %+v", second)
	}
	if second.Revision == nil || *second.Revision != 1 {
		t.Fatalf("replacement row revision = %v, want 1", second.Revision)
	}
	if replaced2 == nil || replaced2.PlanID != first.PlanID || replaced2.Status != MasterPlanStatusArchived || replaced2.ActiveFlag != nil {
		t.Fatalf("replaced row = %+v, want archived %s", replaced2, first.PlanID)
	}

	current, err := st.GetCurrentMasterPlan(ctx, userID)
	if err != nil {
		t.Fatalf("get current: %v", err)
	}
	if current.PlanID != second.PlanID || current.Content != updatedContent {
		t.Fatalf("current row = %+v, want replacement", current)
	}
}

func TestApplyStructuredMasterPlanRejectsInvalidInput(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()

	userID := uuid.NewString()
	goalID := uuid.NewString()
	content := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:30:00"},"phases":[],"milestones":[],"weeks":[]}`

	if _, _, err := st.ApplyStructuredMasterPlan(ctx, "", goalID, content, nil); err == nil {
		t.Fatalf("empty user id must fail")
	}
	if _, _, err := st.ApplyStructuredMasterPlan(ctx, userID, "invalid-uuid", content, nil); err == nil {
		t.Fatalf("invalid goal id must fail")
	}
	if _, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, "", nil); err == nil {
		t.Fatalf("empty content must fail")
	}
	if _, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, "   ", nil); err == nil {
		t.Fatalf("whitespace content must fail")
	}
}

func TestApplyStructuredMasterPlanConcurrentFirstApplyReturnsConflict(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()

	userID := uuid.NewString()
	goalID := uuid.NewString()
	content := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:30:00"},"phases":[],"milestones":[],"weeks":[]}`

	errChan := make(chan error, 2)
	results := make(chan *MasterPlan, 2)

	for i := 0; i < 2; i++ {
		go func() {
			created, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, nil)
			if err != nil {
				errChan <- err
			} else {
				results <- created
			}
		}()
	}

	var gotConflict, gotSuccess bool
	for i := 0; i < 2; i++ {
		select {
		case err := <-errChan:
			if errors.Is(err, ErrMasterPlanExists) {
				gotConflict = true
			}
		case <-results:
			gotSuccess = true
		}
	}
	if !gotSuccess {
		t.Fatalf("at least one apply must succeed")
	}
	if !gotConflict {
		t.Fatalf("at least one apply must conflict")
	}
}

func TestApplyStructuredMasterPlanRejectsStaleReplacement(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()

	userID := uuid.NewString()
	goalID := uuid.NewString()
	content := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:30:00"},"phases":[],"milestones":[],"weeks":[]}`

	active, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, nil)
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}

	_, _, err = st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, &MasterPlanReplacement{PlanID: active.PlanID, Revision: *active.Revision + 1})
	if !errors.Is(err, ErrMasterPlanConflict) {
		t.Fatalf("stale replacement: err = %v, want ErrMasterPlanConflict", err)
	}
}

func TestUpdateActiveMasterPlanBumpsRevisionInPlace(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()

	userID := uuid.NewString()
	goalID := uuid.NewString()
	content := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:30:00"},"phases":[],"milestones":[],"weeks":[]}`

	active, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, nil)
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}

	updatedContent := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:25:00"},"phases":[],"milestones":[],"weeks":[]}`
	updated, err := st.UpdateActiveMasterPlan(ctx, userID, goalID, updatedContent, &MasterPlanReplacement{PlanID: active.PlanID, Revision: *active.Revision})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.PlanID != active.PlanID {
		t.Fatalf("plan_id changed: %s -> %s", active.PlanID, updated.PlanID)
	}
	if updated.Revision == nil || *updated.Revision != 2 {
		t.Fatalf("revision = %v, want 2", updated.Revision)
	}
	if updated.Content != updatedContent {
		t.Fatalf("content not updated")
	}

	// exactly one row remains (no archive), still active, same identity.
	var rows []MasterPlan
	if err := st.db.WithContext(ctx).Where("user_id = ?", userID).Find(&rows).Error; err != nil {
		t.Fatalf("load rows: %v", err)
	}
	if len(rows) != 1 || rows[0].Status != MasterPlanStatusActive {
		t.Fatalf("rows = %+v, want single active row", rows)
	}

	current, err := st.GetCurrentMasterPlan(ctx, userID)
	if err != nil || current == nil || current.PlanID != active.PlanID {
		t.Fatalf("current = %+v, err=%v", current, err)
	}
}

func TestUpdateActiveMasterPlanConflicts(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()

	userID := uuid.NewString()
	goalID := uuid.NewString()
	content := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:30:00"},"phases":[],"milestones":[],"weeks":[]}`

	// no active plan -> not found
	if _, err := st.UpdateActiveMasterPlan(ctx, userID, goalID, content, &MasterPlanReplacement{PlanID: uuid.NewString(), Revision: 1}); !errors.Is(err, ErrMasterPlanNotFound) {
		t.Fatalf("no active: err = %v, want ErrMasterPlanNotFound", err)
	}
	// nil expectation -> rejected
	if _, err := st.UpdateActiveMasterPlan(ctx, userID, goalID, content, nil); err == nil {
		t.Fatalf("nil expectation must fail")
	}

	active, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, nil)
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}
	// stale revision -> conflict
	if _, err := st.UpdateActiveMasterPlan(ctx, userID, goalID, content, &MasterPlanReplacement{PlanID: active.PlanID, Revision: *active.Revision + 1}); !errors.Is(err, ErrMasterPlanConflict) {
		t.Fatalf("stale: err = %v, want ErrMasterPlanConflict", err)
	}
	// wrong plan id -> conflict
	if _, err := st.UpdateActiveMasterPlan(ctx, userID, goalID, content, &MasterPlanReplacement{PlanID: uuid.NewString(), Revision: *active.Revision}); !errors.Is(err, ErrMasterPlanConflict) {
		t.Fatalf("wrong plan id: err = %v, want ErrMasterPlanConflict", err)
	}
}

func TestUpdateActiveMasterPlanRejectsMarkdown(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()

	userID := uuid.NewString()
	goalID := uuid.NewString()
	now := time.Now().UTC().Truncate(time.Millisecond)
	activeFlag := int8(1)

	markdownPlan := &MasterPlan{
		PlanID: uuid.NewString(), UserID: userID, GoalID: goalID,
		ContentVersion: MasterPlanContentMarkdown, Content: "# Test Plan\n\nSome text",
		Status: MasterPlanStatusActive, ActiveFlag: &activeFlag,
		Revision: nil, CreatedAt: now, UpdatedAt: now,
	}
	if err := st.db.WithContext(ctx).Create(markdownPlan).Error; err != nil {
		t.Fatalf("seed markdown plan: %v", err)
	}

	content := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:30:00"},"phases":[],"milestones":[],"weeks":[]}`
	if _, err := st.UpdateActiveMasterPlan(ctx, userID, goalID, content, &MasterPlanReplacement{PlanID: markdownPlan.PlanID, Revision: 1}); !errors.Is(err, ErrMasterPlanConflict) {
		t.Fatalf("markdown update: err = %v, want ErrMasterPlanConflict", err)
	}
}

func TestApplyStructuredMasterPlanInvalidMarkdownReplacement(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()

	userID := uuid.NewString()
	goalID := uuid.NewString()

	now := time.Now().UTC().Truncate(time.Millisecond)
	activeFlag := int8(1)

	markdownPlan := &MasterPlan{
		PlanID: uuid.NewString(), UserID: userID, GoalID: goalID,
		ContentVersion: MasterPlanContentMarkdown, Content: "# Test Plan\n\nSome text",
		Status: MasterPlanStatusActive, ActiveFlag: &activeFlag,
		Revision: nil, CreatedAt: now, UpdatedAt: now,
	}
	if err := st.db.WithContext(ctx).Create(markdownPlan).Error; err != nil {
		t.Fatalf("seed markdown plan: %v", err)
	}

	updatedContent := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:30:00"},"phases":[],"milestones":[],"weeks":[]}`
	_, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, updatedContent, &MasterPlanReplacement{PlanID: markdownPlan.PlanID, Revision: 1})
	if !errors.Is(err, ErrMasterPlanConflict) {
		t.Fatalf("markdown replacement: err = %v, want ErrMasterPlanConflict", err)
	}
}
