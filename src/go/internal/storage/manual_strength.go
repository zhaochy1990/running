package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const ManualStrengthProvider = "manual_strength"

var (
	ErrManualStrengthNotFound = errors.New("manual strength record not found")
	ErrManualStrengthConflict = errors.New("manual strength record changed")
)

type ManualStrengthSet struct {
	Load         string `json:"load"`
	LoadUnit     string `json:"load_unit"`
	Quantity     int    `json:"quantity"`
	QuantityUnit string `json:"quantity_unit"`
}

type ManualStrengthAction struct {
	Name string              `json:"name"`
	Sets []ManualStrengthSet `json:"sets"`
}

// ManualStrengthRecord keeps the athlete-entered evidence separate from
// watch-derived activities, laps and training-load computations.
type ManualStrengthRecord struct {
	ID             string                 `gorm:"column:id;type:char(36);primaryKey"`
	UserID         string                 `gorm:"column:user_id;type:char(36);not null;index:idx_manual_strength_user_start,priority:1"`
	StartedAt      time.Time              `gorm:"column:started_at;type:datetime(6);not null;index:idx_manual_strength_user_start,priority:2"`
	EndedAt        time.Time              `gorm:"column:ended_at;type:datetime(6);not null"`
	Name           string                 `gorm:"column:name;type:text;not null"`
	Note           string                 `gorm:"column:note;type:text;not null"`
	Actions        []ManualStrengthAction `gorm:"column:actions;type:json;serializer:json;not null"`
	Revision       int                    `gorm:"column:revision;not null"`
	LastMutationID string                 `gorm:"column:last_mutation_id;type:char(36);not null"`
}

func (ManualStrengthRecord) TableName() string { return "manual_strength_records" }

// An owner-scoped digest keeps old create retries from restoring a deleted
// record without retaining the log or its identifiers.
type manualStrengthDeletion struct {
	RecordDigest string `gorm:"column:record_digest;type:char(64);primaryKey"`
}

func (manualStrengthDeletion) TableName() string { return "manual_strength_deletions" }

func manualStrengthRecordDigest(userID, id string) string {
	digest := sha256.Sum256([]byte("manual-strength-deletion:" + userID + ":" + id))
	return hex.EncodeToString(digest[:])
}

// The fence serializes record writes with account erasure even for athletes without a
// saved record yet. After erasure only the digest and denial bit are retained.
type manualStrengthWriteFence struct {
	SubjectDigest string `gorm:"column:subject_digest;type:char(64);primaryKey"`
	Erased        bool   `gorm:"column:erased;not null"`
}

func (manualStrengthWriteFence) TableName() string { return "manual_strength_write_fences" }

func manualStrengthOwnerDigest(userID string) string {
	digest := sha256.Sum256([]byte("manual-strength:" + userID))
	return hex.EncodeToString(digest[:])
}

func revokeManualStrengthWrites(tx *gorm.DB, userID string) error {
	fence := manualStrengthWriteFence{SubjectDigest: manualStrengthOwnerDigest(userID), Erased: true}
	return tx.Clauses(clause.OnConflict{DoUpdates: clause.AssignmentColumns([]string{"erased"})}).Create(&fence).Error
}

func lockManualStrengthWrites(tx *gorm.DB, userID string) (manualStrengthWriteFence, error) {
	fence := manualStrengthWriteFence{SubjectDigest: manualStrengthOwnerDigest(userID)}
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&fence).Error; err != nil {
		return fence, err
	}
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Select("erased").Where("subject_digest = ?", fence.SubjectDigest).Take(&fence).Error
	return fence, err
}

type ManualStrengthWrite struct {
	MutationID string
	Revision   int
	StartedAt  time.Time // Set during a live session. Zero for a historical edit.
	Name       string
	Note       string
	Actions    []ManualStrengthAction
}

func (s *Store) ManualStrengthByID(ctx context.Context, userID, id string) (*ManualStrengthRecord, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var record ManualStrengthRecord
	err = s.db.WithContext(ctx).Where("user_id = ? AND id = ?", uid, id).Take(&record).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

// DeleteManualStrength removes the owner's log and prevents a stale save from
// recreating it. Repeating the deletion after a lost response is safe.
func (s *Store) DeleteManualStrength(ctx context.Context, userID, id string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		fence, err := lockManualStrengthWrites(tx, uid)
		if err != nil || fence.Erased {
			return err
		}
		result := tx.Where("user_id = ? AND id = ?", uid, id).Delete(&ManualStrengthRecord{})
		if result.Error != nil || result.RowsAffected == 0 {
			return result.Error
		}
		return tx.Create(&manualStrengthDeletion{RecordDigest: manualStrengthRecordDigest(uid, id)}).Error
	})
}

// SaveManualStrength commits the entire log in one row transaction. A replay
// of the active mutation returns the committed result without changing its
// clock or revision. An older revision cannot overwrite later work.
func (s *Store) SaveManualStrength(ctx context.Context, userID, id string, write ManualStrengthWrite, now time.Time) (*ManualStrengthRecord, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var record ManualStrengthRecord
	startedAt := write.StartedAt.UTC().Truncate(time.Microsecond)
	endedAt := now.UTC().Truncate(time.Microsecond)
	if endedAt.Before(startedAt) {
		endedAt = startedAt
	}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		fence, err := lockManualStrengthWrites(tx, uid)
		if err != nil {
			return err
		}
		if fence.Erased {
			return ErrManualStrengthNotFound
		}
		// Also cover identities removed before the fence was deployed.
		var priorDeletion UserDeletionAudit
		err = tx.Select("id").Where("user_id = ? AND (auth_deleted_at IS NOT NULL OR stride_deleted_at IS NOT NULL OR status = ?)",
			uid, DeletionStatusCompleted).Take(&priorDeletion).Error
		if err == nil {
			return ErrManualStrengthNotFound
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}

		if write.Revision == 0 && !startedAt.IsZero() {
			var deletion manualStrengthDeletion
			err := tx.Where("record_digest = ?", manualStrengthRecordDigest(uid, id)).Take(&deletion).Error
			if err == nil {
				return ErrManualStrengthNotFound
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			first := ManualStrengthRecord{
				ID: id, UserID: uid, StartedAt: startedAt, EndedAt: endedAt,
				Name: write.Name, Note: write.Note, Actions: write.Actions,
				Revision: 1, LastMutationID: write.MutationID,
			}
			// The insert takes the record lock even when another request has
			// already inserted this ID. It leaves that record's content intact.
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&first).Error; err != nil {
				return err
			}
		}

		err = tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ? AND id = ?", uid, id).Take(&record).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrManualStrengthNotFound
		}
		if err != nil {
			return err
		}
		if record.LastMutationID == write.MutationID {
			return nil
		}
		if write.Revision != record.Revision || (!startedAt.IsZero() && !record.StartedAt.Equal(startedAt)) {
			return ErrManualStrengthConflict
		}

		record.Name = write.Name
		record.Note = write.Note
		record.Actions = write.Actions
		record.Revision++
		record.LastMutationID = write.MutationID
		if !startedAt.IsZero() && endedAt.After(record.EndedAt) {
			record.EndedAt = endedAt
		}
		return tx.Model(&record).Select("name", "note", "actions", "revision", "last_mutation_id", "ended_at").Updates(&record).Error
	})
	if err != nil {
		return nil, err
	}
	return &record, nil
}
