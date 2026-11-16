package storage

import (
	"context"
	"errors"
	"fmt"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"time"
)

const calibrationPolicyKey = "running_baseline"

var ErrCalibrationPolicyConflict = errors.New("calibration policy revision conflict")

type CalibrationMode string

const (
	CalibrationActive    CalibrationMode = "active"
	CalibrationCandidate CalibrationMode = "candidate"
)

type RunningCalibrationPolicy struct {
	PolicyKey        string    `gorm:"column:policy_key;type:varchar(32);primaryKey" json:"-"`
	ActiveVersion    int       `gorm:"column:active_version;not null" json:"active_version"`
	CandidateVersion *int      `gorm:"column:candidate_version" json:"candidate_version"`
	FallbackVersion  int       `gorm:"column:fallback_version;not null" json:"fallback_version"`
	Revision         uint64    `gorm:"column:revision;not null" json:"revision"`
	UpdatedAt        time.Time `gorm:"column:updated_at;type:datetime(6);not null" json:"updated_at"`
}

func (RunningCalibrationPolicy) TableName() string { return "running_calibration_policy" }
func DefaultCalibrationPolicy() RunningCalibrationPolicy {
	candidate := calibration.CandidateVersion
	return RunningCalibrationPolicy{PolicyKey: calibrationPolicyKey, ActiveVersion: calibration.ModelVersion, CandidateVersion: &candidate, FallbackVersion: calibration.ModelVersion}
}
func validCalibrationVersion(v int) bool {
	return v == calibration.ModelVersion || v == calibration.CandidateVersion
}
func validateCalibrationPolicy(p RunningCalibrationPolicy) error {
	if !validCalibrationVersion(p.ActiveVersion) || p.FallbackVersion != calibration.ModelVersion || (p.CandidateVersion != nil && !validCalibrationVersion(*p.CandidateVersion)) {
		return fmt.Errorf("unsupported calibration policy versions")
	}
	return nil
}
func readCalibrationPolicy(db *gorm.DB) (RunningCalibrationPolicy, error) {
	var p RunningCalibrationPolicy
	err := db.Where("policy_key = ?", calibrationPolicyKey).Take(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return DefaultCalibrationPolicy(), nil
	}
	if err != nil {
		return p, err
	}
	return p, validateCalibrationPolicy(p)
}

// CalibrationPolicy never writes an implicit default. A missing table or query
// failure is an error, distinct from a missing row.
func (s *Store) CalibrationPolicy(ctx context.Context) (RunningCalibrationPolicy, error) {
	return readCalibrationPolicy(s.db.WithContext(ctx))
}
func (s *Store) ReplaceCalibrationPolicy(ctx context.Context, expectedRevision uint64, proposed RunningCalibrationPolicy) (RunningCalibrationPolicy, error) {
	if err := validateCalibrationPolicy(proposed); err != nil {
		return proposed, err
	}
	proposed.PolicyKey = calibrationPolicyKey
	proposed.Revision = expectedRevision + 1
	proposed.UpdatedAt = time.Now().UTC().Truncate(time.Microsecond)
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if expectedRevision == 0 {
			result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&proposed)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return ErrCalibrationPolicyConflict
			}
			return nil
		}
		result := tx.Model(&RunningCalibrationPolicy{}).Where("policy_key = ? AND revision = ?", calibrationPolicyKey, expectedRevision).Updates(map[string]any{"active_version": proposed.ActiveVersion, "candidate_version": proposed.CandidateVersion, "fallback_version": proposed.FallbackVersion, "revision": proposed.Revision, "updated_at": proposed.UpdatedAt})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrCalibrationPolicyConflict
		}
		return nil
	})
	return proposed, err
}
