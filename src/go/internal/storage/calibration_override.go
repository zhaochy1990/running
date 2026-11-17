// calibration_override.go owns the per-user calibration selection override
// (#999 R4): an explicitly authorized user reads the evolved v4 by a pinned
// (algorithm_version, algorithm_revision) identity while every other user and
// the global policy stay untouched. The resolver precedence lives in
// ReadEffectiveRunningCalibration; this file only owns the row, its CAS writes
// and the audit trail. A revoked row keeps its audit history but reads as
// absent, so "delete override" is an explicit restoration of the previous
// global selection.
package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Override statuses. Only OverrideStatusActive influences effective selection.
const (
	OverrideStatusActive  = "active"
	OverrideStatusRevoked = "revoked"
)

// ErrCalibrationOverrideConflict mirrors the global policy CAS error: the
// caller's expected revision no longer matches the stored row.
var ErrCalibrationOverrideConflict = errors.New("calibration user override revision conflict")

// RunningCalibrationUserOverride is one user's explicit calibration selection
// (table "running_calibration_user_override"). One row per user; revision is a
// CAS counter bumped on every change; status retains the revoke audit instead
// of deleting history. Actor/note carry who authorized the change and why.
type RunningCalibrationUserOverride struct {
	UserID            string    `gorm:"column:user_id;type:char(36);primaryKey" json:"user_id"`
	AlgorithmVersion  int       `gorm:"column:algorithm_version;not null" json:"algorithm_version"`
	AlgorithmRevision string    `gorm:"column:algorithm_revision;type:varchar(64);not null;default:''" json:"algorithm_revision"`
	Status            string    `gorm:"column:status;type:varchar(16);not null;default:active" json:"status"`
	Revision          uint64    `gorm:"column:revision;not null" json:"revision"`
	Actor             string    `gorm:"column:actor;type:varchar(191);not null;default:''" json:"actor"`
	Note              string    `gorm:"column:note;type:varchar(512);not null;default:''" json:"note"`
	CreatedAt         time.Time `gorm:"column:created_at;type:datetime(6);not null" json:"created_at"`
	UpdatedAt         time.Time `gorm:"column:updated_at;type:datetime(6);not null" json:"updated_at"`
}

func (RunningCalibrationUserOverride) TableName() string { return "running_calibration_user_override" }

// CalibrationOverrideSelection is the bounded override disclosure embedded in
// CalibrationSelection: what identity the user pinned and which override row
// revision authorized it.
type CalibrationOverrideSelection struct {
	Revision          uint64 `json:"revision"`
	AlgorithmVersion  int    `json:"algorithm_version"`
	AlgorithmRevision string `json:"algorithm_revision"`
}

func validateCalibrationOverride(o RunningCalibrationUserOverride) error {
	if !validCalibrationVersion(o.AlgorithmVersion) {
		return fmt.Errorf("unsupported calibration override version")
	}
	if !validAlgorithmRevision(o.AlgorithmRevision) {
		return fmt.Errorf("invalid calibration override revision")
	}
	if len(o.Actor) > 191 {
		return fmt.Errorf("calibration override actor too long")
	}
	if o.Note != "" && len(o.Note) > 512 {
		return fmt.Errorf("calibration override note too long")
	}
	if o.Status != "" && o.Status != OverrideStatusActive {
		return fmt.Errorf("replace requires an active override status")
	}
	return nil
}

// UserCalibrationOverride returns the user's active override, or (nil, nil)
// when the user has none (or only a revoked one).
func (s *Store) UserCalibrationOverride(ctx context.Context, user string) (*RunningCalibrationUserOverride, error) {
	uid, err := canonicalUserID(user)
	if err != nil {
		return nil, err
	}
	var row RunningCalibrationUserOverride
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND status = ?", uid, OverrideStatusActive).
		Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ReplaceUserCalibrationOverride CAS-writes the user's override as active.
// expectedRevision 0 means "create only" (conflict when any row exists);
// otherwise the stored row's revision must match. Returns the stored row.
func (s *Store) ReplaceUserCalibrationOverride(ctx context.Context, expectedRevision uint64, proposed RunningCalibrationUserOverride) (RunningCalibrationUserOverride, error) {
	uid, err := canonicalUserID(proposed.UserID)
	if err != nil {
		return proposed, err
	}
	if err := validateCalibrationOverride(proposed); err != nil {
		return proposed, err
	}
	proposed.UserID = uid
	proposed.Status = OverrideStatusActive
	proposed.Revision = expectedRevision + 1
	now := time.Now().UTC().Truncate(time.Microsecond)
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current RunningCalibrationUserOverride
		err := tx.Where("user_id = ?", uid).Take(&current).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if expectedRevision != 0 {
				return ErrCalibrationOverrideConflict
			}
			proposed.CreatedAt, proposed.UpdatedAt = now, now
			if err := tx.Create(&proposed).Error; err != nil {
				// Two concurrent create-only CAS writes both read "no row" and
				// collide on the user_id primary key: the loser's raw MySQL
				// duplicate-key (1062) is classified as the same revision
				// conflict sentinel the read path already returns.
				if isDuplicateKey(err) {
					return ErrCalibrationOverrideConflict
				}
				return err
			}
			return nil
		}
		if err != nil {
			return err
		}
		if current.Revision != expectedRevision {
			return ErrCalibrationOverrideConflict
		}
		proposed.CreatedAt = current.CreatedAt
		proposed.UpdatedAt = now
		result := tx.Model(&RunningCalibrationUserOverride{}).
			Where("user_id = ? AND revision = ?", uid, expectedRevision).
			Updates(map[string]any{
				"algorithm_version":  proposed.AlgorithmVersion,
				"algorithm_revision": proposed.AlgorithmRevision,
				"status":             proposed.Status,
				"revision":           proposed.Revision,
				"actor":              proposed.Actor,
				"note":               proposed.Note,
				"updated_at":         proposed.UpdatedAt,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrCalibrationOverrideConflict
		}
		return nil
	})
	if err != nil {
		return proposed, err
	}
	return proposed, nil
}

// RevokeUserCalibrationOverride flips the user's override to revoked under a
// revision CAS. Effective reads immediately fall back to the global policy;
// the row keeps its full audit trail.
func (s *Store) RevokeUserCalibrationOverride(ctx context.Context, user string, expectedRevision uint64, actor, note string) error {
	uid, err := canonicalUserID(user)
	if err != nil {
		return err
	}
	if len(actor) > 191 || len(note) > 512 {
		return fmt.Errorf("calibration override actor or note too long")
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current RunningCalibrationUserOverride
		if err := tx.Where("user_id = ?", uid).Take(&current).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrCalibrationOverrideConflict
			}
			return err
		}
		if current.Revision != expectedRevision || current.Status != OverrideStatusActive {
			return ErrCalibrationOverrideConflict
		}
		result := tx.Model(&RunningCalibrationUserOverride{}).
			Where("user_id = ? AND revision = ?", uid, expectedRevision).
			Updates(map[string]any{
				"status":     OverrideStatusRevoked,
				"revision":   expectedRevision + 1,
				"actor":      actor,
				"note":       note,
				"updated_at": time.Now().UTC().Truncate(time.Microsecond),
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrCalibrationOverrideConflict
		}
		return nil
	})
}

// readActiveCalibrationOverride is the transaction-scoped reader used by the
// effective-selection resolver so policy, override, snapshot and zones share
// one REPEATABLE READ view.
func readActiveCalibrationOverride(db *gorm.DB, uid string) (*RunningCalibrationUserOverride, error) {
	var row RunningCalibrationUserOverride
	err := db.Where("user_id = ? AND status = ?", uid, OverrideStatusActive).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// RunningCalibrationSnapshotsForUser lists every snapshot identity the user
// holds, ordered (as_of_date, id) — the audit/inventory view behind the #999
// preview/publish entrypoints.
func (s *Store) RunningCalibrationSnapshotsForUser(ctx context.Context, user string) ([]RunningCalibrationSnapshot, error) {
	uid, err := canonicalUserID(user)
	if err != nil {
		return nil, err
	}
	var rows []RunningCalibrationSnapshot
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).Order("as_of_date, id").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// LatestRunningCalibrationSnapshotForIdentity is the revision-pinned variant of
// LatestRunningCalibrationSnapshotForVersion: the user's most recent snapshot
// of exactly (algorithm_version, algorithm_revision) at/below asOf ("" = no
// bound), or (nil, nil). The #999 evolved refresh path and its empty-run gate
// read through this so a pinned identity never collides with another
// revision's rows.
func (s *Store) LatestRunningCalibrationSnapshotForIdentity(ctx context.Context, user string, algorithmVersion int, algorithmRevision, asOf string) (*RunningCalibrationSnapshot, error) {
	uid, err := canonicalUserID(user)
	if err != nil {
		return nil, err
	}
	q := s.db.WithContext(ctx).
		Where("user_id = ? AND algorithm_version = ? AND algorithm_revision = ?", uid, algorithmVersion, algorithmRevision)
	if asOf != "" {
		q = q.Where("as_of_date <= ?", asOf)
	}
	var rows []RunningCalibrationSnapshot
	if err := q.Order("as_of_date DESC, id DESC").Limit(1).Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// upsertOverrideForPublish activates (or re-affirms) the override inside the
// publish transaction. Idempotent: an already-active identical identity is a
// no-op that keeps its revision, so a retried publish never bumps the CAS
// counter or rewrites audit history.
func upsertOverrideForPublish(tx *gorm.DB, o RunningCalibrationUserOverride) error {
	if err := validateCalibrationOverride(o); err != nil {
		return err
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	var current RunningCalibrationUserOverride
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("user_id = ?", o.UserID).Take(&current).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		o.Status = OverrideStatusActive
		o.Revision = 1
		o.CreatedAt, o.UpdatedAt = now, now
		return tx.Create(&o).Error
	}
	if err != nil {
		return err
	}
	if current.Status == OverrideStatusActive && current.AlgorithmVersion == o.AlgorithmVersion && current.AlgorithmRevision == o.AlgorithmRevision {
		return nil
	}
	result := tx.Model(&RunningCalibrationUserOverride{}).
		Where("user_id = ? AND revision = ?", o.UserID, current.Revision).
		Updates(map[string]any{
			"algorithm_version":  o.AlgorithmVersion,
			"algorithm_revision": o.AlgorithmRevision,
			"status":             OverrideStatusActive,
			"revision":           current.Revision + 1,
			"actor":              o.Actor,
			"note":               o.Note,
			"updated_at":         now,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrCalibrationOverrideConflict
	}
	return nil
}
