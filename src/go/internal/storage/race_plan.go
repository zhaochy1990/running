package storage

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrRacePlanNotFound is returned when a plan delete targets a row that does
// not exist (the API answers 404).
var ErrRacePlanNotFound = errors.New("storage: race plan row not found")

// AutoMigrateRacePlans creates/updates the race_plan table. Called by cmd/api
// at boot; the worker does not need this table.
func (s *Store) AutoMigrateRacePlans(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&RacePlan{}); err != nil {
		return fmt.Errorf("storage: automigrate race_plan: %w", err)
	}
	return nil
}

// RacePlanUpsert is the write shape of the 报名 selector submission: the
// signed-up 项目 and the machine state arrive together, while the two travel
// booleans are pointers so an absent key keeps the stored value (the selector
// must not wipe checkboxes the runner already ticked on the plan card).
type RacePlanUpsert struct {
	UserID      string
	RaceEventID uint64
	ItemType    string
	State       string
	Hotel       *bool
	Transit     *bool
}

// UpsertRacePlan creates or updates the user's single plan for one race (the
// UNIQUE(user, event) row). Like the favorite toggle it refuses a race that
// does not exist or is unpublished with ErrRaceCalendarNotFound. The returned
// row carries the merged fields and fresh timestamps.
func (s *Store) UpsertRacePlan(ctx context.Context, up RacePlanUpsert) (*RacePlan, error) {
	uid, err := canonicalUserID(up.UserID)
	if err != nil {
		return nil, err
	}
	var out *RacePlan
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var event RaceCalendarEvent
		e := tx.Select("id", "published").First(&event, up.RaceEventID).Error
		if errors.Is(e, gorm.ErrRecordNotFound) {
			return ErrRaceCalendarNotFound
		}
		if e != nil {
			return fmt.Errorf("storage: load race for plan: %w", e)
		}
		if !event.Published {
			return ErrRaceCalendarNotFound
		}

		var cur RacePlan
		e = tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ? AND race_event_id = ?", uid, up.RaceEventID).
			First(&cur).Error
		now := time.Now().UTC()
		if errors.Is(e, gorm.ErrRecordNotFound) {
			row := RacePlan{
				UserID: uid, RaceEventID: up.RaceEventID,
				ItemType: up.ItemType, State: up.State,
				CreatedAt: now, UpdatedAt: now,
			}
			if up.Hotel != nil {
				row.Hotel = *up.Hotel
			}
			if up.Transit != nil {
				row.Transit = *up.Transit
			}
			if err := tx.Create(&row).Error; err != nil {
				return fmt.Errorf("storage: create race_plan: %w", err)
			}
			out = &row
			return nil
		}
		if e != nil {
			return fmt.Errorf("storage: load race_plan: %w", e)
		}
		cur.ItemType = up.ItemType
		cur.State = up.State
		if up.Hotel != nil {
			cur.Hotel = *up.Hotel
		}
		if up.Transit != nil {
			cur.Transit = *up.Transit
		}
		cur.UpdatedAt = now
		if err := tx.Save(&cur).Error; err != nil {
			return fmt.Errorf("storage: update race_plan: %w", err)
		}
		out = &cur
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteRacePlan removes the user's plan for one race (the 未报名/取消追踪 action
// in the 报名 selector), reporting ErrRacePlanNotFound when there is nothing to
// delete.
func (s *Store) DeleteRacePlan(ctx context.Context, userID string, raceEventID uint64) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	res := s.db.WithContext(ctx).
		Where("user_id = ? AND race_event_id = ?", uid, raceEventID).
		Delete(&RacePlan{})
	if res.Error != nil {
		return fmt.Errorf("storage: delete race_plan: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return ErrRacePlanNotFound
	}
	return nil
}

// RacePlanWithRace pairs a plan row with the race it tracks. Race is nil when
// the race_calendar row was deleted outright — deleted and unpublished are the
// same offboarded state to the reader.
type RacePlanWithRace struct {
	Plan RacePlan
	Race *RaceCalendarEvent
}

// Offboarded reports whether this plan's race no longer surfaces in the race
// center (unpublished or deleted). Lost plans never reach the caller —
// ListRacePlans drops them below — so this is true only for
// registered/won/confirmed rows the「我的赛事」page renders as 已下架 placeholder
// cards.
func (row RacePlanWithRace) Offboarded() bool {
	return row.Race == nil || !row.Race.Published
}

// ListRacePlans returns the user's plans joined to their races, ordered by race
// date ascending (soonest first; plans whose race row is gone sort last). The
// offboarding layering lives here, not in the handler: a lost plan whose race is
// unpublished or deleted is silently dropped — it records nothing the runner can
// act on — while registered/won/confirmed plans survive with Offboarded()=true.
func (s *Store) ListRacePlans(ctx context.Context, userID string) ([]RacePlanWithRace, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var plans []RacePlan
	if err := s.db.WithContext(ctx).
		Where("user_id = ?", uid).
		Order("race_event_id ASC").
		Find(&plans).Error; err != nil {
		return nil, fmt.Errorf("storage: list race_plan: %w", err)
	}
	if len(plans) == 0 {
		return []RacePlanWithRace{}, nil
	}
	ids := make([]uint64, 0, len(plans))
	for _, p := range plans {
		ids = append(ids, p.RaceEventID)
	}
	var events []RaceCalendarEvent
	if err := s.db.WithContext(ctx).
		Where("id IN ?", ids).
		Find(&events).Error; err != nil {
		return nil, fmt.Errorf("storage: join races for race_plan: %w", err)
	}
	byID := make(map[uint64]*RaceCalendarEvent, len(events))
	for i := range events {
		byID[events[i].ID] = &events[i]
	}

	out := make([]RacePlanWithRace, 0, len(plans))
	for _, p := range plans {
		race := byID[p.RaceEventID] // nil when the race row is gone
		if p.State == RacePlanStateLost && (race == nil || !race.Published) {
			continue
		}
		out = append(out, RacePlanWithRace{Plan: p, Race: race})
	}
	sort.SliceStable(out, func(i, j int) bool {
		di, dj := raceSortDate(out[i].Race), raceSortDate(out[j].Race)
		if di != dj {
			return di < dj
		}
		return out[i].Plan.RaceEventID < out[j].Plan.RaceEventID
	})
	return out, nil
}

// raceSortDate is the ordering key for the plan list: the race's date, with
// races whose row is gone (no date to sort by) pushed to the end.
func raceSortDate(race *RaceCalendarEvent) string {
	if race == nil {
		return "9999-99-99"
	}
	return race.RaceDate
}
