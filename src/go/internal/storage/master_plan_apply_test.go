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

	first, replaced, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, "", nil)
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

	if _, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, "", nil); !errors.Is(err, ErrMasterPlanExists) {
		t.Fatalf("second apply without replacement: err = %v, want ErrMasterPlanExists", err)
	}

	updatedContent := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:25:00"},"phases":[],"milestones":[],"weeks":[]}`
	second, replaced2, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, updatedContent, "", &MasterPlanReplacement{PlanID: first.PlanID, Revision: *first.Revision})
	if err != nil {
		t.Fatalf("replace apply: %v", err)
	}
	if second == nil || second.ContentVersion != MasterPlanContentStructured || second.Status != MasterPlanStatusActive {
		t.Fatalf("replacement row = %+v", second)
	}
	if second.Revision == nil || *second.Revision != 1 {
		t.Fatalf("replacement row revision = %v, want 1", second.Revision)
	}
	if replaced2 == nil || replaced2.PlanID != first.PlanID || replaced2.Status != MasterPlanStatusSuperseded || replaced2.ActiveFlag != nil {
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

	if _, _, err := st.ApplyStructuredMasterPlan(ctx, "", goalID, content, "", nil); err == nil {
		t.Fatalf("empty user id must fail")
	}
	if _, _, err := st.ApplyStructuredMasterPlan(ctx, userID, "invalid-uuid", content, "", nil); err == nil {
		t.Fatalf("invalid goal id must fail")
	}
	if _, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, "", "", nil); err == nil {
		t.Fatalf("empty content must fail")
	}
	if _, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, "   ", "", nil); err == nil {
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
			created, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, "", nil)
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

	active, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, "", nil)
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}

	_, _, err = st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, "", &MasterPlanReplacement{PlanID: active.PlanID, Revision: *active.Revision + 1})
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

	active, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, "", nil)
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

	active, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, "", nil)
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

func TestApplyStructuredMasterPlanReplacesMarkdown(t *testing.T) {
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

	// A legacy markdown row has a NULL revision; the caller confirms the plan
	// ID and supplies a sentinel revision (the API layer requires >= 1). The
	// store must archive the markdown row and insert the new structured row.
	updatedContent := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:30:00"},"phases":[],"milestones":[],"weeks":[]}`
	created, replaced, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, updatedContent, "", &MasterPlanReplacement{PlanID: markdownPlan.PlanID, Revision: 1})
	if err != nil {
		t.Fatalf("markdown replacement: err = %v, want nil", err)
	}
	if created == nil || created.ContentVersion != MasterPlanContentStructured || created.Status != MasterPlanStatusActive {
		t.Fatalf("created row = %+v, want active structured", created)
	}
	if created.Revision == nil || *created.Revision != 1 {
		t.Fatalf("created revision = %v, want 1", created.Revision)
	}
	if created.Content != updatedContent {
		t.Fatalf("created content = %q, want %q", created.Content, updatedContent)
	}
	if replaced == nil || replaced.PlanID != markdownPlan.PlanID || replaced.Status != MasterPlanStatusSuperseded || replaced.ActiveFlag != nil {
		t.Fatalf("replaced row = %+v, want archived markdown %s", replaced, markdownPlan.PlanID)
	}

	// The markdown row is now archived with its revision still NULL; the new
	// structured row is the single active plan.
	current, err := st.GetCurrentMasterPlan(ctx, userID)
	if err != nil {
		t.Fatalf("get current: %v", err)
	}
	if current.PlanID != created.PlanID || current.ContentVersion != MasterPlanContentStructured {
		t.Fatalf("current = %+v, want the new structured plan", current)
	}

	// The archived markdown row must still exist (revision NULL) so its history
	// is preserved.
	var archived []MasterPlan
	if err := st.db.WithContext(ctx).
		Where("plan_id = ? AND status = ?", markdownPlan.PlanID, MasterPlanStatusSuperseded).
		Find(&archived).Error; err != nil {
		t.Fatalf("load archived: %v", err)
	}
	if len(archived) != 1 || archived[0].Revision != nil {
		t.Fatalf("archived markdown row = %+v, want 1 row with NULL revision", archived)
	}

	// A wrong plan ID must still conflict (the sentinel revision does not
	// bypass the identity check).
	if _, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, updatedContent, "", &MasterPlanReplacement{PlanID: uuid.NewString(), Revision: 1}); !errors.Is(err, ErrMasterPlanConflict) {
		t.Fatalf("wrong plan id: err = %v, want ErrMasterPlanConflict", err)
	}
}

func TestApplyStructuredMasterPlanApplyTokenIsIdempotent(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()

	userID := uuid.NewString()
	goalID := uuid.NewString()
	content := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:30:00"},"phases":[],"milestones":[],"weeks":[]}`
	token := uuid.NewString()

	// #585: the first apply claims the token; a replay returns the SAME row
	// (created stays the only plan) instead of a second active plan.
	first, replaced, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, token, nil)
	if err != nil || first == nil || replaced != nil {
		t.Fatalf("first apply: first=%+v replaced=%+v err=%v", first, replaced, err)
	}
	if first.ApplyToken == nil || *first.ApplyToken != token {
		t.Fatalf("apply_token not persisted: %+v", first.ApplyToken)
	}

	replay, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, token, &MasterPlanReplacement{PlanID: first.PlanID, Revision: *first.Revision})
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if replay == nil || replay.PlanID != first.PlanID {
		t.Fatalf("replay = %+v, want the already-applied row %s", replay, first.PlanID)
	}

	// Once the token's row is superseded (e.g. an admin applied a newer plan),
	// replaying the stale token must NOT resurface the dead plan: it falls
	// through to the normal apply logic and replaces the current active.
	fresh := `{"goal":{"goal_id":"` + goalID + `","target_time":"3:20:00"},"phases":[],"milestones":[],"weeks":[]}`
	current, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, fresh, "", &MasterPlanReplacement{PlanID: first.PlanID, Revision: *first.Revision})
	if err != nil {
		t.Fatalf("admin replace: %v", err)
	}
	stale, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, token, &MasterPlanReplacement{PlanID: current.PlanID, Revision: *current.Revision})
	if err != nil {
		t.Fatalf("stale token replay: %v", err)
	}
	if stale == nil || stale.PlanID == first.PlanID {
		t.Fatalf("stale token replay = %+v, want a fresh apply, not the superseded row", stale)
	}

	var rows []MasterPlan
	if err := st.db.WithContext(ctx).Where("user_id = ?", userID).Order("created_at").Find(&rows).Error; err != nil {
		t.Fatalf("list rows: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("rows=%d (%+v), want first+admin+stale-replay", len(rows), rows)
	}
	if rows[2].Status != MasterPlanStatusActive || rows[1].Status != MasterPlanStatusSuperseded || rows[0].Status != MasterPlanStatusSuperseded {
		t.Fatalf("statuses=%s/%s/%s, want superseded/superseded/active", rows[0].Status, rows[1].Status, rows[2].Status)
	}

	if _, _, err := st.ApplyStructuredMasterPlan(ctx, userID, goalID, content, "not-a-uuid", nil); err == nil {
		t.Fatal("non-UUID apply token must fail")
	}
}

func TestAutoMigrateMasterPlanConvergesLegacyRows(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	// Recreate the pre-#585 table shape (draft/archived vocabulary, no
	// apply_token, old current-marker constraint) and legacy rows, then let
	// AutoMigrateMasterPlan converge it: drafts deleted, archived superseded,
	// the active/superseded-only CHECK back in place.
	if err := st.db.WithContext(ctx).Exec(`DROP TABLE IF EXISTS master_plan`).Error; err != nil {
		t.Fatalf("drop table: %v", err)
	}
	t.Cleanup(func() {
		_ = st.db.WithContext(context.Background()).Exec(`DROP TABLE IF EXISTS master_plan`).Error
	})
	legacy := `CREATE TABLE master_plan (
		plan_id varchar(36) PRIMARY KEY,
		user_id varchar(64) NOT NULL,
		content_version tinyint NOT NULL,
		content longtext NOT NULL,
		goal_id varchar(36) NOT NULL,
		status varchar(16) NOT NULL,
		active_flag tinyint NULL,
		revision bigint NULL,
		created_at datetime(3) NULL,
		updated_at datetime(3) NULL,
		UNIQUE KEY uidx_master_plan_active (user_id, active_flag),
		CONSTRAINT ck_master_plan_current_marker CHECK ((status = 'active' AND active_flag = 1) OR (status <> 'active' AND active_flag IS NULL))
	)`
	if err := st.db.WithContext(ctx).Exec(legacy).Error; err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	userID := uuid.NewString()
	rows := []struct {
		id, status string
		flag       *int8
	}{
		{uuid.NewString(), "active", ptrInt8(1)},
		{uuid.NewString(), "draft", nil},
		{uuid.NewString(), "draft", nil},
		{uuid.NewString(), "archived", nil},
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	for _, row := range rows {
		if err := st.db.WithContext(ctx).Exec(
			`INSERT INTO master_plan (plan_id, user_id, content_version, content, goal_id, status, active_flag, revision, created_at, updated_at)
			 VALUES (?, ?, 2, '{}', ?, ?, ?, 1, ?, ?)`,
			row.id, userID, uuid.NewString(), row.status, row.flag, now, now,
		).Error; err != nil {
			t.Fatalf("seed legacy row (%s): %v", row.status, err)
		}
	}

	if err := st.AutoMigrateMasterPlan(ctx); err != nil {
		t.Fatalf("converging automigrate: %v", err)
	}

	var statuses []string
	if err := st.db.WithContext(ctx).Raw("SELECT status FROM master_plan WHERE user_id = ? ORDER BY status", userID).Scan(&statuses).Error; err != nil {
		t.Fatalf("read statuses: %v", err)
	}
	if len(statuses) != 2 || statuses[0] != MasterPlanStatusActive || statuses[1] != MasterPlanStatusSuperseded {
		t.Fatalf("statuses=%v, want [active superseded] (draft rows deleted, archived renamed)", statuses)
	}
}
