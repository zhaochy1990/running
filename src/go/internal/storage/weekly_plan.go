package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrWeeklyPlanExists is returned when a caller attempts to apply a plan
// without explicitly allowing replacement of the active plan for that week.
var ErrWeeklyPlanExists = errors.New("storage: active weekly plan already exists")

// ErrWeeklyPlanConflict means the active plan changed after an administrator
// confirmed a specific plan revision for replacement.
var ErrWeeklyPlanConflict = errors.New("storage: active weekly plan changed")

// WeeklyPlanReplacement is the active row revision an administrator reviewed
// and explicitly confirmed replacing.
type WeeklyPlanReplacement struct {
	PlanID   string
	Revision int64
}

func (s *Store) AutoMigrateWeeklyPlan(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&WeeklyPlan{}); err != nil {
		return fmt.Errorf("storage: automigrate weekly_plan: %w", err)
	}
	return nil
}

// ListActiveWeeklyPlans returns all current weekly plans newest first. Content
// is loaded because the same row type backs the detail reader, but the API list
// DTO deliberately omits it.
func (s *Store) ListActiveWeeklyPlans(ctx context.Context, userID string) ([]WeeklyPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var plans []WeeklyPlan
	if err := s.db.WithContext(ctx).
		Select("plan_id", "user_id", "master_plan_id", "week_start", "content_version", "status", "revision", "created_at", "updated_at").
		Where("user_id = ? AND status = ?", uid, WeeklyPlanStatusActive).
		Order("week_start DESC").
		Find(&plans).Error; err != nil {
		return nil, err
	}
	return plans, nil
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

// ApplyStructuredWeeklyPlan inserts a new active structured plan for one
// Shanghai week. Replacing an active row requires its exact plan ID and revision;
// that row is archived in the same transaction before the new active row is
// inserted. All rows for the user/week are locked so the active transition is
// serialized. The new plan has its own identity and therefore starts at revision 1.
func (s *Store) ApplyStructuredWeeklyPlan(
	ctx context.Context, userID, weekStart, content string, replacement *WeeklyPlanReplacement,
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

	var created *WeeklyPlan
	var replaced *WeeklyPlan
	apply := func() error {
		created = nil
		replaced = nil
		return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var rows []WeeklyPlan
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("user_id = ? AND week_start = ?", uid, weekStart).
				Order("revision DESC, created_at DESC").
				Find(&rows).Error; err != nil {
				return fmt.Errorf("storage: lock weekly plans: %w", err)
			}

			for i := range rows {
				if rows[i].Status == WeeklyPlanStatusActive {
					replaced = &rows[i]
				}
			}
			if replaced == nil {
				if replacement != nil {
					return ErrWeeklyPlanConflict
				}
			} else if replacement == nil {
				return ErrWeeklyPlanExists
			} else if replaced.PlanID != replacement.PlanID || replaced.Revision != replacement.Revision {
				return ErrWeeklyPlanConflict
			}

			now := time.Now().UTC().Truncate(time.Millisecond)
			if replaced != nil {
				result := tx.Model(&WeeklyPlan{}).
					Where("plan_id = ? AND user_id = ? AND status = ? AND revision = ?", replaced.PlanID, uid, WeeklyPlanStatusActive, replaced.Revision).
					Updates(map[string]any{
						"status":      WeeklyPlanStatusArchived,
						"status_slot": nil,
						"revision":    replaced.Revision + 1,
						"updated_at":  now,
					})
				if result.Error != nil {
					return fmt.Errorf("storage: archive prior weekly plan: %w", result.Error)
				}
				if result.RowsAffected != 1 {
					return ErrWeeklyPlanConflict
				}
				replaced.Status = WeeklyPlanStatusArchived
				replaced.StatusSlot = nil
				replaced.Revision++
				replaced.UpdatedAt = now
			}

			activeSlot := WeeklyPlanStatusActive
			row := &WeeklyPlan{
				PlanID: uuid.NewString(), UserID: uid, WeekStart: weekStart,
				ContentVersion: WeeklyPlanContentStructured, Content: content,
				Status: WeeklyPlanStatusActive, StatusSlot: &activeSlot,
				Revision: 1, CreatedAt: now, UpdatedAt: now,
			}
			if err := tx.Create(row).Error; err != nil {
				if isDuplicateKey(err) {
					return ErrWeeklyPlanExists
				}
				return fmt.Errorf("storage: create weekly plan: %w", err)
			}
			created = row
			return nil
		})
	}
	err = apply()
	// Two first-time applies can both lock the empty key range before either
	// inserts. InnoDB resolves that insert race by deadlocking one transaction.
	// Retry it once so the loser observes the winner's active row and returns the
	// stable domain conflict instead of leaking a transient 500 to the caller.
	if number, ok := mysqlErrNo(err); ok && number == 1213 {
		err = apply()
	}
	if err != nil {
		return nil, nil, err
	}
	return created, replaced, nil
}
