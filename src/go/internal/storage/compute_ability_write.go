// compute_ability_write.go adds the write surface for the ability compute job:
// ReplaceAbilitySnapshot (long-form upsert), UpsertActivityAbility, and
// UpsertVo2MaxPB (best-VDOT upsert). Mirrors the Python SQLite writers.
package storage

import (
	"context"
	"time"

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
// label_id), keeping only the higher vdot (DO UPDATE ... WHERE excluded.vdot >
// vo2max_pb.vdot), mirroring Python's upsert_vo2max_pb.
func (s *Store) UpsertVo2MaxPB(ctx context.Context, userID string, row *Vo2MaxPB) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	row.UserID = uid
	if row.UpdatedAt.IsZero() {
		row.UpdatedAt = time.Now().UTC()
	}
	return s.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: "user_id"}, {Name: "race_type"}, {Name: "label_id"},
			},
			DoUpdates: clause.AssignmentColumns([]string{"distance_m", "duration_s", "vdot", "pb_date", "even_paced", "updated_at"}),
		}).
		Create(row).Error
}
