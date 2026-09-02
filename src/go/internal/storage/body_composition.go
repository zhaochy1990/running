package storage

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type BodyCompositionValidationError struct{ Message string }

func (e *BodyCompositionValidationError) Error() string { return e.Message }

// AutoMigrateBodyComposition creates or reconciles the two body-composition
// tables (scans + per-segment breakdown). It only runs on the API server, not
// the worker — body composition is user-entered, not watch-synced.
func (s *Store) AutoMigrateBodyComposition(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(
		&BodyCompositionScanRecord{},
		&BodyCompositionSegmentRecord{},
	); err != nil {
		return fmt.Errorf("storage: automigrate body composition: %w", err)
	}
	return nil
}

// ─── Validation ─────────────────────────────────────────────────────────────

var scanDateRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func validateBodyCompositionScan(scan *BodyCompositionScanRecord) error {
	if !scanDateRE.MatchString(scan.ScanDate) {
		return &BodyCompositionValidationError{Message: "scan_date must be ISO date YYYY-MM-DD"}
	}
	if scan.WeightKg < 30 || scan.WeightKg > 150 {
		return &BodyCompositionValidationError{Message: "weight_kg out of range [30, 150]"}
	}
	if scan.BodyFatPct < 3 || scan.BodyFatPct > 50 {
		return &BodyCompositionValidationError{Message: "body_fat_pct out of range [3, 50]"}
	}
	if scan.SmmKg < 10 || scan.SmmKg > 60 {
		return &BodyCompositionValidationError{Message: "smm_kg out of range [10, 60]"}
	}
	if scan.FatMassKg < 0 || scan.FatMassKg > 80 {
		return &BodyCompositionValidationError{Message: "fat_mass_kg out of range [0, 80]"}
	}
	if scan.VisceralFatLevel < 1 || scan.VisceralFatLevel > 20 {
		return &BodyCompositionValidationError{Message: "visceral_fat_level must be int in [1, 20]"}
	}
	return nil
}

func validateBodyCompositionSegments(segments []BodyCompositionSegmentRecord) error {
	if len(segments) == 0 {
		return nil
	}
	if len(segments) != 5 {
		return &BodyCompositionValidationError{Message: "segments must be omitted, empty, or a list of 5 entries"}
	}
	names := map[string]bool{}
	for _, seg := range segments {
		if !AllBodySegments[seg.Segment] {
			return &BodyCompositionValidationError{
				Message: fmt.Sprintf("segment must be one of the 5 standard segments, got %q", seg.Segment),
			}
		}
		if names[seg.Segment] {
			return &BodyCompositionValidationError{
				Message: fmt.Sprintf("duplicate segment: %s", seg.Segment),
			}
		}
		names[seg.Segment] = true
		if seg.LeanMassKg < 0 || seg.LeanMassKg > 40 {
			return &BodyCompositionValidationError{
				Message: fmt.Sprintf("%s: lean_mass_kg out of range [0, 40]", seg.Segment),
			}
		}
		if seg.FatMassKg < 0 || seg.FatMassKg > 30 {
			return &BodyCompositionValidationError{
				Message: fmt.Sprintf("%s: fat_mass_kg out of range [0, 30]", seg.Segment),
			}
		}
	}
	return nil
}

// ─── Reads ──────────────────────────────────────────────────────────────────

// ListBodyCompositionScans returns scans newest-first, optionally limited to
// the most recent `days` days. Segments are preloaded.
func (s *Store) ListBodyCompositionScans(ctx context.Context, userID string, days int) ([]BodyCompositionScanRecord, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []BodyCompositionScanRecord
	q := s.db.WithContext(ctx).
		Preload("Segments").
		Where("user_id = ?", uid).
		Order("scan_date DESC")
	if days > 0 {
		// Compute the cutoff date using a Shanghai-day-aware approach:
		// scan_date is YYYY-MM-DD varchar, so we use DATE_SUB(CURDATE(), ...)
		// on the server. The Python path uses "date('now', '-N days')" in
		// SQLite which returns UTC date; we use MySQL CURDATE() which follows
		// the server timezone. In practice both sides track the same
		// Shanghai-day calendar (migration target) so this is consistent.
		q = q.Where("scan_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)", days)
	}
	if err := q.Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// GetBodyCompositionScan returns a single scan (with segments) by date, or
// gorm.ErrRecordNotFound if no scan exists on that date for the user.
func (s *Store) GetBodyCompositionScan(ctx context.Context, userID, scanDate string) (*BodyCompositionScanRecord, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row BodyCompositionScanRecord
	if err := s.db.WithContext(ctx).
		Preload("Segments", func(db *gorm.DB) *gorm.DB {
			return db.Order("segment")
		}).
		Where("user_id = ? AND scan_date = ?", uid, scanDate).
		Take(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

// LatestBodyCompositionScan returns the most recent scan (with segments), or
// gorm.ErrRecordNotFound when the user has none.
func (s *Store) LatestBodyCompositionScan(ctx context.Context, userID string) (*BodyCompositionScanRecord, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row BodyCompositionScanRecord
	if err := s.db.WithContext(ctx).
		Preload("Segments", func(db *gorm.DB) *gorm.DB {
			return db.Order("segment")
		}).
		Where("user_id = ?", uid).
		Order("scan_date DESC").
		Take(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

// PreviousBodyCompositionScan returns the most recent scan strictly before
// beforeDate, or gorm.ErrRecordNotFound when none exists. Used for delta
// computation in the summary endpoint.
func (s *Store) PreviousBodyCompositionScan(ctx context.Context, userID, beforeDate string) (*BodyCompositionScanRecord, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row BodyCompositionScanRecord
	if err := s.db.WithContext(ctx).
		Preload("Segments", func(db *gorm.DB) *gorm.DB {
			return db.Order("segment")
		}).
		Where("user_id = ? AND scan_date < ?", uid, beforeDate).
		Order("scan_date DESC").
		Take(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

// HasBodyComposition returns true if the user has at least one scan. Used by
// the weekly-plan summary to populate has_body_composition (currently
// hardcoded false in weekly_plan.go).
func (s *Store) HasBodyComposition(ctx context.Context, userID string) (bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return false, err
	}
	var count int64
	if err := s.db.WithContext(ctx).
		Model(&BodyCompositionScanRecord{}).
		Where("user_id = ?", uid).
		Limit(1).
		Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

// ─── Write ──────────────────────────────────────────────────────────────────

// UpsertBodyCompositionScan inserts or replaces a scan keyed by
// (user_id, scan_date). When segments are provided, all existing segments for
// the scan are deleted and re-inserted atomically (same as Python's
// DELETE + INSERT pattern). Returns the persisted scan with segments and
// generated IDs.
func (s *Store) UpsertBodyCompositionScan(ctx context.Context, userID string, input *BodyCompositionScanRecord) (*BodyCompositionScanRecord, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	input.UserID = uid
	if err := validateBodyCompositionScan(input); err != nil {
		return nil, err
	}
	if err := validateBodyCompositionSegments(input.Segments); err != nil {
		return nil, err
	}

	var result *BodyCompositionScanRecord
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Find existing scan by (user_id, scan_date)
		var existing BodyCompositionScanRecord
		err := tx.Where("user_id = ? AND scan_date = ?", uid, input.ScanDate).
			Take(&existing).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		exists := err == nil

		now := time.Now().UTC()

		if exists {
			// Update scan fields
			updates := map[string]any{
				"weight_kg":          input.WeightKg,
				"body_fat_pct":       input.BodyFatPct,
				"smm_kg":             input.SmmKg,
				"fat_mass_kg":        input.FatMassKg,
				"visceral_fat_level": input.VisceralFatLevel,
				"ingested_at":        now,
			}
			if input.JpgPath != nil {
				updates["jpg_path"] = *input.JpgPath
			}
			if input.BmrKcal != nil {
				updates["bmr_kcal"] = *input.BmrKcal
			}
			if input.ProteinKg != nil {
				updates["protein_kg"] = *input.ProteinKg
			}
			if input.WaterL != nil {
				updates["water_l"] = *input.WaterL
			}
			if input.Smi != nil {
				updates["smi"] = *input.Smi
			}
			if input.InbodyScore != nil {
				updates["inbody_score"] = *input.InbodyScore
			}
			if err := tx.Model(&BodyCompositionScanRecord{}).
				Where("id = ?", existing.ID).
				Updates(updates).Error; err != nil {
				return err
			}
			input.ID = existing.ID
		} else {
			if input.ID == "" {
				input.ID = uuid.NewString()
			}
			input.IngestedAt = now
			if err := tx.Create(input).Error; err != nil {
				return err
			}
		}

		// Replace segments (only if provided)
		if len(input.Segments) > 0 {
			if err := tx.Where("scan_id = ?", input.ID).
				Delete(&BodyCompositionSegmentRecord{}).Error; err != nil {
				return err
			}
			for i := range input.Segments {
				input.Segments[i].ID = uuid.NewString()
				input.Segments[i].ScanID = input.ID
			}
			if err := tx.Create(&input.Segments).Error; err != nil {
				return err
			}
		}

		// Reload with segments
		var loaded BodyCompositionScanRecord
		if err := tx.Preload("Segments", func(db *gorm.DB) *gorm.DB {
			return db.Order("segment")
		}).Where("id = ?", input.ID).Take(&loaded).Error; err != nil {
			return err
		}
		result = &loaded
		return nil
	})
	if err != nil {
		var valErr *BodyCompositionValidationError
		if errors.As(err, &valErr) {
			return nil, err
		}
		return nil, fmt.Errorf("storage: upsert body composition scan: %w", err)
	}
	return result, nil
}
