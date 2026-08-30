// compute_ability_write.go adds the write surface for the ability compute job:
// ReplaceAbilitySnapshot (long-form upsert), UpsertActivityAbility, and
// UpsertVo2MaxPB (best-VDOT upsert). Mirrors the Python SQLite writers.
package storage

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ReplaceAbilitySnapshot upserts long-form ability_snapshot rows on
// (user_id, date, level, dimension).
func (s *Store) ReplaceAbilitySnapshot(ctx context.Context, userID string, rows []AbilitySnapshot) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	for i := range rows {
		rows[i].UserID = uid
		if rows[i].ComputedAt.IsZero() {
			rows[i].ComputedAt = now
		}
	}
	if len(rows) == 0 {
		return nil
	}
	return s.db.WithContext(ctx).
		Clauses(clause.OnConflict{UpdateAll: true}).
		CreateInBatches(&rows, 200).Error
}

// UpsertActivityAbility inserts or updates one activity's L1 + contribution row
// on (user_id, label_id).
func (s *Store) UpsertActivityAbility(ctx context.Context, userID string, row *ActivityAbility) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	row.UserID = uid
	if row.ComputedAt.IsZero() {
		row.ComputedAt = time.Now().UTC()
	}
	return s.db.WithContext(ctx).
		Clauses(clause.OnConflict{UpdateAll: true}).
		Create(row).Error
}

// UpsertVo2MaxPB inserts or updates a vo2max_pb row on (user_id, race_type,
// label_id), keeping only the higher vdot — mirroring Python's
// upsert_vo2max_pb ("ON CONFLICT ... DO UPDATE WHERE excluded.vdot >
// vo2max_pb.vdot"). MySQL's ON DUPLICATE KEY UPDATE can't express that WHERE,
// so do a read-modify-write.
func (s *Store) UpsertVo2MaxPB(ctx context.Context, userID string, row *Vo2MaxPB) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	row.UserID = uid
	if row.UpdatedAt.IsZero() {
		row.UpdatedAt = time.Now().UTC()
	}
	where := s.db.WithContext(ctx).Where("user_id = ? AND race_type = ? AND label_id = ?", uid, row.RaceType, row.LabelID)
	var existing Vo2MaxPB
	err = where.First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return s.db.WithContext(ctx).Create(row).Error
	}
	if err != nil {
		return err
	}
	// Only overwrite when the new candidate strictly improves vdot (or the
	// existing row has no vdot yet), matching the Python guard.
	if existing.Vdot != nil && row.Vdot != nil && *row.Vdot <= *existing.Vdot {
		return nil
	}
	return where.Updates(map[string]any{
		"distance_m": row.DistanceM, "duration_s": row.DurationS, "vdot": row.Vdot,
		"pb_date": row.PBDate, "even_paced": row.EvenPaced, "updated_at": row.UpdatedAt,
	}).Error
}
