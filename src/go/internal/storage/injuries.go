package storage

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

const (
	DefaultInjuryLimit = 50
	MaxInjuryLimit     = 50
)

// AutoMigrateInjuries creates or reconciles the Go-owned injury table.
func (s *Store) AutoMigrateInjuries(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&InjuryRecord{}); err != nil {
		return fmt.Errorf("storage: automigrate injuries: %w", err)
	}
	return nil
}

type InjuryValidationError struct{ Message string }

func (e *InjuryValidationError) Error() string { return e.Message }

type InjuryCursorError struct{ Message string }

func (e *InjuryCursorError) Error() string { return e.Message }

// InjuryPage is a bounded, ordered page of one user's injury records.
type InjuryPage struct {
	Items      []*InjuryRecord
	NextCursor string
}

type injuryCursor struct {
	Active    bool      `json:"active"`
	UpdatedAt time.Time `json:"updated_at"`
	ID        string    `json:"id"`
}

func validateInjuryFields(description, recoveryStatus, restriction string) (string, error) {
	description = strings.TrimSpace(description)
	if n := len([]rune(description)); n < 1 || n > 1000 {
		return "", &InjuryValidationError{Message: "description must contain 1-1000 characters"}
	}
	if recoveryStatus != InjuryRecoveryActive && recoveryStatus != InjuryRecoveryRecovered {
		return "", &InjuryValidationError{Message: "recovery_status must be active or recovered"}
	}
	if restriction != RunningRestrictionNone && restriction != RunningRestrictionEasyOnly && restriction != RunningRestrictionNoRunning {
		return "", &InjuryValidationError{Message: "running_restriction must be none, easy_only, or no_running"}
	}
	if recoveryStatus == InjuryRecoveryRecovered && restriction != RunningRestrictionNone {
		return "", &InjuryValidationError{Message: "recovered injuries must have no running restriction"}
	}
	if recoveryStatus == InjuryRecoveryActive && restriction == RunningRestrictionNone {
		return "", &InjuryValidationError{Message: "active injuries must have a running restriction"}
	}
	return description, nil
}

func encodeInjuryCursor(c injuryCursor) (string, error) {
	body, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(body), nil
}

func decodeInjuryCursor(raw string) (injuryCursor, error) {
	var c injuryCursor
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || json.Unmarshal(body, &c) != nil || c.ID == "" || c.UpdatedAt.IsZero() {
		return c, &InjuryCursorError{Message: "invalid injury cursor"}
	}
	if _, err := uuid.Parse(c.ID); err != nil {
		return c, &InjuryCursorError{Message: "invalid injury cursor"}
	}
	return c, nil
}

// CreateInjury inserts a validated record under userID and returns the persisted row.
func (s *Store) CreateInjury(ctx context.Context, injury *InjuryRecord) (*InjuryRecord, error) {
	uid, err := canonicalUserID(injury.UserID)
	if err != nil {
		return nil, err
	}
	description, err := validateInjuryFields(injury.Description, injury.RecoveryStatus, injury.RunningRestriction)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	row := &InjuryRecord{
		ID: injury.ID, UserID: uid, Description: description,
		RecoveryStatus: injury.RecoveryStatus, RunningRestriction: injury.RunningRestriction,
		CreatedAt: now, UpdatedAt: now,
	}
	if row.ID == "" {
		row.ID = uuid.NewString()
	}
	if err := s.db.WithContext(ctx).Create(row).Error; err != nil {
		return nil, err
	}
	return row, nil
}

// ListInjuries returns records for one user in the stable contract order.
func (s *Store) ListInjuries(ctx context.Context, userID, cursor string, limit int) (*InjuryPage, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if limit == 0 {
		limit = DefaultInjuryLimit
	}
	if limit < 1 || limit > MaxInjuryLimit {
		return nil, fmt.Errorf("limit must be between 1 and %d", MaxInjuryLimit)
	}

	query := s.db.WithContext(ctx).Where("user_id = ?", uid)
	if cursor != "" {
		c, err := decodeInjuryCursor(cursor)
		if err != nil {
			return nil, err
		}
		// active first, then updated_at DESC, then ID DESC. The rank comparison
		// lets a cursor on the active partition continue into recovered rows.
		rank := 1
		if c.Active {
			rank = 0
		}
		query = query.Where("(CASE WHEN recovery_status = ? THEN 0 ELSE 1 END > ?) OR (CASE WHEN recovery_status = ? THEN 0 ELSE 1 END = ? AND (updated_at < ? OR (updated_at = ? AND id < ?)))",
			InjuryRecoveryActive, rank, InjuryRecoveryActive, rank, c.UpdatedAt, c.UpdatedAt, c.ID)
	}

	var rows []*InjuryRecord
	if err := query.Order("CASE WHEN recovery_status = 'active' THEN 0 ELSE 1 END ASC").
		Order("updated_at DESC").Order("id DESC").Limit(limit + 1).Find(&rows).Error; err != nil {
		return nil, err
	}
	page := &InjuryPage{Items: rows}
	if len(rows) > limit {
		last := rows[limit-1]
		page.Items = rows[:limit]
		encoded, err := encodeInjuryCursor(injuryCursor{
			Active: last.RecoveryStatus == InjuryRecoveryActive, UpdatedAt: last.UpdatedAt, ID: last.ID,
		})
		if err != nil {
			return nil, err
		}
		page.NextCursor = encoded
	}
	return page, nil
}

// UpdateInjury replaces all editable fields only when the record belongs to userID.
func (s *Store) UpdateInjury(ctx context.Context, userID, injuryID, description, recoveryStatus, restriction string) (*InjuryRecord, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(injuryID); err != nil {
		return nil, gorm.ErrRecordNotFound
	}
	description, err = validateInjuryFields(description, recoveryStatus, restriction)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	result := s.db.WithContext(ctx).Model(&InjuryRecord{}).
		Where("id = ? AND user_id = ?", injuryID, uid).
		Updates(map[string]any{
			"description":         description,
			"recovery_status":     recoveryStatus,
			"running_restriction": restriction,
			"updated_at":          now,
		})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	var row InjuryRecord
	if err := s.db.WithContext(ctx).Where("id = ? AND user_id = ?", injuryID, uid).First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

// DeleteInjury physically removes a record only when it belongs to userID.
func (s *Store) DeleteInjury(ctx context.Context, userID, injuryID string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	if _, err := uuid.Parse(injuryID); err != nil {
		return gorm.ErrRecordNotFound
	}
	result := s.db.WithContext(ctx).Where("id = ? AND user_id = ?", injuryID, uid).Delete(&InjuryRecord{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
