package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Item content is admin-maintained with NO lifecycle: an admin edit is the
// content (save = live). Rows are keyed (race_event_id, item_name) — by NAME,
// not by race_calendar_item.id, so they survive the sync's delete+insert of
// sync items. An item name that no longer matches any calendar item (upstream
// renamed a distance) leaves a dangling row on purpose: when the name returns
// the row re-attaches; nothing reads a dangling row in the meantime.

// ListRaceItemContents returns every item content row of one event, ordered by
// item_name.
func (s *Store) ListRaceItemContents(ctx context.Context, eventID uint64) ([]RaceItemContent, error) {
	var rows []RaceItemContent
	if err := s.db.WithContext(ctx).
		Where("race_event_id = ?", eventID).
		Order("item_name").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list race item content: %w", err)
	}
	return rows, nil
}

// UpsertRaceItemContentTx inserts or fully replaces the content row of
// (eventID, itemName) inside the caller's transaction. A nil in deletes the
// row. The full-replace semantics match the event-level content sections:
// save = live. The write goes through the model (Create/Save), which is what
// makes the serializer-typed JSON columns round-trip.
func UpsertRaceItemContentTx(tx *gorm.DB, eventID uint64, itemName string, in *RaceItemContent) error {
	if in == nil {
		if err := tx.Where("race_event_id = ? AND item_name = ?", eventID, itemName).
			Delete(&RaceItemContent{}).Error; err != nil {
			return fmt.Errorf("storage: delete race item content: %w", err)
		}
		return nil
	}
	var existing RaceItemContent
	err := tx.Where("race_event_id = ? AND item_name = ?", eventID, itemName).First(&existing).Error
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		now := nowUTC()
		row := *in
		row.ID = 0
		row.RaceEventID = eventID
		row.ItemName = itemName
		row.CreatedAt, row.UpdatedAt = now, now
		if err := tx.Create(&row).Error; err != nil {
			return fmt.Errorf("storage: create race item content: %w", err)
		}
		*in = row
		return nil
	case err != nil:
		return fmt.Errorf("storage: lock race item content: %w", err)
	}
	in.ID = existing.ID
	in.RaceEventID = eventID
	in.ItemName = itemName
	in.CreatedAt = existing.CreatedAt
	in.UpdatedAt = nowUTC()
	if err := tx.Save(in).Error; err != nil {
		return fmt.Errorf("storage: update race item content: %w", err)
	}
	return nil
}

// UpsertRaceItemContent is the standalone form of UpsertRaceItemContentTx.
func (s *Store) UpsertRaceItemContent(ctx context.Context, eventID uint64, itemName string, in *RaceItemContent) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return UpsertRaceItemContentTx(tx, eventID, itemName, in)
	})
}

// CreateRaceCalendarItemWithContent inserts an item and its content row in one
// transaction (content may be nil).
func (s *Store) CreateRaceCalendarItemWithContent(ctx context.Context, item *RaceCalendarItem, content *RaceItemContent) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(item).Error; err != nil {
			if isDuplicateKey(err) {
				return ErrRaceCalendarConflict
			}
			return fmt.Errorf("storage: create race_calendar_item: %w", err)
		}
		if content == nil {
			return nil
		}
		return UpsertRaceItemContentTx(tx, item.RaceEventID, item.Name, content)
	})
}

// UpdateRaceCalendarItemWithContent saves an item and, per the content
// tri-state, leaves (set=false), deletes (set=true, content=nil) or fully
// replaces (set=true, content!=nil) its content row — all in one transaction.
// A rename carries the content row along: the row keyed by the old name moves
// to the new name (a dangling row already occupying the new name — e.g. left
// by an earlier round-trip — is superseded by this rename and deleted first).
func (s *Store) UpdateRaceCalendarItemWithContent(ctx context.Context, item *RaceCalendarItem, content *RaceItemContent, set bool) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing RaceCalendarItem
		if err := tx.First(&existing, item.ID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrRaceCalendarNotFound
			}
			return fmt.Errorf("storage: get race_calendar_item: %w", err)
		}
		item.UpdatedAt = time.Now().UTC().Truncate(time.Millisecond)
		if err := tx.Save(item).Error; err != nil {
			if isDuplicateKey(err) {
				return ErrRaceCalendarConflict
			}
			return fmt.Errorf("storage: update race_calendar_item: %w", err)
		}
		if existing.Name != item.Name {
			if err := tx.Where("race_event_id = ? AND item_name = ?", item.RaceEventID, item.Name).
				Delete(&RaceItemContent{}).Error; err != nil {
				return fmt.Errorf("storage: clear renamed race item content: %w", err)
			}
			if err := tx.Model(&RaceItemContent{}).
				Where("race_event_id = ? AND item_name = ?", item.RaceEventID, existing.Name).
				Updates(map[string]any{"item_name": item.Name, "updated_at": nowUTC()}).Error; err != nil {
				return fmt.Errorf("storage: rename race item content: %w", err)
			}
		}
		if !set {
			return nil
		}
		return UpsertRaceItemContentTx(tx, item.RaceEventID, item.Name, content)
	})
}

// MoveRaceContent copies the six event content columns and every item content
// row from the source event to the target event, then deletes the source event
// (its items and item content go with it). It is the administrator's resolution
// for a content_stale row: the upstream renamed/rescheduled the race and now
// lists a fresh row; the content moves to that row and the stale row disappears.
//
// The move refuses (ErrRaceContentConflict) when the target already carries
// content — the admin decides which side wins, the storage never merges.
func (s *Store) MoveRaceContent(ctx context.Context, sourceEventID, targetEventID uint64) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var source, target RaceCalendarEvent
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&source, sourceEventID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrRaceCalendarNotFound
			}
			return fmt.Errorf("storage: lock move source: %w", err)
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&target, targetEventID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrRaceCalendarNotFound
			}
			return fmt.Errorf("storage: lock move target: %w", err)
		}
		if source.ID == target.ID {
			return ErrRaceCalendarConflict
		}

		// Refuse when the target already has content of its own — the admin
		// decides which side wins, the storage never merges.
		if target.HasContent() {
			return ErrRaceContentConflict
		}
		var itemCount int64
		if err := tx.Model(&RaceItemContent{}).Where("race_event_id = ?", target.ID).Count(&itemCount).Error; err != nil {
			return fmt.Errorf("storage: count target item content: %w", err)
		}
		if itemCount > 0 {
			return ErrRaceContentConflict
		}

		// Copy the columns through the model (serializer applies on Save only).
		target.PartitionRule = source.PartitionRule
		target.SignupTimeline = source.SignupTimeline
		target.SignupChannels = source.SignupChannels
		target.PacketPickup = source.PacketPickup
		target.Climate = source.Climate
		target.WeatherWindows = source.WeatherWindows
		target.ContentStale = false
		target.UpdatedAt = nowUTC()
		if err := tx.Save(&target).Error; err != nil {
			return fmt.Errorf("storage: move race content columns: %w", err)
		}

		if err := tx.Exec(
			"INSERT INTO race_item_content (race_event_id, item_name, distance_km, start_point, finish_point, total_ascent_m, elevation_points, aid_stations, cutoffs, prizes, reputation, photos, created_at, updated_at) "+
				"SELECT ?, item_name, distance_km, start_point, finish_point, total_ascent_m, elevation_points, aid_stations, cutoffs, prizes, reputation, photos, created_at, updated_at "+
				"FROM race_item_content WHERE race_event_id = ?",
			target.ID, source.ID).Error; err != nil {
			return fmt.Errorf("storage: move race item content: %w", err)
		}
		// Delete the source event; its items and item content rows go with it.
		if err := tx.Where("id = ?", source.ID).Delete(&RaceCalendarEvent{}).Error; err != nil {
			return fmt.Errorf("storage: delete moved source: %w", err)
		}
		if err := tx.Where("race_event_id = ?", source.ID).Delete(&RaceCalendarItem{}).Error; err != nil {
			return fmt.Errorf("storage: delete moved source items: %w", err)
		}
		if err := tx.Where("race_event_id = ?", source.ID).Delete(&RaceItemContent{}).Error; err != nil {
			return fmt.Errorf("storage: delete moved source item content: %w", err)
		}
		return nil
	})
}
