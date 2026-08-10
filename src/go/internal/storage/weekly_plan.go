package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

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
	PlanID         string
	MasterPlanID   *string
	WeekStart      string
	ContentVersion int8
	Content        string
	ActivityCount  int
	TotalKM        float64
	TotalDurationS float64
}

// ListWeekSummaries returns active weekly plans newest first. When masterPlanID
// is non-empty, only plans linked to that master plan are returned.
func (s *Store) ListWeekSummaries(ctx context.Context, userID, masterPlanID string) ([]WeekSummary, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	query := s.db.WithContext(ctx).
		Table("weekly_plan AS wp").
		Select(`wp.plan_id, wp.master_plan_id, DATE_FORMAT(wp.week_start, '%Y-%m-%d') AS week_start,
			wp.content_version, wp.content,
			COUNT(a.label_id) AS activity_count,
			ROUND(COALESCE(SUM(a.distance_m), 0) / 1000.0, 1) AS total_km,
			ROUND(COALESCE(SUM(a.duration_s), 0), 0) AS total_duration_s`).
		Joins(`LEFT JOIN activities AS a ON a.user_id = wp.user_id
			AND DATE(a.date + INTERVAL 8 HOUR) BETWEEN wp.week_start AND DATE_ADD(wp.week_start, INTERVAL 6 DAY)`).
		Where("wp.user_id = ? AND wp.status = ?", uid, WeeklyPlanStatusActive)
	if masterPlanID != "" {
		query = query.Where("wp.master_plan_id = ?", masterPlanID)
	}
	var weeks []WeekSummary
	if err := query.
		Group("wp.plan_id, wp.master_plan_id, wp.week_start, wp.content_version, wp.content").
		Order("wp.week_start DESC").
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
