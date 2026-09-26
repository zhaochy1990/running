package storage

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrRaceCalendarNotFound is returned by the single-row admin lookups when no
// race/item matches the id.
var ErrRaceCalendarNotFound = errors.New("storage: race calendar row not found")

// ErrRaceCalendarConflict is returned when an admin write violates a unique key
// (a duplicate business key, or a duplicate item name within one event).
var ErrRaceCalendarConflict = errors.New("storage: race calendar unique conflict")

// AutoMigrateRaceCalendar creates/updates the race_calendar and
// race_calendar_item tables. Called by the worker (the pipeline that writes the
// calendar) and by the API (the admin surface).
func (s *Store) AutoMigrateRaceCalendar(ctx context.Context) error {
	for _, model := range []any{&RaceCalendarEvent{}, &RaceCalendarItem{}} {
		if err := s.db.WithContext(ctx).AutoMigrate(model); err != nil {
			return fmt.Errorf("storage: automigrate %T: %w", model, err)
		}
	}
	return nil
}

// raceCalendarUpsertCols are the sync-managed data columns refreshed on a
// conflict, keyed on (source, name, race_date). name_cn is deliberately excluded
// — it is an app-side asset the sync must never overwrite — and created_at keeps
// its first-seen timestamp. origin/admin_overrides are also excluded: an
// existing row keeps its provenance, and a fresh insert takes the values from
// the struct. The six admin content columns and published are excluded for the
// same reason (the sync never writes them); content_stale IS included so a key
// the upstream re-lists is un-flagged by the same upsert that refreshes the row.
//
// wa_label is excluded too, and for a stronger reason than the rest: it is
// written onto 中国田协 rows by the race_calendar_wa_label step, which no calendar
// mirror owns. Leaving it out of this list is what makes that write survive the
// daily 中国田协 sync — an OnConflict merge would otherwise rebuild the row's
// columns from the upstream struct and blank it.
var raceCalendarUpsertCols = []string{
	"race_date", "month", "dayofmonth", "country", "province", "city", "label",
	"race_types", "updated_at", "content_stale",
}

// raceCalendarItemUpsertCols are the sync-managed item columns refreshed on a
// conflict, keyed on (race_event_id, name) — the item-level counterpart of
// raceCalendarUpsertCols above, and deliberately as narrow. name is the identity
// key so it never updates; origin/admin_overrides are excluded so an existing row
// keeps its provenance; created_at keeps its first-seen timestamp. The ten
// content columns and the three admin-maintained entry fields (start_time /
// entry_fee / quota) are excluded because 中国田协 supplies none of them — the
// sync writing them would blank an administrator's work. content_stale IS
// included so a name the upstream re-lists is un-flagged by the same upsert that
// refreshes the row.
var raceCalendarItemUpsertCols = []string{"type", "updated_at", "content_stale"}

// ReplaceRaceCalendarResult reports what one year's sync did. ContentStale
// counts stale rows that were kept and flagged because they carry
// admin-maintained content.
type ReplaceRaceCalendarResult struct {
	Upserted     int
	Deleted      int
	ContentStale int
}

// ReplaceRaceCalendarYear merges one source's year into race_calendar, keyed on
// (source, name, race_date). It is a per-field merge rather than a blind
// overwrite so administrator corrections survive:
//
//   - For a row that already exists with origin='sync', each field listed in that
//     row's admin_overrides keeps its current value; every other sync-managed
//     field takes the upstream value. name_cn is always kept (existing
//     semantics). The row's origin and override set are preserved.
//   - A missing row is inserted as origin='sync' with no overrides.
//   - A row with origin='manual' whose key happens to collide with an upstream
//     record is left completely untouched (the admin detached it).
//
// After merging, stale rows — rows of that year that upstream no longer lists,
// with origin='sync' and no overrides — are deleted together with their items,
// so the table stays a faithful mirror without ever discarding admin-maintained
// data. A stale row that carries admin-maintained content (any of the six
// content sections, or admin data on any of its items) is NOT deleted: it is
// flagged content_stale and kept, exactly like an overridden row, for an
// administrator to resolve (move the content to the upstream's new row, or
// delete it).
//
// Source on each race is overwritten with the passed value, and Month/DayOfMonth
// are derived from RaceDate (single source of truth). year bounds the
// stale-delete to that calendar year, so older years' history is untouched. An
// empty races slice is a no-op (returns zero counts) rather than a wipe: a
// transient empty upstream response must not clear a populated year.
func (s *Store) ReplaceRaceCalendarYear(ctx context.Context, source, year string, races []RaceCalendarEvent) (ReplaceRaceCalendarResult, error) {
	if len(races) == 0 {
		return ReplaceRaceCalendarResult{}, nil
	}
	now := time.Now().UTC()
	for i := range races {
		races[i].Source = source
		races[i].UpdatedAt = now
		races[i].Month, races[i].DayOfMonth = monthDayOf(races[i].RaceDate)
		races[i].Origin = RaceOriginSync
		races[i].AdminOverrides = nil
	}

	var res ReplaceRaceCalendarResult
	from, to := yearDateRange(year)
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing []RaceCalendarEvent
		if err := tx.Where("source = ? AND race_date BETWEEN ? AND ?", source, from, to).Find(&existing).Error; err != nil {
			return fmt.Errorf("storage: read existing race_calendar: %w", err)
		}
		byKey := make(map[[2]string]RaceCalendarEvent, len(existing))
		for _, row := range existing {
			byKey[[2]string{row.Name, row.RaceDate}] = row
		}

		toUpsert := make([]RaceCalendarEvent, 0, len(races))
		for _, in := range races {
			key := [2]string{in.Name, in.RaceDate}
			prev, ok := byKey[key]
			if !ok {
				toUpsert = append(toUpsert, in)
				continue
			}
			if prev.Origin == RaceOriginManual {
				// An administrator detached this key from the mirror; the sync
				// must neither refresh nor delete it.
				continue
			}
			merged := in
			merged.NameCN = prev.NameCN // sync never overwrites a Chinese name
			over := raceCalendarOverrideSet(prev.AdminOverrides)
			if over["country"] {
				merged.Country = prev.Country
			}
			if over["province"] {
				merged.Province = prev.Province
			}
			if over["city"] {
				merged.City = prev.City
			}
			if over["label"] {
				merged.Label = prev.Label
			}
			if over["race_types"] {
				merged.RaceTypes = prev.RaceTypes
			}
			merged.AdminOverrides = prev.AdminOverrides
			toUpsert = append(toUpsert, merged)
		}

		if len(toUpsert) > 0 {
			if err := tx.Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "source"}, {Name: "name"}, {Name: "race_date"}},
				DoUpdates: clause.AssignmentColumns(raceCalendarUpsertCols),
			}).Create(&toUpsert).Error; err != nil {
				return fmt.Errorf("storage: upsert race_calendar: %w", err)
			}
		}
		res.Upserted = len(toUpsert)

		// Stale rows: the year's sync-owned rows with no override that upstream
		// no longer lists. Two different races can share a name in a year, so the
		// survivor test is the composite (name, race_date) row value, not name
		// alone. Rows with any override (or origin='manual') are never stale.
		// A stale row that carries admin-maintained content is not deleted
		// either — deleting it would destroy admin work the sync knows nothing
		// about — it is flagged content_stale instead (same survivor class as
		// overridden rows) and resolved by an administrator. A published row
		// survives by the same rule even when it has no content: it is visible
		// in the app, so dropping it upstream must not silently unpublish it.
		keys := make([][]any, len(races))
		for i, r := range races {
			keys[i] = []any{r.Name, r.RaceDate}
		}
		var candidates []RaceCalendarEvent
		if err := tx.Where(
			"source = ? AND race_date BETWEEN ? AND ? AND origin = ? AND (admin_overrides IS NULL OR JSON_LENGTH(admin_overrides) = 0) AND (name, race_date) NOT IN ?",
			source, from, to, RaceOriginSync, keys,
		).Find(&candidates).Error; err != nil {
			return fmt.Errorf("storage: find stale race_calendar: %w", err)
		}
		if len(candidates) > 0 {
			candidateIDs := make([]uint64, len(candidates))
			for i, row := range candidates {
				candidateIDs[i] = row.ID
			}
			// An item an administrator has touched counts as content too: the
			// content lives on the item rows now, so ask the rows themselves.
			// ponytail: loads the candidates' items and scans in Go rather than
			// writing a ten-column OR into SQL — the candidate set is small.
			var itemRows []RaceCalendarItem
			if err := tx.Where("race_event_id IN ?", candidateIDs).Find(&itemRows).Error; err != nil {
				return fmt.Errorf("storage: read stale race_calendar item data: %w", err)
			}
			itemDataSet := make(map[uint64]bool, len(itemRows))
			for _, row := range itemRows {
				if row.HasAdminData() {
					itemDataSet[row.RaceEventID] = true
				}
			}
			var stale []RaceCalendarEvent
			var staleContent []RaceCalendarEvent
			for _, row := range candidates {
				if itemDataSet[row.ID] || row.HasContent() || row.Published {
					staleContent = append(staleContent, row)
				} else {
					stale = append(stale, row)
				}
			}
			if len(stale) > 0 {
				ids := make([]uint64, len(stale))
				for i, row := range stale {
					ids[i] = row.ID
				}
				if err := tx.Where("race_event_id IN ?", ids).Delete(&RaceCalendarItem{}).Error; err != nil {
					return fmt.Errorf("storage: delete stale race_calendar items: %w", err)
				}
				if err := tx.Where("id IN ?", ids).Delete(&RaceCalendarEvent{}).Error; err != nil {
					return fmt.Errorf("storage: delete stale race_calendar: %w", err)
				}
				res.Deleted = len(stale)
			}
			if len(staleContent) > 0 {
				ids := make([]uint64, len(staleContent))
				for i, row := range staleContent {
					ids[i] = row.ID
				}
				if err := tx.Model(&RaceCalendarEvent{}).Where("id IN ?", ids).
					Updates(map[string]any{"content_stale": true, "updated_at": now}).Error; err != nil {
					return fmt.Errorf("storage: flag stale race_calendar content: %w", err)
				}
				res.ContentStale = len(staleContent)
			}
		}
		return nil
	})
	if err != nil {
		return ReplaceRaceCalendarResult{}, err
	}
	return res, nil
}

// RaceCalendarItemBatch pairs one race's business key with the upstream items
// the sync should mirror for it.
type RaceCalendarItemBatch struct {
	Name     string
	RaceDate string
	Items    []RaceCalendarItem
}

// ReplaceRaceCalendarItemsResult reports what one sync run did across all
// batches. ContentStale counts items that were kept and flagged because they
// carry admin-maintained data instead of being deleted.
type ReplaceRaceCalendarItemsResult struct {
	Upserted     int
	Deleted      int
	ContentStale int
}

// ReplaceRaceCalendarItems merges the sync-owned items of the named races,
// keyed on (race_event_id, name). It is the 中国田协 pipeline's second write,
// separate from the event merge because only that source has item-level data —
// and it is a per-field merge for the same reason the event merge is: so
// administrator corrections survive.
//
// For each batch it locates the event by its business key (source, name,
// race_date); a batch with no matching event is skipped, as is an event an
// administrator detached (origin='manual'). Otherwise:
//
//   - An item that already exists with origin='sync' keeps the current value of
//     each field listed in its admin_overrides and takes the upstream value for
//     every other sync-managed field (in practice: type). Its origin and
//     override set survive, and so does everything the sync never writes — the
//     ten content columns and start_time/entry_fee/quota.
//   - A missing item is inserted as origin='sync' with no overrides.
//   - A detached item (origin='manual') is left completely untouched: neither
//     refreshed nor stale-deleted.
//
// The event's sync-owned items the upstream no longer lists are then resolved
// exactly like stale events — an item carrying nothing admin-maintained is
// deleted, one carrying content or overrides is flagged content_stale and kept
// for an administrator to resolve. The whole run is one transaction.
func (s *Store) ReplaceRaceCalendarItems(ctx context.Context, source string, batches []RaceCalendarItemBatch) (ReplaceRaceCalendarItemsResult, error) {
	if len(batches) == 0 {
		return ReplaceRaceCalendarItemsResult{}, nil
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var res ReplaceRaceCalendarItemsResult
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, batch := range batches {
			var event RaceCalendarEvent
			err := tx.Where("source = ? AND name = ? AND race_date = ?", source, batch.Name, batch.RaceDate).First(&event).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			if err != nil {
				return fmt.Errorf("storage: locate race_calendar for items: %w", err)
			}
			if event.Origin == RaceOriginManual {
				// An administrator detached this event from the mirror; its items
				// must not be regenerated either.
				continue
			}

			var existing []RaceCalendarItem
			if err := tx.Where("race_event_id = ?", event.ID).Find(&existing).Error; err != nil {
				return fmt.Errorf("storage: read race_calendar items: %w", err)
			}
			byName := make(map[string]RaceCalendarItem, len(existing))
			for _, row := range existing {
				byName[row.Name] = row
			}

			toUpsert := make([]RaceCalendarItem, 0, len(batch.Items))
			seen := make(map[string]bool, len(batch.Items))
			for _, item := range batch.Items {
				name := strings.TrimSpace(item.Name)
				if name == "" || seen[name] {
					continue
				}
				seen[name] = true
				prev, ok := byName[name]
				if !ok {
					toUpsert = append(toUpsert, RaceCalendarItem{
						RaceEventID: event.ID,
						Name:        name,
						Type:        item.Type,
						Origin:      RaceOriginSync,
						CreatedAt:   now,
						UpdatedAt:   now,
					})
					continue
				}
				if prev.Origin == RaceOriginManual {
					// An administrator detached this item; the sync must neither
					// refresh nor delete it.
					continue
				}
				merged := prev
				if !raceCalendarOverrideSet(prev.AdminOverrides)["type"] {
					merged.Type = item.Type
				}
				merged.UpdatedAt = now
				// The upstream lists this name again, so it is no longer stale —
				// same clear the event merge performs via the upsert column.
				merged.ContentStale = false
				toUpsert = append(toUpsert, merged)
			}

			if len(toUpsert) > 0 {
				if err := tx.Clauses(clause.OnConflict{
					Columns:   []clause.Column{{Name: "race_event_id"}, {Name: "name"}},
					DoUpdates: clause.AssignmentColumns(raceCalendarItemUpsertCols),
				}).Create(&toUpsert).Error; err != nil {
					return fmt.Errorf("storage: upsert race_calendar items: %w", err)
				}
			}
			res.Upserted += len(toUpsert)

			// Stale items: this event's sync-owned items the upstream no longer
			// lists. Same survivor rule as stale events — admin data keeps the row,
			// flagged rather than deleted.
			var staleIDs, staleContentIDs []uint64
			for _, row := range existing {
				if seen[row.Name] || row.Origin == RaceOriginManual {
					continue
				}
				if row.HasAdminData() {
					staleContentIDs = append(staleContentIDs, row.ID)
				} else {
					staleIDs = append(staleIDs, row.ID)
				}
			}
			if len(staleIDs) > 0 {
				if err := tx.Where("id IN ?", staleIDs).Delete(&RaceCalendarItem{}).Error; err != nil {
					return fmt.Errorf("storage: delete stale race_calendar items: %w", err)
				}
				res.Deleted += len(staleIDs)
			}
			if len(staleContentIDs) > 0 {
				if err := tx.Model(&RaceCalendarItem{}).Where("id IN ?", staleContentIDs).
					Updates(map[string]any{"content_stale": true, "updated_at": now}).Error; err != nil {
					return fmt.Errorf("storage: flag stale race_calendar item content: %w", err)
				}
				res.ContentStale += len(staleContentIDs)
			}
		}
		return nil
	})
	if err != nil {
		return ReplaceRaceCalendarItemsResult{}, err
	}
	return res, nil
}

// raceCalendarOverrideSet turns an override name list into a lookup set.
func raceCalendarOverrideSet(fields []string) map[string]bool {
	set := make(map[string]bool, len(fields))
	for _, f := range fields {
		set[f] = true
	}
	return set
}

// ─── admin read/write surface ────────────────────────────────────────────────

// RaceCalendarListFilter bounds and orders the admin race list. Year and Month
// are optional ("" / 0 mean no bound), Keyword matches name or name_cn as a
// substring, and Page/PerPage are 1-based (PerPage is clamped by the caller).
// ContentStale selects only the rows the stale-delete kept and flagged.
// Published is tri-state: nil means no bound, so the admin can list all races,
// only the published ones, or only the unpublished ones.
type RaceCalendarListFilter struct {
	Year         string
	Month        int
	Source       string
	Keyword      string
	ContentStale bool
	Published    *bool
	Page         int
	PerPage      int
}

// MonthDayOf is the exported form of the write-time derivation, used by the API
// when an administrator edits race_date.
func MonthDayOf(raceDate string) (int8, int8) { return monthDayOf(raceDate) }

// ListRaceCalendarEvents returns one page of races ordered by race_date (then
// name) plus the total row count matching the filter.
func (s *Store) ListRaceCalendarEvents(ctx context.Context, f RaceCalendarListFilter) ([]RaceCalendarEvent, int64, error) {
	// Build the filtered scope independently for the count and the page, so the
	// Count() SELECT does not leak into the row query.
	scope := func() *gorm.DB {
		query := s.db.WithContext(ctx).Model(&RaceCalendarEvent{})
		if f.Year != "" {
			from, to := yearDateRange(f.Year)
			query = query.Where("race_date BETWEEN ? AND ?", from, to)
		}
		if f.Month > 0 {
			query = query.Where("month = ?", f.Month)
		}
		if f.Source != "" {
			query = query.Where("source = ?", f.Source)
		}
		if kw := strings.TrimSpace(f.Keyword); kw != "" {
			like := "%" + kw + "%"
			query = query.Where("name LIKE ? OR name_cn LIKE ?", like, like)
		}
		if f.ContentStale {
			query = query.Where("content_stale = ?", true)
		}
		if f.Published != nil {
			query = query.Where("published = ?", *f.Published)
		}
		return query
	}

	var total int64
	if err := scope().Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("storage: count race_calendar: %w", err)
	}

	page, perPage := f.Page, f.PerPage
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 20
	}
	var rows []RaceCalendarEvent
	if err := scope().Order("race_date ASC, name ASC, id ASC").
		Offset((page - 1) * perPage).Limit(perPage).
		Find(&rows).Error; err != nil {
		return nil, 0, fmt.Errorf("storage: list race_calendar: %w", err)
	}
	return rows, total, nil
}

// GetRaceCalendarEvent returns one race by internal id, or
// ErrRaceCalendarNotFound.
func (s *Store) GetRaceCalendarEvent(ctx context.Context, id uint64) (*RaceCalendarEvent, error) {
	var row RaceCalendarEvent
	err := s.db.WithContext(ctx).First(&row, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrRaceCalendarNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("storage: get race_calendar: %w", err)
	}
	return &row, nil
}

// CreateRaceCalendarEvent inserts an administrator-authored race. Identity
// fields (source/name/race_date) must already be set; a duplicate business key
// surfaces as a unique-constraint error the API maps to 409.
func (s *Store) CreateRaceCalendarEvent(ctx context.Context, row *RaceCalendarEvent) error {
	if row.CreatedAt.IsZero() {
		row.CreatedAt = time.Now().UTC()
	}
	row.UpdatedAt = row.CreatedAt
	if err := s.db.WithContext(ctx).Create(row).Error; err != nil {
		if isDuplicateKey(err) {
			return ErrRaceCalendarConflict
		}
		return fmt.Errorf("storage: create race_calendar: %w", err)
	}
	return nil
}

// UpdateRaceCalendarEvent saves every mutable field of an existing race.
func (s *Store) UpdateRaceCalendarEvent(ctx context.Context, row *RaceCalendarEvent) error {
	row.UpdatedAt = time.Now().UTC()
	if err := s.db.WithContext(ctx).Save(row).Error; err != nil {
		if isDuplicateKey(err) {
			return ErrRaceCalendarConflict
		}
		return fmt.Errorf("storage: update race_calendar: %w", err)
	}
	return nil
}

// DeleteRaceCalendarEvent removes a race and its items (item content lives on
// those rows) in one transaction. Deleting a missing id returns
// ErrRaceCalendarNotFound so the API answers 404.
func (s *Store) DeleteRaceCalendarEvent(ctx context.Context, id uint64) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Where("id = ?", id).Delete(&RaceCalendarEvent{})
		if res.Error != nil {
			return fmt.Errorf("storage: delete race_calendar: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			return ErrRaceCalendarNotFound
		}
		if err := tx.Where("race_event_id = ?", id).Delete(&RaceCalendarItem{}).Error; err != nil {
			return fmt.Errorf("storage: delete race_calendar items: %w", err)
		}
		return nil
	})
}

// ListRaceCalendarItems returns an event's items ordered by id (insertion
// order), not by name, so manual additions keep a stable position.
func (s *Store) ListRaceCalendarItems(ctx context.Context, eventID uint64) ([]RaceCalendarItem, error) {
	var rows []RaceCalendarItem
	if err := s.db.WithContext(ctx).Where("race_event_id = ?", eventID).Order("id ASC").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list race_calendar_item: %w", err)
	}
	return rows, nil
}

// GetRaceCalendarItem returns one item by internal id, or
// ErrRaceCalendarNotFound.
func (s *Store) GetRaceCalendarItem(ctx context.Context, id uint64) (*RaceCalendarItem, error) {
	var row RaceCalendarItem
	err := s.db.WithContext(ctx).First(&row, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrRaceCalendarNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("storage: get race_calendar_item: %w", err)
	}
	return &row, nil
}

// CreateRaceCalendarItem inserts an administrator-authored item.
func (s *Store) CreateRaceCalendarItem(ctx context.Context, row *RaceCalendarItem) error {
	if row.CreatedAt.IsZero() {
		row.CreatedAt = time.Now().UTC()
	}
	row.UpdatedAt = row.CreatedAt
	if err := s.db.WithContext(ctx).Create(row).Error; err != nil {
		if isDuplicateKey(err) {
			return ErrRaceCalendarConflict
		}
		return fmt.Errorf("storage: create race_calendar_item: %w", err)
	}
	return nil
}

// UpdateRaceCalendarItem saves every mutable field of an existing item.
func (s *Store) UpdateRaceCalendarItem(ctx context.Context, row *RaceCalendarItem) error {
	row.UpdatedAt = time.Now().UTC()
	if err := s.db.WithContext(ctx).Save(row).Error; err != nil {
		if isDuplicateKey(err) {
			return ErrRaceCalendarConflict
		}
		return fmt.Errorf("storage: update race_calendar_item: %w", err)
	}
	return nil
}

// DeleteRaceCalendarItem removes one item, or reports ErrRaceCalendarNotFound.
func (s *Store) DeleteRaceCalendarItem(ctx context.Context, id uint64) error {
	res := s.db.WithContext(ctx).Delete(&RaceCalendarItem{}, id)
	if res.Error != nil {
		return fmt.Errorf("storage: delete race_calendar_item: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return ErrRaceCalendarNotFound
	}
	return nil
}

// MoveRaceContent copies the six event content columns and every item's
// admin-maintained data from the source event to the target event, then deletes
// the source event (its items go with it). It is the administrator's resolution
// for a content_stale row: the upstream renamed/rescheduled the race and now
// lists a fresh row; the content moves to that row and the stale row disappears.
//
// Item data moves by name: a source item whose name matches a target item lands
// on that row (keeping the target's origin, so it keeps following the mirror —
// only its admin-maintained values are overwritten). A source item the target
// does not have is recreated on the target as origin='manual', so nothing an
// administrator wrote is dropped.
//
// The move refuses (ErrRaceContentConflict) when the target already carries
// admin data of its own — the admin decides which side wins, the storage never
// merges.
func (s *Store) MoveRaceContent(ctx context.Context, sourceEventID, targetEventID uint64) error {
	now := nowUTC()
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
		var targetItems []RaceCalendarItem
		if err := tx.Where("race_event_id = ?", target.ID).Find(&targetItems).Error; err != nil {
			return fmt.Errorf("storage: read move target items: %w", err)
		}
		for _, item := range targetItems {
			if item.HasAdminData() {
				return ErrRaceContentConflict
			}
		}

		// Copy the columns through the model (serializer applies on Save only).
		target.PartitionRule = source.PartitionRule
		target.SignupTimeline = source.SignupTimeline
		target.SignupChannels = source.SignupChannels
		target.PacketPickup = source.PacketPickup
		target.Climate = source.Climate
		target.WeatherWindows = source.WeatherWindows
		target.ContentStale = false
		target.UpdatedAt = now
		if err := tx.Save(&target).Error; err != nil {
			return fmt.Errorf("storage: move race content columns: %w", err)
		}

		var sourceItems []RaceCalendarItem
		if err := tx.Where("race_event_id = ?", source.ID).Find(&sourceItems).Error; err != nil {
			return fmt.Errorf("storage: read move source items: %w", err)
		}
		targetByName := make(map[string]*RaceCalendarItem, len(targetItems))
		for i := range targetItems {
			targetByName[targetItems[i].Name] = &targetItems[i]
		}
		for _, src := range sourceItems {
			if !src.HasAdminData() {
				// Nothing an administrator wrote: the mirror rows regenerate
				// themselves, no need to carry them over.
				continue
			}
			dst, ok := targetByName[src.Name]
			if !ok {
				row := src
				row.ID = 0
				row.RaceEventID = target.ID
				row.Origin = RaceOriginManual
				row.ContentStale = false
				row.CreatedAt, row.UpdatedAt = now, now
				if err := tx.Create(&row).Error; err != nil {
					return fmt.Errorf("storage: recreate moved race item: %w", err)
				}
				continue
			}
			copyRaceItemAdminData(dst, src)
			dst.ContentStale = false
			dst.UpdatedAt = now
			if err := tx.Save(dst).Error; err != nil {
				return fmt.Errorf("storage: move race item data: %w", err)
			}
		}

		// Delete the source event; its items go with it.
		if err := tx.Where("id = ?", source.ID).Delete(&RaceCalendarEvent{}).Error; err != nil {
			return fmt.Errorf("storage: delete moved source: %w", err)
		}
		if err := tx.Where("race_event_id = ?", source.ID).Delete(&RaceCalendarItem{}).Error; err != nil {
			return fmt.Errorf("storage: delete moved source items: %w", err)
		}
		return nil
	})
}

// copyRaceItemAdminData moves every administrator-owned value from src onto dst:
// the entry fields the upstream never supplies, the ten content columns and the
// field overrides. dst keeps its own identity (id/name/type/origin), so a sync
// item stays on the mirror.
func copyRaceItemAdminData(dst *RaceCalendarItem, src RaceCalendarItem) {
	dst.StartTime, dst.EntryFee, dst.Quota = src.StartTime, src.EntryFee, src.Quota
	dst.AdminOverrides = src.AdminOverrides
	dst.DistanceKm = src.DistanceKm
	dst.StartPoint = src.StartPoint
	dst.FinishPoint = src.FinishPoint
	dst.TotalAscentM = src.TotalAscentM
	dst.ElevationPoints = src.ElevationPoints
	dst.AidStations = src.AidStations
	dst.Cutoffs = src.Cutoffs
	dst.Prizes = src.Prizes
	dst.Reputation = src.Reputation
	dst.Photos = src.Photos
}

// monthDayOf parses a "2006-01-02" calendar date into its month and day of
// month. An unparseable date yields (0, 0) rather than failing the whole sync
// (upstream always sends well-formed dates; a 0 is a visible data anomaly).
func monthDayOf(raceDate string) (int8, int8) {
	t, err := time.Parse("2006-01-02", raceDate)
	if err != nil {
		return 0, 0
	}
	return int8(t.Month()), int8(t.Day())
}

// yearDateRange returns the inclusive calendar-date range of a "yyyy" year,
// used to bound the stale-delete to the year being synced.
func yearDateRange(year string) (string, string) {
	return year + "-01-01", year + "-12-31"
}
