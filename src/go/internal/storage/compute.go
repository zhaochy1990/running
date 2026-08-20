// compute.go adds the onboarding-compute persistence surface to Store: upserting
// the running-calibration snapshot and replacing the personal-bests set. These
// are the write side of the onboarding_compute handler (ADR 0015); reads for the
// compute inputs live alongside the watch readers.
package storage

import (
	"context"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// UpsertRunningCalibrationSnapshot writes one calibration snapshot, upserting on
// the unique (user_id, as_of_date, algorithm_version) key, and returns its row
// id (needed later to link daily_training_load.calibration_id). A recompute for
// the same as_of_date + version overwrites in place.
func (s *Store) UpsertRunningCalibrationSnapshot(ctx context.Context, snap *RunningCalibrationSnapshot) (uint64, error) {
	uid, err := canonicalUserID(snap.UserID)
	if err != nil {
		return 0, err
	}
	snap.UserID = uid
	if snap.ComputedAt.IsZero() {
		snap.ComputedAt = time.Now().UTC()
	}
	if err := s.db.WithContext(ctx).
		Clauses(clause.OnConflict{UpdateAll: true}).
		Create(snap).Error; err != nil {
		return 0, err
	}
	if snap.ID != 0 {
		return snap.ID, nil
	}
	// Update path: MySQL's ON DUPLICATE KEY UPDATE does not repopulate the id,
	// so read it back by the unique key.
	var out RunningCalibrationSnapshot
	if err := s.db.WithContext(ctx).
		Select("id").
		Where("user_id = ? AND as_of_date = ? AND algorithm_version = ?", uid, snap.AsOfDate, snap.AlgorithmVersion).
		First(&out).Error; err != nil {
		return 0, err
	}
	return out.ID, nil
}

// ReplaceActivityTrainingLoad upserts per-activity load rows (on user_id,label_id).
func (s *Store) ReplaceActivityTrainingLoad(ctx context.Context, userID string, rows []ActivityTrainingLoad) error {
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

// ReplaceDailyTrainingLoad upserts daily PMC rows (on user_id,date).
func (s *Store) ReplaceDailyTrainingLoad(ctx context.Context, userID string, rows []DailyTrainingLoad) error {
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

// ReplaceCalibrationZones replaces the zone rows for one snapshot across the two
// split tables (delete by snapshot_id then insert), mirroring the Python
// _save_zones DELETE+INSERT but with pace and heart-rate zones stored apart.
func (s *Store) ReplaceCalibrationZones(ctx context.Context, userID string, snapshotID uint64, paceZones []RunningCalibrationPaceZone, hrZones []RunningCalibrationHRZone) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	for i := range paceZones {
		paceZones[i].UserID = uid
		paceZones[i].SnapshotID = snapshotID
	}
	for i := range hrZones {
		hrZones[i].UserID = uid
		hrZones[i].SnapshotID = snapshotID
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ? AND snapshot_id = ?", uid, snapshotID).
			Delete(&RunningCalibrationPaceZone{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ? AND snapshot_id = ?", uid, snapshotID).
			Delete(&RunningCalibrationHRZone{}).Error; err != nil {
			return err
		}
		if len(paceZones) > 0 {
			if err := tx.CreateInBatches(&paceZones, 100).Error; err != nil {
				return err
			}
		}
		if len(hrZones) > 0 {
			if err := tx.CreateInBatches(&hrZones, 100).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// ReplacePersonalBests replaces a user's entire personal-bests set in one
// transaction (delete-then-insert), mirroring Python persist_personal_bests
// which rewrites the cached PB table wholesale.
func (s *Store) ReplacePersonalBests(ctx context.Context, userID string, pbs []PersonalBest) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	for i := range pbs {
		pbs[i].UserID = uid
		if pbs[i].UpdatedAt.IsZero() {
			pbs[i].UpdatedAt = now
		}
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", uid).Delete(&PersonalBest{}).Error; err != nil {
			return err
		}
		if len(pbs) == 0 {
			return nil
		}
		return tx.CreateInBatches(&pbs, 100).Error
	})
}

// UpsertPersonalBests upserts the given PB rows on their (user_id, distance) key
// WITHOUT deleting the others — the incremental compute's counterpart to
// ReplacePersonalBests. It writes only the distances a new activity improved,
// leaving every untouched distance's existing best in place.
func (s *Store) UpsertPersonalBests(ctx context.Context, userID string, pbs []PersonalBest) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	if len(pbs) == 0 {
		return nil
	}
	now := time.Now().UTC()
	for i := range pbs {
		pbs[i].UserID = uid
		if pbs[i].UpdatedAt.IsZero() {
			pbs[i].UpdatedAt = now
		}
	}
	return s.db.WithContext(ctx).
		Clauses(clause.OnConflict{UpdateAll: true}).
		CreateInBatches(&pbs, 100).Error
}
