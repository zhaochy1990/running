// home_city.go persists resident-city detection results (internal/homecity).
// Two tables:
//
//   - user_home_city: the latest Result per user, upserted by every recompute.
//     Deliberately city-granularity only — no centroid is stored, matching the
//     privacy posture that activity locations are inferred, not asked for.
//
//   - user_home_city_history: one row per detected city CHANGE (first
//     detection, relocation, drift, cleared). The recompute is periodic, so the
//     latest table would silently overwrite moves; the history keeps the
//     timeline an operator needs to answer "since when has this user been in
//     Kunming".
package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/zhaochy1990/stride/internal/homecity"
)

// ErrHomeCityNotFound is returned by GetUserHomeCity when no row exists yet.
var ErrHomeCityNotFound = errors.New("storage: user home city row not found")

// UserHomeCity is one user's latest resident-city detection.
type UserHomeCity struct {
	UserID string `gorm:"column:user_id;size:64;not null;primaryKey"`
	// City is the detected resident city ("上海市"); empty with
	// Confidence=none when evidence is insufficient.
	City       string `gorm:"column:city;size:64;not null;default:''"`
	District   string `gorm:"column:district;size:64;not null;default:''"`
	Province   string `gorm:"column:province;size:32;not null;default:''"`
	Confidence string `gorm:"column:confidence;size:8;not null;default:'none'"`
	Source     string `gorm:"column:source;size:8;not null;default:''"`
	// WeightedShare is 0..1 (the detector's fraction of weighted votes).
	WeightedShare float64 `gorm:"column:weighted_share;not null;default:0"`
	VoteCount     int     `gorm:"column:vote_count;not null;default:0"`
	TotalVotes    int     `gorm:"column:total_votes;not null;default:0"`
	Relocated     bool    `gorm:"column:relocated;not null;default:false"`
	PreviousCity  string  `gorm:"column:previous_city;size:64;not null;default:''"`
	RecentCity    string  `gorm:"column:recent_city;size:64;not null;default:''"`
	// SecondaryJSON is the detector's secondary-city list (kind + share),
	// stored as JSON for display; empty when there is none.
	SecondaryJSON string    `gorm:"column:secondary_json;type:json"`
	ComputedAt    time.Time `gorm:"column:computed_at;type:datetime(3);not null"`
	UpdatedAt     time.Time `gorm:"column:updated_at;type:datetime(3);not null"`
}

func (UserHomeCity) TableName() string { return "user_home_city" }

// HomeCityChangeReason explains one history row.
type HomeCityChangeReason string

const (
	// HomeCityChangeNew is the first-ever detection for a user.
	HomeCityChangeNew HomeCityChangeReason = "new"
	// HomeCityChangeRelocated is a change the detector itself flagged
	// (Result.Relocated).
	HomeCityChangeRelocated HomeCityChangeReason = "relocated"
	// HomeCityChangeDrift is a change the detector did not flag — thresholds
	// crossing over time rather than a trailing-window takeover.
	HomeCityChangeDrift HomeCityChangeReason = "drift"
	// HomeCityChangeCleared is a previously detected city dropping back to
	// unknown (e.g. user-deleted history).
	HomeCityChangeCleared HomeCityChangeReason = "cleared"
)

// UserHomeCityHistory is one detected city change.
type UserHomeCityHistory struct {
	ID     uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	UserID string `gorm:"column:user_id;size:64;not null;index:idx_home_city_history_user"`
	// FromCity is the previous city; empty when the previous state was
	// unknown (or no row existed).
	FromCity   string               `gorm:"column:from_city;size:64;not null;default:''"`
	ToCity     string               `gorm:"column:to_city;size:64;not null;default:''"`
	Reason     HomeCityChangeReason `gorm:"column:reason;size:16;not null"`
	ComputedAt time.Time            `gorm:"column:computed_at;type:datetime(3);not null"`
}

func (UserHomeCityHistory) TableName() string { return "user_home_city_history" }

// AutoMigrateHomeCity creates/updates the user_home_city tables. Called by the
// worker (the homecity_recompute pipeline writes them) and safe to call from
// dev tools.
func (s *Store) AutoMigrateHomeCity(ctx context.Context) error {
	for _, model := range []any{&UserHomeCity{}, &UserHomeCityHistory{}} {
		if err := s.db.WithContext(ctx).AutoMigrate(model); err != nil {
			return fmt.Errorf("storage: automigrate %T: %w", model, err)
		}
	}
	return nil
}

// PutUserHomeCity upserts the latest detection and appends a history row when
// the city changed. computedAt is the detection clock (the Result's evaluation
// time); updated_at is stamped now, so a row rewritten with an identical city
// still shows when it was last recomputed.
func (s *Store) PutUserHomeCity(ctx context.Context, userID string, res homecity.Result, computedAt time.Time) (HomeCityChangeReason, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return "", err
	}
	// "[]" (not an empty string) so the JSON column accepts a result without
	// secondary cities.
	secondary := "[]"
	if len(res.Secondary) > 0 {
		encoded, err := json.Marshal(res.Secondary)
		if err != nil {
			return "", fmt.Errorf("storage: encode secondary cities: %w", err)
		}
		secondary = string(encoded)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	computedAt = computedAt.UTC().Truncate(time.Millisecond)

	var reason HomeCityChangeReason
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var prior UserHomeCity
		priorExists := true
		if err := tx.Where("user_id = ?", uid).Take(&prior).Error; err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			priorExists = false
		}

		row := UserHomeCity{
			UserID: uid, City: res.City, District: res.District, Province: res.Province,
			Confidence: string(res.Confidence), Source: res.Source,
			WeightedShare: res.WeightedShare, VoteCount: res.VoteCount, TotalVotes: res.TotalVotes,
			Relocated: res.Relocated, PreviousCity: res.PreviousCity, RecentCity: res.RecentCity,
			SecondaryJSON: secondary, ComputedAt: computedAt, UpdatedAt: now,
		}
		if err := tx.Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "user_id"}},
			DoUpdates: clause.AssignmentColumns([]string{
				"city", "district", "province", "confidence", "source",
				"weighted_share", "vote_count", "total_votes",
				"relocated", "previous_city", "recent_city",
				"secondary_json", "computed_at", "updated_at",
			}),
		}).Create(&row).Error; err != nil {
			return err
		}

		changedFrom := ""
		if priorExists {
			changedFrom = prior.City
		}
		if !priorExists && res.City != "" {
			reason = HomeCityChangeNew
		} else if priorExists && prior.City != res.City {
			switch {
			case res.City == "":
				reason = HomeCityChangeCleared
			case res.Relocated:
				reason = HomeCityChangeRelocated
			default:
				reason = HomeCityChangeDrift
			}
		}
		if reason != "" {
			return tx.Create(&UserHomeCityHistory{
				UserID: uid, FromCity: changedFrom, ToCity: res.City, Reason: reason, ComputedAt: computedAt,
			}).Error
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("storage: put user home city: %w", err)
	}
	return reason, nil
}

// GetUserHomeCity loads one user's latest detection; ErrHomeCityNotFound when
// the recompute has not produced a row yet.
func (s *Store) GetUserHomeCity(ctx context.Context, userID string) (*UserHomeCity, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row UserHomeCity
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).Take(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrHomeCityNotFound
		}
		return nil, err
	}
	return &row, nil
}
