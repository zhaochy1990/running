// compute.go adds the onboarding-compute persistence surface to Store: upserting
// the running-calibration snapshot and replacing the personal-bests set. These
// are the write side of the onboarding_compute handler (ADR 0013); reads for the
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
