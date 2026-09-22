package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	// ErrRaceContentNotFound means no content row matched the requested city,
	// race event or content id.
	ErrRaceContentNotFound = errors.New("storage: race content not found")
	// ErrRaceContentConflict means the requested link is already taken: the
	// target race event already has content, or the business key collides with
	// another content row.
	ErrRaceContentConflict = errors.New("storage: race content conflict")
	// ErrInvalidRaceContent means the requested content type or version is
	// unusable (unknown content type, version not found).
	ErrInvalidRaceContent = errors.New("storage: invalid race content request")
)

// AutoMigrateRaceContent creates or reconciles the race-content schema: the
// race-level and item-level content tables, the city content table and the
// shared publish-version table.
func (s *Store) AutoMigrateRaceContent(ctx context.Context) error {
	for _, model := range []any{&RaceContent{}, &RaceContentItem{}, &RaceCityContent{}, &RaceContentVersion{}} {
		if err := s.db.WithContext(ctx).AutoMigrate(model); err != nil {
			return fmt.Errorf("storage: automigrate %T: %w", model, err)
		}
	}
	return nil
}

// GetRaceCityContent returns the content of city (the race_calendar.city
// spelling, e.g. 厦门市), or nil when the city has none yet.
func (s *Store) GetRaceCityContent(ctx context.Context, city string) (*RaceCityContent, error) {
	var row RaceCityContent
	err := s.db.WithContext(ctx).Where("city = ?", city).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("storage: get race city content: %w", err)
	}
	return &row, nil
}

// UpsertRaceCityContent creates or replaces the working state of a city's
// content. An existing row keeps its lifecycle status (direct edits to
// published content take effect immediately) and its identity; a new row starts
// as draft. Status and City on the incoming row are ignored.
func (s *Store) UpsertRaceCityContent(ctx context.Context, in *RaceCityContent) (*RaceCityContent, error) {
	var saved *RaceCityContent
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row RaceCityContent
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("city = ?", in.City).First(&row).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			now := nowUTC()
			created := *in
			created.ID = 0
			created.Status = RaceContentStatusDraft
			created.CreatedAt, created.UpdatedAt = now, now
			if err := tx.Create(&created).Error; err != nil {
				if isDuplicateKey(err) {
					return ErrRaceContentConflict
				}
				return fmt.Errorf("storage: create race city content: %w", err)
			}
			saved = &created
			return nil
		case err != nil:
			return fmt.Errorf("storage: lock race city content: %w", err)
		}
		applyRaceCityContentUpdate(&row, in)
		row.UpdatedAt = nowUTC()
		// Save (not Updates(map)): serializer-typed columns only serialize on
		// model writes, and a full-row write clears absent sections to NULL.
		if err := tx.Save(&row).Error; err != nil {
			return fmt.Errorf("storage: update race city content: %w", err)
		}
		saved = &row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return saved, nil
}

// UpsertRaceCityContentAIDraft merges an AI-generated intro+climate into a
// city's working content without touching the other sections (province,
// attractions, weather windows). It is draft-only: a published or archived row
// is rejected with ErrRaceContentConflict so a live city can never be silently
// overwritten by a generated draft. A new row starts as draft with only the
// two AI sections populated.
func (s *Store) UpsertRaceCityContentAIDraft(ctx context.Context, in *RaceCityContent) (*RaceCityContent, error) {
	var saved *RaceCityContent
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row RaceCityContent
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("city = ?", in.City).First(&row).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			now := nowUTC()
			created := *in
			created.ID = 0
			created.Status = RaceContentStatusDraft
			// Only intro + climate are AI-generated; everything else is
			// deliberately left empty for the admin to fill in later.
			created.Province = nil
			created.Attractions = nil
			created.WeatherWindows = nil
			created.CreatedAt, created.UpdatedAt = now, now
			if err := tx.Create(&created).Error; err != nil {
				if isDuplicateKey(err) {
					return ErrRaceContentConflict
				}
				return fmt.Errorf("storage: create race city content draft: %w", err)
			}
			saved = &created
			return nil
		case err != nil:
			return fmt.Errorf("storage: lock race city content: %w", err)
		}
		if row.Status != RaceContentStatusDraft {
			return ErrRaceContentConflict
		}
		row.Intro = in.Intro
		row.Climate = in.Climate
		row.UpdatedAt = nowUTC()
		if err := tx.Save(&row).Error; err != nil {
			return fmt.Errorf("storage: update race city content draft: %w", err)
		}
		saved = &row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return saved, nil
}

// PublishRaceCityContent snapshots the city's current content as the next
// version and flips it to published. The snapshot is immutable; repeated
// publishes mint one version each.
func (s *Store) PublishRaceCityContent(ctx context.Context, city, publishedBy string) (*RaceCityContent, int, error) {
	var saved *RaceCityContent
	version := 0
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := lockRaceCityContent(tx, city)
		if err != nil {
			return err
		}
		next, err := insertRaceContentVersion(tx, RaceContentVersionTypeCity, row.ID, row, publishedBy)
		if err != nil {
			return err
		}
		version = next
		now := nowUTC()
		if err := tx.Model(&RaceCityContent{}).Where("id = ?", row.ID).Updates(map[string]any{
			"status":     RaceContentStatusPublished,
			"updated_at": now,
		}).Error; err != nil {
			return fmt.Errorf("storage: publish race city content: %w", err)
		}
		row.Status = RaceContentStatusPublished
		row.UpdatedAt = now
		saved = row
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	return saved, version, nil
}

// ArchiveRaceCityContent takes a city's content offline without deleting it.
func (s *Store) ArchiveRaceCityContent(ctx context.Context, city string) (*RaceCityContent, error) {
	var saved *RaceCityContent
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := lockRaceCityContent(tx, city)
		if err != nil {
			return err
		}
		if err := tx.Model(&RaceCityContent{}).Where("id = ?", row.ID).Updates(map[string]any{
			"status":     RaceContentStatusArchived,
			"updated_at": nowUTC(),
		}).Error; err != nil {
			return fmt.Errorf("storage: archive race city content: %w", err)
		}
		row.Status = RaceContentStatusArchived
		saved = row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return saved, nil
}

// RollbackRaceCityContent copies version's snapshot back into the city's
// working state. The lifecycle status is untouched (rollback restores content,
// not the publish state). Version rows are never rewritten.
func (s *Store) RollbackRaceCityContent(ctx context.Context, city string, version int) (*RaceCityContent, error) {
	var saved *RaceCityContent
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := lockRaceCityContent(tx, city)
		if err != nil {
			return err
		}
		snap, err := loadRaceContentVersion(tx, RaceContentVersionTypeCity, row.ID, version)
		if err != nil {
			return err
		}
		var snapshot RaceCityContent
		if err := json.Unmarshal([]byte(snap.Snapshot), &snapshot); err != nil {
			return fmt.Errorf("storage: unmarshal city snapshot: %w", err)
		}
		applyRaceCityContentUpdate(row, &snapshot)
		row.UpdatedAt = nowUTC()
		if err := tx.Save(row).Error; err != nil {
			return fmt.Errorf("storage: rollback race city content: %w", err)
		}
		saved = row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return saved, nil
}

// GetRaceContentByEvent returns the content aggregate attached to the event
// with race_calendar id eventID, or nil when the event has none. Resolution is
// two-step: the live link (race_event_id) first, then the business-key
// snapshot (source, name, race_date) — so a race that the upstream sync
// deleted+re-inserted with an unchanged identity re-links automatically.
func (s *Store) GetRaceContentByEvent(ctx context.Context, eventID uint64) (*RaceContent, []RaceContentItem, error) {
	var event RaceCalendarEvent
	if err := s.db.WithContext(ctx).Where("id = ?", eventID).First(&event).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, ErrRaceCalendarNotFound
		}
		return nil, nil, fmt.Errorf("storage: get race calendar event: %w", err)
	}

	var row RaceContent
	err := s.db.WithContext(ctx).Where("race_event_id = ?", eventID).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		err = s.db.WithContext(ctx).
			Where("source = ? AND race_name = ? AND race_date = ?", event.Source, event.Name, event.RaceDate).
			First(&row).Error
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("storage: get race content by event: %w", err)
	}
	items, err := s.listRaceContentItems(ctx, row.ID)
	if err != nil {
		return nil, nil, err
	}
	return &row, items, nil
}

// UpsertRaceContent creates or replaces the working state of a race's content
// and its items, attaching it to event. Resolution mirrors
// GetRaceContentByEvent (live link, then business-key snapshot), so editing a
// re-inserted race re-attaches the surviving content instead of duplicating it.
// Items are fully replaced (delete + insert by item_name). The lifecycle status
// of an existing row is preserved; a new row starts as draft.
func (s *Store) UpsertRaceContent(ctx context.Context, event *RaceCalendarEvent, in *RaceContent, items []RaceContentItem) (*RaceContent, []RaceContentItem, error) {
	var saved *RaceContent
	var savedItems []RaceContentItem
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Re-read inside the transaction: the API resolved the event outside it,
		// and a concurrent upstream rename would otherwise snapshot a stale
		// business key against the live event id.
		fresh := *event
		if err := tx.Where("id = ?", event.ID).First(&fresh).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrRaceCalendarNotFound
			}
			return fmt.Errorf("storage: get race calendar event: %w", err)
		}
		event = &fresh
		var row RaceContent
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("race_event_id = ?", event.ID).First(&row).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			err = tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("source = ? AND race_name = ? AND race_date = ?", event.Source, event.Name, event.RaceDate).
				First(&row).Error
		}
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			now := nowUTC()
			row = RaceContent{
				RaceEventID: &event.ID,
				Source:      event.Source,
				RaceName:    event.Name,
				RaceDate:    event.RaceDate,
				Year:        raceContentYear(event.RaceDate),
				Status:      RaceContentStatusDraft,
				CreatedAt:   now,
			}
			applyRaceContentUpdate(&row, in)
			row.UpdatedAt = now
			if err := tx.Create(&row).Error; err != nil {
				if isDuplicateKey(err) {
					return ErrRaceContentConflict
				}
				return fmt.Errorf("storage: create race content: %w", err)
			}
		case err != nil:
			return fmt.Errorf("storage: lock race content: %w", err)
		default:
			// Re-attach while we are here: the matched row may carry a stale
			// or broken link, and the business key just proved it is this race.
			applyRaceContentUpdate(&row, in)
			row.RaceEventID = &event.ID
			row.UpdatedAt = nowUTC()
			// Save (not Updates(map)): serializer-typed columns only serialize
			// on model writes; the full-row write also clears absent sections.
			if err := tx.Save(&row).Error; err != nil {
				return fmt.Errorf("storage: update race content: %w", err)
			}
		}

		newItems, err := replaceRaceContentItems(tx, row.ID, items)
		if err != nil {
			return err
		}
		saved = &row
		savedItems = newItems
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return saved, savedItems, nil
}

// AttachRaceContent links an orphaned (or stale-linked) content row to a race
// event and refreshes its business-key snapshot from that event. Used after the
// upstream sync renamed or rescheduled a race: the content survived, the link
// did not — an administrator picks the new event from the orphan list.
func (s *Store) AttachRaceContent(ctx context.Context, contentID, eventID uint64) (*RaceContent, []RaceContentItem, error) {
	var saved *RaceContent
	var savedItems []RaceContentItem
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var event RaceCalendarEvent
		if err := tx.Where("id = ?", eventID).First(&event).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrRaceCalendarNotFound
			}
			return fmt.Errorf("storage: get race calendar event: %w", err)
		}
		var row RaceContent
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", contentID).First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrRaceContentNotFound
			}
			return fmt.Errorf("storage: lock race content: %w", err)
		}
		row.RaceEventID = &event.ID
		row.Source = event.Source
		row.RaceName = event.Name
		row.RaceDate = event.RaceDate
		row.Year = raceContentYear(event.RaceDate)
		row.UpdatedAt = nowUTC()
		if err := tx.Model(&RaceContent{}).Where("id = ?", row.ID).Updates(map[string]any{
			"race_event_id": row.RaceEventID,
			"source":        row.Source,
			"race_name":     row.RaceName,
			"race_date":     row.RaceDate,
			"year":          row.Year,
			"updated_at":    row.UpdatedAt,
		}).Error; err != nil {
			if isDuplicateKey(err) {
				return ErrRaceContentConflict
			}
			return fmt.Errorf("storage: attach race content: %w", err)
		}
		items, err := listRaceContentItemsTx(tx, row.ID)
		if err != nil {
			return err
		}
		saved = &row
		savedItems = items
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return saved, savedItems, nil
}

// ListOrphanRaceContent returns content rows whose live link is broken: either
// never attached or pointing at a race_calendar row the sync no longer has.
// These are the rows an administrator can re-attach after an upstream
// rename/reschedule.
func (s *Store) ListOrphanRaceContent(ctx context.Context) ([]RaceContent, error) {
	var rows []RaceContent
	err := s.db.WithContext(ctx).
		Where("race_event_id IS NULL OR NOT EXISTS (?)",
			s.db.Model(&RaceCalendarEvent{}).Select("1").
				Where("race_calendar.id = race_content.race_event_id")).
		Order("updated_at DESC").
		Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list orphan race content: %w", err)
	}
	return rows, nil
}

// PublishRaceContent snapshots the race's current content (including items) as
// the next version and flips it to published.
func (s *Store) PublishRaceContent(ctx context.Context, contentID uint64, publishedBy string) (*RaceContent, []RaceContentItem, int, error) {
	var saved *RaceContent
	var savedItems []RaceContentItem
	version := 0
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := lockRaceContent(tx, contentID)
		if err != nil {
			return err
		}
		items, err := listRaceContentItemsTx(tx, row.ID)
		if err != nil {
			return err
		}
		snapshot := raceContentSnapshot{Content: *row, Items: items}
		next, err := insertRaceContentVersion(tx, RaceContentVersionTypeRace, row.ID, snapshot, publishedBy)
		if err != nil {
			return err
		}
		version = next
		now := nowUTC()
		if err := tx.Model(&RaceContent{}).Where("id = ?", row.ID).Updates(map[string]any{
			"status":     RaceContentStatusPublished,
			"updated_at": now,
		}).Error; err != nil {
			return fmt.Errorf("storage: publish race content: %w", err)
		}
		row.Status = RaceContentStatusPublished
		row.UpdatedAt = now
		saved = row
		savedItems = items
		return nil
	})
	if err != nil {
		return nil, nil, 0, err
	}
	return saved, savedItems, version, nil
}

// ArchiveRaceContent takes a race's content offline without deleting it.
func (s *Store) ArchiveRaceContent(ctx context.Context, contentID uint64) (*RaceContent, []RaceContentItem, error) {
	var saved *RaceContent
	var savedItems []RaceContentItem
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := lockRaceContent(tx, contentID)
		if err != nil {
			return err
		}
		if err := tx.Model(&RaceContent{}).Where("id = ?", row.ID).Updates(map[string]any{
			"status":     RaceContentStatusArchived,
			"updated_at": nowUTC(),
		}).Error; err != nil {
			return fmt.Errorf("storage: archive race content: %w", err)
		}
		row.Status = RaceContentStatusArchived
		items, err := listRaceContentItemsTx(tx, row.ID)
		if err != nil {
			return err
		}
		saved = row
		savedItems = items
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return saved, savedItems, nil
}

// ListRaceContentVersions returns the publish history of a content aggregate,
// newest first, without the snapshot bodies.
func (s *Store) ListRaceContentVersions(ctx context.Context, contentType string, contentID uint64) ([]RaceContentVersion, error) {
	var rows []RaceContentVersion
	err := s.db.WithContext(ctx).
		Select("id, content_type, content_id, version, published_by, published_at, created_at, updated_at").
		Where("content_type = ? AND content_id = ?", contentType, contentID).
		Order("version DESC").
		Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list race content versions: %w", err)
	}
	return rows, nil
}

// RollbackRaceContent copies version's snapshot back into the race's working
// state (content fields + items). The lifecycle status and the current
// event link are untouched — rollback restores content, not identity.
func (s *Store) RollbackRaceContent(ctx context.Context, contentID uint64, version int) (*RaceContent, []RaceContentItem, error) {
	var saved *RaceContent
	var savedItems []RaceContentItem
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := lockRaceContent(tx, contentID)
		if err != nil {
			return err
		}
		snap, err := loadRaceContentVersion(tx, RaceContentVersionTypeRace, row.ID, version)
		if err != nil {
			return err
		}
		var snapshot raceContentSnapshot
		if err := json.Unmarshal([]byte(snap.Snapshot), &snapshot); err != nil {
			return fmt.Errorf("storage: unmarshal race snapshot: %w", err)
		}
		applyRaceContentUpdate(row, &snapshot.Content)
		row.UpdatedAt = nowUTC()
		if err := tx.Save(row).Error; err != nil {
			return fmt.Errorf("storage: rollback race content: %w", err)
		}
		items, err := replaceRaceContentItems(tx, row.ID, snapshot.Items)
		if err != nil {
			return err
		}
		saved = row
		savedItems = items
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return saved, savedItems, nil
}

// applyRaceContentUpdate copies the admin-writable content fields from in onto
// row, leaving identity (id, business key, link) and lifecycle status alone.
func applyRaceContentUpdate(row *RaceContent, in *RaceContent) {
	row.PartitionRule = in.PartitionRule
	row.SignupTimeline = in.SignupTimeline
	row.SignupChannels = in.SignupChannels
	row.PacketPickup = in.PacketPickup
}

// applyRaceCityContentUpdate is the city-side counterpart of
// applyRaceContentUpdate.
func applyRaceCityContentUpdate(row *RaceCityContent, in *RaceCityContent) {
	row.Province = in.Province
	row.Intro = in.Intro
	row.Attractions = in.Attractions
	row.Climate = in.Climate
	row.WeatherWindows = in.WeatherWindows
}

// replaceRaceContentItems swaps a content row's items for the given list in one
// transaction step (delete-all + insert). Names are the identity the sync
// survival relies on, not the surrogate ids.
func replaceRaceContentItems(tx *gorm.DB, contentID uint64, items []RaceContentItem) ([]RaceContentItem, error) {
	if err := tx.Where("race_content_id = ?", contentID).Delete(&RaceContentItem{}).Error; err != nil {
		return nil, fmt.Errorf("storage: replace race content items: %w", err)
	}
	if len(items) == 0 {
		return nil, nil
	}
	now := nowUTC()
	inserted := make([]RaceContentItem, 0, len(items))
	for i := range items {
		item := items[i]
		item.ID = 0
		item.RaceContentID = contentID
		item.CreatedAt, item.UpdatedAt = now, now
		inserted = append(inserted, item)
	}
	if err := tx.Create(&inserted).Error; err != nil {
		return nil, fmt.Errorf("storage: replace race content items: %w", err)
	}
	return inserted, nil
}

func (s *Store) listRaceContentItems(ctx context.Context, contentID uint64) ([]RaceContentItem, error) {
	var rows []RaceContentItem
	if err := s.db.WithContext(ctx).
		Where("race_content_id = ?", contentID).
		Order("item_name").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list race content items: %w", err)
	}
	return rows, nil
}

// listRaceContentItemsTx is the in-transaction variant of listRaceContentItems.
func listRaceContentItemsTx(tx *gorm.DB, contentID uint64) ([]RaceContentItem, error) {
	var rows []RaceContentItem
	if err := tx.Where("race_content_id = ?", contentID).
		Order("item_name").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list race content items: %w", err)
	}
	return rows, nil
}

func lockRaceContent(tx *gorm.DB, id uint64) (*RaceContent, error) {
	var row RaceContent
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", id).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrRaceContentNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("storage: lock race content: %w", err)
	}
	return &row, nil
}

func lockRaceCityContent(tx *gorm.DB, city string) (*RaceCityContent, error) {
	var row RaceCityContent
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("city = ?", city).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrRaceContentNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("storage: lock race city content: %w", err)
	}
	return &row, nil
}

// insertRaceContentVersion marshals payload as the next immutable version of
// (contentType, contentID) and returns the allocated version number.
func insertRaceContentVersion(tx *gorm.DB, contentType string, contentID uint64, payload any, publishedBy string) (int, error) {
	var latest RaceContentVersion
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("content_type = ? AND content_id = ?", contentType, contentID).
		Order("version DESC").First(&latest).Error
	next := 1
	if err == nil {
		next = latest.Version + 1
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, fmt.Errorf("storage: lock race content version: %w", err)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, fmt.Errorf("storage: marshal race content snapshot: %w", err)
	}
	now := nowUTC()
	row := RaceContentVersion{
		ContentType: contentType, ContentID: contentID, Version: next,
		Snapshot: string(body), PublishedBy: publishedBy,
		PublishedAt: now, CreatedAt: now, UpdatedAt: now,
	}
	if err := tx.Create(&row).Error; err != nil {
		return 0, fmt.Errorf("storage: create race content version: %w", err)
	}
	return next, nil
}

// loadRaceContentVersion reads one version row FOR UPDATE, mapping a missing
// row to ErrInvalidRaceContent (the API surfaces it as 404).
func loadRaceContentVersion(tx *gorm.DB, contentType string, contentID uint64, version int) (*RaceContentVersion, error) {
	var row RaceContentVersion
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("content_type = ? AND content_id = ? AND version = ?", contentType, contentID, version).
		First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("%w: version %d not found", ErrInvalidRaceContent, version)
	}
	if err != nil {
		return nil, fmt.Errorf("storage: load race content version: %w", err)
	}
	return &row, nil
}

// raceContentYear extracts the calendar year from a race_date ("2006-01-02").
func raceContentYear(raceDate string) int {
	if len(raceDate) < 4 {
		return 0
	}
	year, err := strconv.Atoi(raceDate[:4])
	if err != nil {
		return 0
	}
	return year
}

// nowUTC is the shared UTC write instant (ADR 0003 discipline: the domain sets
// timestamps itself, truncated to the millisecond Datetime(6) precision).
func nowUTC() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}
