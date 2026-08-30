// compute_ability_read.go adds the read surface the ability endpoints and the
// ability compute handler need: per-date / windowed ability_snapshot rows, one
// activity's L1+contribution, the per-user dashboard, best-per-race-type
// vo2max_pb, and the latest/trend/model-version reads used by /race-predictions.
// Mirrors the Python ability_snapshot / activity_ability / vo2max_pb readers.
package storage

import (
	"context"
	"errors"

	"gorm.io/gorm"

	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// AbilitySnapshotForDate returns all ability_snapshot rows for one Shanghai day.
func (s *Store) AbilitySnapshotForDate(ctx context.Context, userID, date string) ([]AbilitySnapshot, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []AbilitySnapshot
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND date = ?", uid, date).
		Order("level, dimension").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// AbilitySnapshotWindow returns ability_snapshot rows with date >= (Shanghai today
// − days), ordered oldest first (by date, then level, dimension).
func (s *Store) AbilitySnapshotWindow(ctx context.Context, userID string, days int) ([]AbilitySnapshot, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	cutoff := timefmt.ShanghaiToday().AddDate(0, 0, -days).Format("2006-01-02")
	var rows []AbilitySnapshot
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND date >= ?", uid, cutoff).
		Order("date, level, dimension").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// FetchActivityAbility returns one activity's L1 quality + contribution, or nil.
func (s *Store) FetchActivityAbility(ctx context.Context, userID, labelID string) (*ActivityAbility, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row ActivityAbility
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND label_id = ?", uid, labelID).
		First(&row).Error; err != nil {
		if isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return &row, nil
}

// BestVo2MaxPBs returns the highest-vdot row per race_type (ties → latest
// pb_date), matching Python's window-function dedupe.
func (s *Store) BestVo2MaxPBs(ctx context.Context, userID string) ([]Vo2MaxPB, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []Vo2MaxPB
	q := s.db.WithContext(ctx).Raw(`
		SELECT id, user_id, race_type, distance_m, duration_s, vdot, pb_date, label_id, even_paced, updated_at
		FROM (
			SELECT id, user_id, race_type, distance_m, duration_s, vdot, pb_date, label_id, even_paced, updated_at,
			       ROW_NUMBER() OVER (PARTITION BY race_type ORDER BY vdot DESC, pb_date DESC) AS rn
			FROM vo2max_pb
			WHERE user_id = ?
		) t
		WHERE rn = 1`, uid).Scan(&rows)
	if q.Error != nil {
		return nil, q.Error
	}
	return rows, nil
}

// LatestAbilityVo2Max returns the most recent L3 vo2max row within `days`, or nil.
func (s *Store) LatestAbilityVo2Max(ctx context.Context, userID string, days int) (*AbilitySnapshot, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	cutoff := timefmt.ShanghaiToday().AddDate(0, 0, -days).Format("2006-01-02")
	var rows []AbilitySnapshot
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND level = 'L3' AND dimension = 'vo2max' AND date >= ?", uid, cutoff).
		Order("date DESC").Limit(1).Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// AbilityVo2MaxTrend compares the mean L3 vo2max score over the last 30 days vs
// the prior 30-day window. Returns "up" / "down" / "flat" (±1 point threshold).
func (s *Store) AbilityVo2MaxTrend(ctx context.Context, userID string) (string, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return "", err
	}
	now := timefmt.ShanghaiToday()
	recentStart := now.AddDate(0, 0, -30).Format("2006-01-02")
	priorStart := now.AddDate(0, 0, -60).Format("2006-01-02")
	priorEnd := now.AddDate(0, 0, -30).Format("2006-01-02")

	recent, err := s.scalarAvgVO2Max(ctx, uid, recentStart, "")
	if err != nil {
		return "", err
	}
	prior, err := s.scalarAvgVO2Max(ctx, uid, priorStart, priorEnd)
	if err != nil {
		return "", err
	}
	if recent == nil || prior == nil {
		return "flat", nil
	}
	diff := *recent - *prior
	switch {
	case diff > 1.0:
		return "up", nil
	case diff < -1.0:
		return "down", nil
	default:
		return "flat", nil
	}
}

// ModelVersionForDate returns the meta model_version for a date, or nil.
func (s *Store) ModelVersionForDate(ctx context.Context, userID, date string) (*float64, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []AbilitySnapshot
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND level = 'meta' AND dimension = 'model_version' AND date = ?", uid, date).
		Limit(1).Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 || rows[0].Value == nil {
		return nil, nil
	}
	return rows[0].Value, nil
}

func (s *Store) scalarAvgVO2Max(ctx context.Context, uid, from, to string) (*float64, error) {
	var v *float64
	q := s.db.WithContext(ctx).
		Model(&AbilitySnapshot{}).
		Where("user_id = ? AND level = 'L3' AND dimension = 'vo2max' AND date >= ?", uid, from)
	if to != "" {
		q = q.Where("date < ?", to)
	}
	if err := q.Select("AVG(value)").Scan(&v).Error; err != nil {
		return nil, err
	}
	return v, nil
}

// isNotFound reports whether err is a GORM ErrRecordNotFound.
func isNotFound(err error) bool {
	return errors.Is(err, gorm.ErrRecordNotFound)
}
