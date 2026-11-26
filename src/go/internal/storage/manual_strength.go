package storage

import (
	"context"
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
		if write.Revision == 0 && !startedAt.IsZero() {
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

		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
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
