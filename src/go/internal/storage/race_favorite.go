package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// AutoMigrateRaceFavorites creates/updates the race_favorite table. Called by
// cmd/api at boot; the worker does not need this table.
func (s *Store) AutoMigrateRaceFavorites(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&RaceFavorite{}); err != nil {
		return fmt.Errorf("storage: automigrate race_favorite: %w", err)
	}
	return nil
}

// ToggleRaceFavorite flips the user's favorite mark on one race and reports the
// resulting state. The race must exist and be published — the star only ever
// appears on races the race center surfaces — so a missing or unpublished id
// returns ErrRaceCalendarNotFound (404 at the API) rather than storing a
// favorite nothing will ever show. A favorite on a race that is later
// unpublished can never be un-toggled through this method (the 404 fires
// before the delete); that row is invisible everywhere and is cleaned up only
// by account erasure. That is the accepted cost of silent offboarding.
func (s *Store) ToggleRaceFavorite(ctx context.Context, userID string, raceEventID uint64) (bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return false, err
	}
	var favorited bool
	toggle := func() error {
		return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var event RaceCalendarEvent
			e := tx.Select("id", "published").First(&event, raceEventID).Error
			if errors.Is(e, gorm.ErrRecordNotFound) {
				return ErrRaceCalendarNotFound
			}
			if e != nil {
				return fmt.Errorf("storage: load race for favorite: %w", e)
			}
			if !event.Published {
				return ErrRaceCalendarNotFound
			}
			// Delete-else-insert implements the toggle without a prior SELECT.
			res := tx.Where("user_id = ? AND race_event_id = ?", uid, raceEventID).
				Delete(&RaceFavorite{})
			if res.Error != nil {
				return fmt.Errorf("storage: delete race_favorite: %w", res.Error)
			}
			if res.RowsAffected > 0 {
				favorited = false
				return nil
			}
			row := &RaceFavorite{UserID: uid, RaceEventID: raceEventID, CreatedAt: time.Now().UTC()}
			if err := tx.Create(row).Error; err != nil {
				return fmt.Errorf("storage: create race_favorite: %w", err)
			}
			favorited = true
			return nil
		})
	}
	err = toggle()
	// Two first-tap favorites lock the same empty key range (the delete matches
	// nothing) before either inserts, and InnoDB resolves that race by
	// deadlocking one of them — or by a duplicate-key on the unique index. A
	// retry observes the winner's row and takes the plain delete path.
	if err != nil && isConcurrentInsertRace(err) {
		err = toggle()
	}
	if err != nil {
		return false, err
	}
	return favorited, nil
}

// isConcurrentInsertRace reports whether err is the transient outcome of two
// transactions racing to insert the same not-yet-existing row: InnoDB either
// deadlocks one of them (1213) or the loser's insert hits the winner's
// committed row (1062). Re-running the operation resolves both — the row now
// exists, so the retry takes the lock-on-existing-row path. Shared by the
// favorite toggle and the plan upsert, whose first-write shapes both have it.
func isConcurrentInsertRace(err error) bool {
	n, ok := mysqlErrNo(err)
	return ok && (n == 1213 || n == 1062)
}

// ListRaceFavoriteIDs returns the ids of the user's favorited published races,
// newest favorite first. Unpublished races drop out silently (the offboarding
// decision: a hidden favorite is filtered, not placeholder-rendered), and so do
// rows whose race was deleted outright.
func (s *Store) ListRaceFavoriteIDs(ctx context.Context, userID string) ([]uint64, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var ids []uint64
	err = s.db.WithContext(ctx).Model(&RaceFavorite{}).
		Select("race_favorite.race_event_id").
		Joins("JOIN race_calendar ON race_calendar.id = race_favorite.race_event_id AND race_calendar.published = ?", true).
		Where("race_favorite.user_id = ?", uid).
		Order("race_favorite.created_at DESC, race_favorite.race_event_id DESC").
		Scan(&ids).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list race_favorite: %w", err)
	}
	if ids == nil {
		ids = []uint64{}
	}
	return ids, nil
}
