package storage

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// ErrUserCustomRaceNotFound is returned when a custom-race write targets an id
// that does not exist or belongs to another user — both are the same 404 to
// the caller (the API never reveals other users' rows).
var ErrUserCustomRaceNotFound = errors.New("storage: user custom race row not found")

// AutoMigrateUserCustomRaces creates/updates the user_custom_race table.
// Called by cmd/api at boot; the worker does not need this table.
func (s *Store) AutoMigrateUserCustomRaces(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&UserCustomRace{}); err != nil {
		return fmt.Errorf("storage: automigrate user_custom_race: %w", err)
	}
	return nil
}

// CreateUserCustomRace inserts one row for the user. State must already be
// validated (IsCustomRaceState); the handler owns vocabulary checks.
func (s *Store) CreateUserCustomRace(ctx context.Context, row *UserCustomRace) error {
	uid, err := canonicalUserID(row.UserID)
	if err != nil {
		return err
	}
	row.UserID = uid
	now := time.Now().UTC()
	row.CreatedAt, row.UpdatedAt = now, now
	if err := s.db.WithContext(ctx).Create(row).Error; err != nil {
		return fmt.Errorf("storage: create user_custom_race: %w", err)
	}
	return nil
}

// UpdateUserCustomRace applies a full update (every editable field, zeroed
// optionals included — the PUT「全量更新」semantics) to the user's row with the
// given id. A missing id or another user's id is ErrUserCustomRaceNotFound.
// The returned row is re-read so the response carries the stored timestamps.
func (s *Store) UpdateUserCustomRace(ctx context.Context, userID string, upd *UserCustomRace) (*UserCustomRace, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	res := s.db.WithContext(ctx).Model(&UserCustomRace{}).
		Where("id = ? AND user_id = ?", upd.ID, uid).
		Updates(map[string]any{
			"name": upd.Name, "race_date": upd.RaceDate, "item_type": upd.ItemType,
			"distance_km": upd.DistanceKm, "ascent_m": upd.AscentM,
			"city": upd.City, "website": upd.Website, "note": upd.Note,
			"state": upd.State, "hotel": upd.Hotel, "transit": upd.Transit,
		})
	if res.Error != nil {
		return nil, fmt.Errorf("storage: update user_custom_race: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return nil, ErrUserCustomRaceNotFound
	}
	var out UserCustomRace
	if err := s.db.WithContext(ctx).First(&out, upd.ID).Error; err != nil {
		return nil, fmt.Errorf("storage: reload user_custom_race: %w", err)
	}
	return &out, nil
}

// DeleteUserCustomRace physically removes the user's row with the given id,
// reporting ErrUserCustomRaceNotFound when there is nothing to delete.
func (s *Store) DeleteUserCustomRace(ctx context.Context, userID string, id uint64) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	res := s.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", id, uid).
		Delete(&UserCustomRace{})
	if res.Error != nil {
		return fmt.Errorf("storage: delete user_custom_race: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return ErrUserCustomRaceNotFound
	}
	return nil
}

// ListUserCustomRaces returns the user's rows ordered by race_date ascending
// (id as the tiebreaker). The finished-sinks-to-bottom layering of the
// my-races aggregate is an API-layer concern (it also merges the official
// plans), so this stays a plain date sort.
func (s *Store) ListUserCustomRaces(ctx context.Context, userID string) ([]UserCustomRace, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []UserCustomRace
	if err := s.db.WithContext(ctx).
		Where("user_id = ?", uid).
		Order("race_date ASC, id ASC").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list user_custom_race: %w", err)
	}
	return rows, nil
}
