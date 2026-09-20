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
// race_calendar_item tables. Called by the worker (the pipeline that writes
// them) and by the API (the admin surface that reads/writes them).
func (s *Store) AutoMigrateRaceCalendar(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&RaceCalendarEvent{}); err != nil {
		return fmt.Errorf("storage: automigrate race_calendar: %w", err)
	}
	if err := s.db.WithContext(ctx).AutoMigrate(&RaceCalendarItem{}); err != nil {
		return fmt.Errorf("storage: automigrate race_calendar_item: %w", err)
	}
	return nil
}

// raceCalendarUpsertCols are the sync-managed data columns refreshed on a
// conflict, keyed on (source, name, race_date). name_cn is deliberately excluded
// — it is an app-side asset the sync must never overwrite — and created_at keeps
// its first-seen timestamp. origin/admin_overrides are also excluded: an
// existing row keeps its provenance, and a fresh insert takes the values from
// the struct.
var raceCalendarUpsertCols = []string{
	"race_date", "month", "dayofmonth", "country", "province", "city", "label",
	"race_types", "updated_at",
}

// ReplaceRaceCalendarResult reports what one year's sync did.
type ReplaceRaceCalendarResult struct {
	Upserted int
	Deleted  int
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
// data.
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
		keys := make([][]any, len(races))
		for i, r := range races {
			keys[i] = []any{r.Name, r.RaceDate}
		}
		var stale []RaceCalendarEvent
		if err := tx.Where(
			"source = ? AND race_date BETWEEN ? AND ? AND origin = ? AND (admin_overrides IS NULL OR JSON_LENGTH(admin_overrides) = 0) AND (name, race_date) NOT IN ?",
			source, from, to, RaceOriginSync, keys,
		).Find(&stale).Error; err != nil {
			return fmt.Errorf("storage: find stale race_calendar: %w", err)
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

// ReplaceRaceCalendarItemsResult reports how many sync items were written and
// removed across all batches of one sync run.
type ReplaceRaceCalendarItemsResult struct {
	Upserted int
	Deleted  int
}

// ReplaceRaceCalendarItems regenerates the sync-owned items of the named races.
// It is the 中国田协 pipeline's second write, separate from the event merge
// because only that source has item-level data.
//
// For each batch it locates the event by its business key (source, name,
// race_date); a batch with no matching event is skipped. The event's
// origin='sync' items are deleted and the supplied items re-inserted as
// origin='sync'. An item name that collides with an existing origin='manual'
// item is skipped, and no manual item is ever updated or deleted — so an
// administrator's edits survive the next sync. The whole run is one transaction.
func (s *Store) ReplaceRaceCalendarItems(ctx context.Context, source string, batches []RaceCalendarItemBatch) (ReplaceRaceCalendarItemsResult, error) {
	if len(batches) == 0 {
		return ReplaceRaceCalendarItemsResult{}, nil
	}
	now := time.Now().UTC()
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

			var manual []RaceCalendarItem
			if err := tx.Where("race_event_id = ? AND origin = ?", event.ID, RaceOriginManual).Find(&manual).Error; err != nil {
				return fmt.Errorf("storage: read manual race_calendar items: %w", err)
			}
			manualNames := make(map[string]bool, len(manual))
			for _, item := range manual {
				manualNames[item.Name] = true
			}

			del := tx.Where("race_event_id = ? AND origin = ?", event.ID, RaceOriginSync).Delete(&RaceCalendarItem{})
			if del.Error != nil {
				return fmt.Errorf("storage: delete sync race_calendar items: %w", del.Error)
			}
			res.Deleted += int(del.RowsAffected)

			rows := make([]RaceCalendarItem, 0, len(batch.Items))
			seen := make(map[string]bool, len(batch.Items))
			for _, item := range batch.Items {
				name := strings.TrimSpace(item.Name)
				if name == "" || manualNames[name] || seen[name] {
					continue
				}
				seen[name] = true
				rows = append(rows, RaceCalendarItem{
					RaceEventID: event.ID,
					Name:        name,
					Type:        item.Type,
					Origin:      RaceOriginSync,
					UpdatedAt:   now,
				})
			}
			if len(rows) > 0 {
				if err := tx.Create(&rows).Error; err != nil {
					return fmt.Errorf("storage: insert sync race_calendar items: %w", err)
				}
			}
			res.Upserted += len(rows)
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
type RaceCalendarListFilter struct {
	Year    string
	Month   int
	Source  string
	Keyword string
	Page    int
	PerPage int
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

// DeleteRaceCalendarEvent removes a race and its items in one transaction.
// Deleting a missing id returns ErrRaceCalendarNotFound so the API answers 404.
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
