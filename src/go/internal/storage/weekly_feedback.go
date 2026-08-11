package storage

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type WeeklyFeedback struct {
	UserID    string    `gorm:"column:user_id;size:64;not null;primaryKey"`
	WeekStart string    `gorm:"column:week_start;type:date;not null;primaryKey"`
	ContentMD string    `gorm:"column:content_md;type:longtext;not null"`
	CreatedAt time.Time `gorm:"column:created_at;type:datetime(3);not null;autoCreateTime:false"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:datetime(3);not null;autoUpdateTime:false"`
}

func (WeeklyFeedback) TableName() string { return "weekly_feedback" }

func (s *Store) AutoMigrateWeeklyFeedback(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&WeeklyFeedback{}); err != nil {
		return fmt.Errorf("storage: automigrate weekly_feedback: %w", err)
	}
	return nil
}

func (s *Store) PutWeeklyFeedback(ctx context.Context, userID, weekStart, content string) (WeeklyFeedback, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return WeeklyFeedback{}, err
	}
	if _, err := time.Parse("2006-01-02", weekStart); err != nil {
		return WeeklyFeedback{}, fmt.Errorf("storage: invalid week_start: %w", err)
	}
	start, _ := time.Parse("2006-01-02", weekStart)
	if start.Weekday() != time.Monday {
		return WeeklyFeedback{}, fmt.Errorf("storage: week_start must be a Monday")
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := WeeklyFeedback{UserID: uid, WeekStart: weekStart, ContentMD: content, CreatedAt: now, UpdatedAt: now}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "user_id"}, {Name: "week_start"}},
			DoUpdates: clause.Assignments(map[string]any{
				"content_md": content,
				"updated_at": gorm.Expr("UTC_TIMESTAMP(3)"),
			}),
		}).Create(&row).Error; err != nil {
			return err
		}
		// The upsert retains the row lock until this transaction commits, so the
		// response always reflects this write rather than a concurrent request.
		return tx.First(&row, "user_id = ? AND week_start = ?", uid, weekStart).Error
	})
	if err != nil {
		return WeeklyFeedback{}, err
	}
	return row, nil
}
