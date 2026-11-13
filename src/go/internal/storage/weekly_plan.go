package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// ErrWeeklyPlanExists is returned when a caller attempts to apply a plan
// without explicitly allowing replacement of the active plan for that week.
var ErrWeeklyPlanExists = errors.New("storage: active weekly plan already exists")

// ErrWeeklyPlanConflict means the active plan changed after an administrator
// confirmed a specific plan revision for replacement.
var ErrWeeklyPlanConflict = errors.New("storage: active weekly plan changed")

// ErrWeeklyPlanMasterPlanConflict means the active week row belongs to a
// different master plan than the one the caller pinned: replacing it is a plan
// change, which the master apply/update path owns.
var ErrWeeklyPlanMasterPlanConflict = errors.New("storage: active weekly plan belongs to another master plan")

// ErrWeeklyPlanInvalidBatch reports a malformed batch (bad or duplicate
// week_start) rejected before any row is locked or written.
var ErrWeeklyPlanInvalidBatch = errors.New("storage: invalid weekly plan batch")

// WeeklyPlanReplacement is the active row revision an administrator reviewed
// and explicitly confirmed replacing.
type WeeklyPlanReplacement struct {
	PlanID   string
	Revision int64
}

// WeeklyPlanApplyOptions tunes ApplyStructuredWeeklyPlan for the internal
// rolling batch channel (#858). The zero value keeps the admin apply path's
// behaviour: link the row to the user's current master plan (nil when none)
// and restart the new row's revision at 1.
type WeeklyPlanApplyOptions struct {
	// MasterPlanID, when set, overrides the link derived from the user's
	// current master plan. The internal caller (the rolling worker) already
	// validated the plan it generated against, so the link is exact.
	MasterPlanID *string
	// ContinueRevision makes the replacement row continue the replaced row's
	// revision (old+1) instead of restarting at 1 — rolling re-deliveries then
	// surface as a monotonically increasing revision per week.
	ContinueRevision bool
}

func (s *Store) AutoMigrateWeeklyPlan(ctx context.Context) error {
	db := s.db.WithContext(ctx)
	// #585 convergence on an existing table: the draft intermediate state is
	// gone, so the table collapses to one applied row per (user_id, week_start).
	// GORM AutoMigrate won't rewrite existing CHECK constraints or drop the old
	// unique index, so drop them first, converge the rows (drafts deleted;
	// per week only the newest snapshot survives and becomes the applied row),
	// then let AutoMigrate add the active-only checks and UNIQUE(user_id,
	// week_start).
	m := db.Migrator()
	if m.HasTable(&WeeklyPlan{}) {
		for _, constraint := range []string{"ck_weekly_plan_status", "ck_weekly_plan_status_slot", "ck_weekly_plan_status_slot_v2"} {
			if m.HasConstraint(&WeeklyPlan{}, constraint) {
				if err := m.DropConstraint(&WeeklyPlan{}, constraint); err != nil {
					return fmt.Errorf("storage: drop old weekly_plan constraint %s: %w", constraint, err)
				}
			}
		}
		if m.HasIndex(&WeeklyPlan{}, "uidx_weekly_plan_status_slot") {
			if err := m.DropIndex(&WeeklyPlan{}, "uidx_weekly_plan_status_slot"); err != nil {
				return fmt.Errorf("storage: drop old weekly_plan status-slot index: %w", err)
			}
		}
		if err := db.Exec("DELETE FROM weekly_plan WHERE status = ?", "draft").Error; err != nil {
			return fmt.Errorf("storage: delete legacy weekly plan drafts: %w", err)
		}
		// Keep only the newest snapshot per (user_id, week_start); older
		// active/archived duplicates have no meaning once existence = applied.
		if err := db.Exec(`DELETE t1 FROM weekly_plan t1 JOIN weekly_plan t2
			ON t1.user_id = t2.user_id AND t1.week_start = t2.week_start
			AND (t1.created_at < t2.created_at OR (t1.created_at = t2.created_at AND t1.plan_id < t2.plan_id))`).Error; err != nil {
			return fmt.Errorf("storage: converge weekly plan duplicates: %w", err)
		}
		if err := db.Exec("UPDATE weekly_plan SET status = ?, status_slot = ?", WeeklyPlanStatusActive, WeeklyPlanStatusActive).Error; err != nil {
			return fmt.Errorf("storage: normalize weekly plan rows to active: %w", err)
		}
	}
	if err := db.AutoMigrate(&WeeklyPlan{}); err != nil {
		return fmt.Errorf("storage: automigrate weekly_plan: %w", err)
	}
	return nil
}

// ListActiveWeeklyPlans returns all current weekly plans newest first. Content
// is loaded because the same row type backs the detail reader and the
// master-plan read merge (#858), but the API list DTO deliberately omits it.
func (s *Store) ListActiveWeeklyPlans(ctx context.Context, userID string) ([]WeeklyPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var plans []WeeklyPlan
	if err := s.db.WithContext(ctx).
		Select("plan_id", "user_id", "master_plan_id", "week_start", "content_version", "content", "status", "revision", "created_at", "updated_at").
		Where("user_id = ? AND status = ?", uid, WeeklyPlanStatusActive).
		Order("week_start DESC").
		Find(&plans).Error; err != nil {
		return nil, err
	}
	return plans, nil
}

// DeleteStaleFutureWeeklyPlans removes the user's weekly rows of the CURRENT
// AND FUTURE Shanghai weeks that are NOT linked to keepMasterPlanID (#858 换计划
// 清理). Earlier weeks are finished training history and stay untouched no
// matter which plan they belong to (including legacy rows with a NULL
// master_plan_id).
//
// The delete is physical, not a status flip: weekly_plan converged to a single
// 'active' status with UNIQUE(user_id, week_start) (#585), so a stale future
// row from the replaced plan would block the new plan's rolling batch from
// writing that week. The week boundary is the Monday of the Shanghai natural
// week containing now (UTC+8, not UTC and not the server's local zone).
// Returns the number of rows removed.
func (s *Store) DeleteStaleFutureWeeklyPlans(
	ctx context.Context, userID, keepMasterPlanID string, now time.Time,
) (int64, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return 0, err
	}
	if _, err := uuid.Parse(keepMasterPlanID); err != nil {
		return 0, fmt.Errorf("storage: invalid keep master plan id: %w", err)
	}
	cutoff := timefmt.ShanghaiWeekStart(now).Format("2006-01-02")
	result := s.db.WithContext(ctx).
		Where("user_id = ? AND week_start >= ? AND (master_plan_id IS NULL OR master_plan_id <> ?)",
			uid, cutoff, keepMasterPlanID).
		Delete(&WeeklyPlan{})
	if result.Error != nil {
		return 0, fmt.Errorf("storage: delete stale future weekly plans except %s: %w", keepMasterPlanID, result.Error)
	}
	return result.RowsAffected, nil
}

// WeekSummary is the active-plan metadata and activity rollup needed by the
// legacy /api/{user}/weeks response. Activity dates are grouped by Shanghai day.
type WeekSummary struct {
	PlanID            string
	MasterPlanID      *string
	WeekStart         string
	ContentVersion    int8
	Content           string
	FeedbackRowExists bool
	HasFeedback       bool
	ActivityCount     int
	TotalKM           float64
	TotalDurationS    float64
}

// ListWeekActivities returns one user's activities in a Shanghai calendar week,
// ordered chronologically for the week-detail timeline.
func (s *Store) ListWeekActivities(ctx context.Context, userID, dateFrom, dateTo string) ([]Activity, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := time.Parse("2006-01-02", dateFrom); err != nil {
		return nil, fmt.Errorf("storage: invalid date_from: %w", err)
	}
	if _, err := time.Parse("2006-01-02", dateTo); err != nil {
		return nil, fmt.Errorf("storage: invalid date_to: %w", err)
	}
	var activities []Activity
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND DATE(date + INTERVAL 8 HOUR) BETWEEN ? AND ?", uid, dateFrom, dateTo).
		Order("date ASC, label_id ASC").
		Find(&activities).Error; err != nil {
		return nil, err
	}
	return activities, nil
}

// ListWeekSummaries returns the newest-first union of active-plan, activity,
// and feedback weeks. A master-plan filter intentionally narrows discovery to
// active plans linked to that plan because activities and feedback have no
// master-plan ownership of their own.
func (s *Store) ListWeekSummaries(ctx context.Context, userID, masterPlanID string) ([]WeekSummary, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var weekSources *gorm.DB
	if masterPlanID != "" {
		weekSources = s.db.WithContext(ctx).Raw(`
			SELECT week_start FROM weekly_plan
			WHERE user_id = ? AND status = ? AND master_plan_id = ?`, uid, WeeklyPlanStatusActive, masterPlanID)
	} else {
		weekSources = s.db.WithContext(ctx).Raw(`
			SELECT week_start FROM weekly_plan WHERE user_id = ? AND status = ?
			UNION
			SELECT DATE_SUB(DATE(date + INTERVAL 8 HOUR), INTERVAL WEEKDAY(DATE(date + INTERVAL 8 HOUR)) DAY)
			FROM activities WHERE user_id = ?
			UNION
			SELECT week_start FROM weekly_feedback WHERE user_id = ?`, uid, WeeklyPlanStatusActive, uid, uid)
	}

	query := s.db.WithContext(ctx).
		Table("(?) AS weeks", weekSources).
		Select(`COALESCE(wp.plan_id, '') AS plan_id, wp.master_plan_id,
			DATE_FORMAT(weeks.week_start, '%Y-%m-%d') AS week_start,
			COALESCE(wp.content_version, 0) AS content_version, COALESCE(wp.content, '') AS content,
			wf.user_id IS NOT NULL AS feedback_row_exists,
			COALESCE(wf.content_md <> '', FALSE) AS has_feedback,
			COUNT(a.label_id) AS activity_count,
			ROUND(COALESCE(SUM(a.distance_m), 0) / 1000.0, 1) AS total_km,
			ROUND(COALESCE(SUM(a.duration_s), 0), 0) AS total_duration_s`).
		Joins(`LEFT JOIN weekly_plan AS wp ON wp.user_id = ? AND wp.week_start = weeks.week_start AND wp.status = ?`, uid, WeeklyPlanStatusActive).
		Joins(`LEFT JOIN weekly_feedback AS wf ON wf.user_id = ? AND wf.week_start = weeks.week_start`, uid).
		Joins(`LEFT JOIN activities AS a ON a.user_id = ? AND DATE(a.date + INTERVAL 8 HOUR)
			BETWEEN weeks.week_start AND DATE_ADD(weeks.week_start, INTERVAL 6 DAY)`, uid)
	var weeks []WeekSummary
	if err := query.
		Group("weeks.week_start, wp.plan_id, wp.master_plan_id, wp.content_version, wp.content, wf.user_id, wf.content_md").
		Order("weeks.week_start DESC").
		Scan(&weeks).Error; err != nil {
		return nil, err
	}
	return weeks, nil
}

// GetActiveWeeklyPlan returns the active plan for one Shanghai week, or nil
// when the week has only draft/archived rows or no row at all.
func (s *Store) GetActiveWeeklyPlan(ctx context.Context, userID, weekStart string) (*WeeklyPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := time.Parse("2006-01-02", weekStart); err != nil {
		return nil, fmt.Errorf("storage: invalid week_start: %w", err)
	}
	var plan WeeklyPlan
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND week_start = ? AND status = ?", uid, weekStart, WeeklyPlanStatusActive).
		First(&plan).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &plan, nil
}

// WeeklyPlanBatchItem is one week's validated document plus the active row
// revision the caller reviewed for replacement (nil = the week must be empty).
type WeeklyPlanBatchItem struct {
	WeekStart   string
	Content     string
	Replacement *WeeklyPlanReplacement
	// ProtectThrough preserves already completed workouts during a season switch.
	ProtectThrough string
}

// WeeklyPlanBatchResult reports the active row created for one applied week.
type WeeklyPlanBatchResult struct {
	WeekStart string
	PlanID    string
	Revision  int64
	Replaced  bool
}

// preparedWeeklyPlanBatch orders the batch by week_start so concurrent batches
// acquire the same row locks in the same order (deadlock avoidance) while the
// results stay in the caller's order.
type preparedWeeklyPlanBatch struct {
	index int
	item  WeeklyPlanBatchItem
}

// prepareWeeklyPlanBatch validates and orders the batch by week_start so
// concurrent batches acquire the same row locks in the same order (deadlock
// avoidance) while the results stay in the caller's order. An empty batch is
// allowed: the adjustment accept may legitimately keep every active week
// (#952) and still close the proposal.
func prepareWeeklyPlanBatch(items []WeeklyPlanBatchItem) ([]preparedWeeklyPlanBatch, error) {
	prepared := make([]preparedWeeklyPlanBatch, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for index, item := range items {
		start, err := time.Parse("2006-01-02", item.WeekStart)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid week_start %q", ErrWeeklyPlanInvalidBatch, item.WeekStart)
		}
		if start.Weekday() != time.Monday {
			return nil, fmt.Errorf("%w: week_start must be a Monday", ErrWeeklyPlanInvalidBatch)
		}
		if _, duplicate := seen[item.WeekStart]; duplicate {
			return nil, fmt.Errorf("%w: duplicate week_start %s", ErrWeeklyPlanInvalidBatch, item.WeekStart)
		}
		seen[item.WeekStart] = struct{}{}
		prepared = append(prepared, preparedWeeklyPlanBatch{index: index, item: item})
	}
	sort.Slice(prepared, func(i, j int) bool {
		return prepared[i].item.WeekStart < prepared[j].item.WeekStart
	})
	return prepared, nil
}

func batchResultOf(created, replaced *WeeklyPlan) WeeklyPlanBatchResult {
	return WeeklyPlanBatchResult{
		WeekStart: created.WeekStart, PlanID: created.PlanID,
		Revision: created.Revision, Replaced: replaced != nil,
	}
}

// ApplyStructuredWeeklyPlan inserts a new active structured plan for one
// Shanghai week. Replacing an active row requires its exact plan ID and revision;
// that row is archived in the same transaction before the new active row is
// inserted. All rows for the user/week are locked so the active transition is
// serialized. The new plan has its own identity and therefore starts at revision 1
// (WeeklyPlanApplyOptions.ContinueRevision opts into old+1 for the rolling batch
// channel; MasterPlanID overrides the current-master-plan link).
func (s *Store) ApplyStructuredWeeklyPlan(
	ctx context.Context, userID, weekStart, content string, replacement *WeeklyPlanReplacement, opts ...WeeklyPlanApplyOptions,
) (*WeeklyPlan, *WeeklyPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, nil, err
	}
	start, err := time.Parse("2006-01-02", weekStart)
	if err != nil {
		return nil, nil, fmt.Errorf("storage: invalid week_start: %w", err)
	}
	if start.Weekday() != time.Monday {
		return nil, nil, fmt.Errorf("storage: week_start must be a Monday")
	}
	var options WeeklyPlanApplyOptions
	if len(opts) > 0 {
		options = opts[0]
	}
	// Only an explicitly pinned master plan enforces week ownership; the admin
	// path derives the current plan purely to link the new row (legacy rows with
	// no/old link stay replaceable by an administrator with the exact revision).
	pinned := options.MasterPlanID != nil

	var created *WeeklyPlan
	var replaced *WeeklyPlan
	apply := func() error {
		created = nil
		replaced = nil
		// Link the new weekly plan to the athlete's active master plan. When the
		// user has no active master plan the link stays nil by design. The
		// rolling batch channel passes the exact plan id it generated against.
		var masterPlanID *string
		if options.MasterPlanID != nil {
			id := *options.MasterPlanID
			masterPlanID = &id
		} else {
			masterPlan, err := s.GetCurrentMasterPlan(ctx, uid)
			if err != nil {
				return fmt.Errorf("storage: resolve active master plan: %w", err)
			}
			if masterPlan != nil {
				id := masterPlan.PlanID
				masterPlanID = &id
			}
		}
		return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var err error
			created, replaced, err = applyWeeklyPlanTx(
				tx, uid, weekStart, content, replacement, masterPlanID, options.ContinueRevision, pinned,
			)
			return err
		})
	}
	err = apply()
	// Two first-time applies can both lock the empty key range before either
	// inserts. InnoDB resolves that insert race by deadlocking one transaction.
	// Retry it once so the loser observes the winner's active row and returns the
	// stable domain conflict instead of leaking a transient 500 to the caller.
	if isDeadlock(err) {
		err = apply()
	}
	if err != nil {
		return nil, nil, err
	}
	return created, replaced, nil
}

// ApplyStructuredWeeklyPlansBatch applies every week in one transaction: all
// replacement expectations and cross-plan ownership checks run against the
// locked rows, and each week's workout rows materialize in the same
// transaction, so any failure (content race, revision mismatch, materialization
// error) rolls the whole batch back. The caller validates the documents before
// calling; this method owns every write. The batch is the rolling channel, so
// every replacement continues the replaced row's revision and the new rows are
// pinned to masterPlanID.
//
// A week owned by another master plan is rejected with
// ErrWeeklyPlanMasterPlanConflict, and a week whose active revision moved is
// rejected with ErrWeeklyPlanConflict — in both cases nothing is written.
func (s *Store) ApplyStructuredWeeklyPlansBatch(
	ctx context.Context, userID string, items []WeeklyPlanBatchItem, masterPlanID string,
) ([]WeeklyPlanBatchResult, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(masterPlanID); err != nil {
		return nil, fmt.Errorf("storage: invalid master plan id: %w", err)
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("storage: weekly plan batch requires at least one week")
	}
	prepared, err := prepareWeeklyPlanBatch(items)
	if err != nil {
		return nil, err
	}
	link := masterPlanID
	results := make([]WeeklyPlanBatchResult, len(items))
	apply := func() error {
		clear(results)
		return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			// Serialize rolling writes with season switches and reject workers
			// that computed their batch against a now-superseded season.
			var masters []MasterPlan
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("user_id = ?", uid).Order("revision DESC, created_at DESC").Find(&masters).Error; err != nil {
				return fmt.Errorf("storage: lock active master plan: %w", err)
			}
			matched := false
			for _, master := range masters {
				if master.Status != MasterPlanStatusActive || master.ActiveFlag == nil || *master.ActiveFlag != 1 {
					continue
				}
				var embedded struct {
					MasterPlanID string `json:"master_plan_id"`
				}
				_ = json.Unmarshal([]byte(master.Content), &embedded)
				matched = master.PlanID == masterPlanID || embedded.MasterPlanID == masterPlanID
			}
			if !matched {
				return ErrMasterPlanConflict
			}
			for _, week := range prepared {
				created, replaced, err := applyWeeklyPlanTx(
					tx, uid, week.item.WeekStart, week.item.Content, week.item.Replacement,
					&link, true, true,
				)
				if err != nil {
					return err
				}
				results[week.index] = batchResultOf(created, replaced)
			}
			return nil
		})
	}
	err = apply()
	if isDeadlock(err) {
		err = apply()
	}
	if err != nil {
		return nil, err
	}
	return results, nil
}

// applyWeeklyPlanTx is the single-week apply step shared by the admin path, the
// rolling batch and the adjustment accept. It must run inside a transaction:
// the week's rows are locked, the replacement expectation is checked against
// the active row (and, when enforceMasterPlan is set, so is the plan link), the
// old row is deleted, the new row inserted, and its workouts materialized.
func applyWeeklyPlanTx(
	tx *gorm.DB, uid, weekStart, content string, replacement *WeeklyPlanReplacement,
	masterPlanID *string, continueRevision, enforceMasterPlan bool, protectThrough ...string,
) (*WeeklyPlan, *WeeklyPlan, error) {
	var rows []WeeklyPlan
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("user_id = ? AND week_start = ?", uid, weekStart).
		Order("revision DESC, created_at DESC").
		Find(&rows).Error; err != nil {
		return nil, nil, fmt.Errorf("storage: lock weekly plans: %w", err)
	}

	var replaced *WeeklyPlan
	for i := range rows {
		if rows[i].Status == WeeklyPlanStatusActive {
			replaced = &rows[i]
		}
	}
	if replaced == nil {
		if replacement != nil {
			return nil, nil, ErrWeeklyPlanConflict
		}
	} else if replacement == nil {
		return nil, nil, ErrWeeklyPlanExists
	} else if replaced.PlanID != replacement.PlanID || replaced.Revision != replacement.Revision {
		return nil, nil, ErrWeeklyPlanConflict
	}
	// A pinned master plan must own the week it replaces: changing plans goes
	// through the master apply/update path, never through a week replacement.
	if replaced != nil && enforceMasterPlan {
		if replaced.MasterPlanID == nil || *replaced.MasterPlanID != *masterPlanID {
			return nil, nil, ErrWeeklyPlanMasterPlanConflict
		}
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	// #585 convergence: same-week apply overwrites — the old row is deleted
	// (existence = applied, no snapshot history) and the new row inserted.
	if replaced != nil {
		result := tx.Where("user_id = ? AND week_start = ?", uid, weekStart).Delete(&WeeklyPlan{})
		if result.Error != nil {
			return nil, nil, fmt.Errorf("storage: delete prior weekly plan: %w", result.Error)
		}
		if result.RowsAffected < 1 {
			return nil, nil, ErrWeeklyPlanConflict
		}
	}

	activeSlot := WeeklyPlanStatusActive
	revision := int64(1)
	if continueRevision && replaced != nil {
		revision = replaced.Revision + 1
	}
	row := &WeeklyPlan{
		PlanID: uuid.NewString(), UserID: uid, WeekStart: weekStart,
		MasterPlanID:   masterPlanID,
		ContentVersion: WeeklyPlanContentStructured, Content: content,
		Status: WeeklyPlanStatusActive, StatusSlot: &activeSlot,
		Revision: revision, CreatedAt: now, UpdatedAt: now,
	}
	if err := tx.Create(row).Error; err != nil {
		if isDuplicateKey(err) {
			return nil, nil, ErrWeeklyPlanExists
		}
		return nil, nil, fmt.Errorf("storage: create weekly plan: %w", err)
	}
	// devops#586 materialization: one workout row per session, in the same
	// transaction so plan + workouts commit (or roll back) atomically.
	cutoff := ""
	if len(protectThrough) > 0 {
		cutoff = protectThrough[0]
	}
	if err := materializeWeeklyWorkoutsAfter(tx, uid, row.PlanID, weekStart, content, cutoff); err != nil {
		return nil, nil, err
	}
	return row, replaced, nil
}
