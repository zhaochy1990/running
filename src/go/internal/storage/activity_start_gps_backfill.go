package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// ActivityStartGPSBackfillOptions controls the one-off activity start cache
// backfill. Limit is a total activity cap for validation runs; zero is unlimited.
type ActivityStartGPSBackfillOptions struct {
	UserIDs   []string
	Commit    bool
	Limit     int
	BatchSize int
	Delay     time.Duration
}

// Validate rejects unsafe backfill settings before any database query runs.
func (o ActivityStartGPSBackfillOptions) Validate() error {
	if len(o.UserIDs) == 0 {
		return errors.New("activity start GPS backfill requires at least one user")
	}
	for _, userID := range o.UserIDs {
		if _, err := canonicalUserID(userID); err != nil {
			return err
		}
	}
	if o.BatchSize < 1 || o.BatchSize > 500 {
		return errors.New("activity start GPS backfill batch size must be from 1 to 500")
	}
	if o.Delay < 0 {
		return errors.New("activity start GPS backfill delay must be non-negative")
	}
	if o.Limit < 0 {
		return errors.New("activity start GPS backfill limit must be non-negative")
	}
	return nil
}

// ActivityStartGPSBackfillReport contains counts only; it deliberately omits
// user IDs, activity IDs, coordinates, and database configuration.
type ActivityStartGPSBackfillReport struct {
	Mode              string `json:"mode"`
	Users             int    `json:"users"`
	Total             int64  `json:"total"`
	AlreadyCached     int64  `json:"already_cached"`
	Missing           int64  `json:"missing"`
	Scanned           int    `json:"scanned"`
	Fillable          int    `json:"fillable"`
	Updated           int    `json:"updated"`
	Verified          int    `json:"verified"`
	NoValidGPS        int    `json:"no_valid_gps"`
	SkippedConcurrent int    `json:"skipped_concurrent"`
	Failed            int64  `json:"failed"`
}

type activityStartGPSCounts struct {
	Total   int64
	Cached  int64
	Missing int64
	Partial int64
}

type activityStartGPSPoint struct {
	GPSLat float64
	GPSLon float64
}

// BackfillActivityStartGPS fills activities.start_gps_* from the first complete,
// valid timeseries coordinate. Activities are keyset-paged; each selected row
// performs one lookup constrained by the (user_id, label_id) index.
func (s *Store) BackfillActivityStartGPS(ctx context.Context, options ActivityStartGPSBackfillOptions) (ActivityStartGPSBackfillReport, error) {
	if err := options.Validate(); err != nil {
		return ActivityStartGPSBackfillReport{}, err
	}
	report := ActivityStartGPSBackfillReport{Mode: "dry-run"}
	if options.Commit {
		report.Mode = "commit"
	}

	for _, userID := range options.UserIDs {
		uid, _ := canonicalUserID(userID) // Validate already checked every ID.
		report.Users++
		counts, err := s.countActivityStartGPS(ctx, uid)
		if err != nil {
			return report, fmt.Errorf("storage: count activity start GPS rows: %w", err)
		}
		report.Total += counts.Total
		report.AlreadyCached += counts.Cached
		report.Missing += counts.Missing
		report.Failed += counts.Partial

		cursor := ""
		for options.Limit == 0 || report.Scanned < options.Limit {
			pageSize := options.BatchSize
			if options.Limit > 0 && pageSize > options.Limit-report.Scanned {
				pageSize = options.Limit - report.Scanned
			}
			labels, err := s.missingActivityStartGPSLabels(ctx, uid, cursor, pageSize)
			if err != nil {
				return report, fmt.Errorf("storage: page activity start GPS rows: %w", err)
			}
			if len(labels) == 0 {
				break
			}
			for _, labelID := range labels {
				cursor = labelID
				report.Scanned++
				if err := s.backfillOneActivityStartGPS(ctx, uid, labelID, options.Commit, &report); err != nil {
					report.Failed++
				}
				if options.Delay > 0 {
					select {
					case <-ctx.Done():
						return report, ctx.Err()
					case <-time.After(options.Delay):
					}
				}
			}
		}
	}
	return report, nil
}

func (s *Store) countActivityStartGPS(ctx context.Context, userID string) (activityStartGPSCounts, error) {
	var counts activityStartGPSCounts
	err := s.db.WithContext(ctx).Model(&Activity{}).
		Select(`COUNT(*) AS total,
COALESCE(SUM(start_gps_lat IS NOT NULL AND start_gps_lon IS NOT NULL), 0) AS cached,
COALESCE(SUM(start_gps_lat IS NULL AND start_gps_lon IS NULL), 0) AS missing,
COALESCE(SUM((start_gps_lat IS NULL) <> (start_gps_lon IS NULL)), 0) AS partial`).
		Where("user_id = ?", userID).Scan(&counts).Error
	return counts, err
}

func (s *Store) missingActivityStartGPSLabels(ctx context.Context, userID, cursor string, limit int) ([]string, error) {
	var labels []string
	err := s.db.WithContext(ctx).Model(&Activity{}).Select("label_id").
		Where("user_id = ? AND label_id > ?", userID, cursor).
		Where("start_gps_lat IS NULL AND start_gps_lon IS NULL").
		Order("label_id").Limit(limit).Find(&labels).Error
	return labels, err
}

func (s *Store) backfillOneActivityStartGPS(ctx context.Context, userID, labelID string, commit bool, report *ActivityStartGPSBackfillReport) error {
	var point activityStartGPSPoint
	err := s.db.WithContext(ctx).Table("timeseries FORCE INDEX (idx_timeseries_user_label)").
		Select("gps_lat, gps_lon").
		Where("user_id = ? AND label_id = ?", userID, labelID).
		Where("gps_lat IS NOT NULL AND gps_lon IS NOT NULL").
		Where("gps_lat BETWEEN -90 AND 90 AND gps_lon BETWEEN -180 AND 180").
		Where("NOT (gps_lat = 0 AND gps_lon = 0)").
		Order("id").Take(&point).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		report.NoValidGPS++
		return nil
	}
	if err != nil {
		return err
	}
	report.Fillable++
	if !commit {
		return nil
	}

	result := s.db.WithContext(ctx).Model(&Activity{}).
		Where("user_id = ? AND label_id = ?", userID, labelID).
		Where("start_gps_lat IS NULL AND start_gps_lon IS NULL").
		Updates(map[string]any{"start_gps_lat": point.GPSLat, "start_gps_lon": point.GPSLon})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		report.SkippedConcurrent++
		return nil
	}
	report.Updated++

	var stored Activity
	if err := s.db.WithContext(ctx).Select("start_gps_lat, start_gps_lon").
		Where("user_id = ? AND label_id = ?", userID, labelID).Take(&stored).Error; err != nil {
		return err
	}
	if stored.StartGPSLat == nil || stored.StartGPSLon == nil ||
		*stored.StartGPSLat != point.GPSLat || *stored.StartGPSLon != point.GPSLon {
		return errors.New("activity start GPS readback mismatch")
	}
	report.Verified++
	return nil
}
