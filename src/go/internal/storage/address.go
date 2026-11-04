// address.go is the address-book domain (devops#884; contract per devops#849
// resolution + devops#850 resolution): CRUD over user_addresses with the
// ≤10-entries-per-user service cap and the single-default invariant (setting
// a default clears the user's other default flags in the same transaction).
// Deleting an address is a hard delete — redemption orders hold receiver
// snapshots, so history never depends on these rows.
package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// MaxAddressesPerUser is the service-level address book cap (#850 resolution:
// 每用户 ≤10 条，超限报错).
const MaxAddressesPerUser = 10

// ErrAddressNotFound marks address reads/mutations on a missing id or an id
// owned by someone else (same answer either way — ownership is part of the key).
var ErrAddressNotFound = errors.New("storage: user address not found")

// ErrAddressLimitReached rejects the 11th entry (#850 resolution).
var ErrAddressLimitReached = errors.New("storage: address book limit reached")

// AddressValidationError rejects an out-of-range field at the storage seam.
type AddressValidationError struct{ Message string }

func (e *AddressValidationError) Error() string { return e.Message }

// AutoMigrateAddresses creates or reconciles the user_addresses table.
func (s *Store) AutoMigrateAddresses(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&UserAddress{}); err != nil {
		return fmt.Errorf("storage: automigrate addresses: %w", err)
	}
	return nil
}

// ListAddresses returns the caller's address book, default first, newest
// within each group.
func (s *Store) ListAddresses(ctx context.Context, userID string) ([]UserAddress, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []UserAddress
	if err := s.db.WithContext(ctx).
		Where("user_id = ?", uid).
		Order("is_default DESC, id DESC").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list addresses: %w", err)
	}
	return rows, nil
}

// AddressInput is the field set of a create/update (handler binding validated
// it; storage re-checks non-emptiness defensively).
type AddressInput struct {
	ReceiverName  string
	ReceiverPhone string
	Province      string
	City          string
	District      string
	AddressDetail string
	IsDefault     bool
}

func (in AddressInput) validate() error {
	switch {
	case in.ReceiverName == "", in.ReceiverPhone == "", in.Province == "",
		in.City == "", in.District == "", in.AddressDetail == "":
		return &AddressValidationError{Message: "all address fields are required"}
	}
	return nil
}

// CreateAddress appends one entry inside the ≤10 cap. The cap is a
// service-level guard, deliberately not concurrency-hardened: two simultaneous
// creates for one user could both pass the COUNT — the cap bounds a user's
// own bookkeeping, not an integrity invariant (unlike the redemption
// transaction's locks). The first entry a user ever creates becomes their
// default automatically; an explicit is_default request clears the other
// default flags in the same transaction.
func (s *Store) CreateAddress(ctx context.Context, userID string, in AddressInput) (*UserAddress, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if err := in.validate(); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	var row *UserAddress
	txErr := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&UserAddress{}).Where("user_id = ?", uid).Count(&count).Error; err != nil {
			return err
		}
		if count >= MaxAddressesPerUser {
			return ErrAddressLimitReached
		}
		isDefault := in.IsDefault || count == 0
		if isDefault {
			if err := tx.Model(&UserAddress{}).
				Where("user_id = ? AND is_default = ?", uid, true).
				Update("is_default", false).Error; err != nil {
				return err
			}
		}
		row = &UserAddress{
			UserID: uid, ReceiverName: in.ReceiverName, ReceiverPhone: in.ReceiverPhone,
			Province: in.Province, City: in.City, District: in.District,
			AddressDetail: in.AddressDetail, IsDefault: isDefault,
			CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(row).Error; err != nil {
			return err
		}
		return nil
	})
	if txErr != nil {
		return nil, txErr
	}
	return row, nil
}

// AddressPatch is the update field set: absent = unchanged. Flipping
// is_default to true clears the other flags in the same transaction.
type AddressPatch struct {
	ReceiverName  *string
	ReceiverPhone *string
	Province      *string
	City          *string
	District      *string
	AddressDetail *string
	IsDefault     *bool
}

// UpdateAddress applies the partial edit to one owned row; missing or
// foreign ids are ErrAddressNotFound.
func (s *Store) UpdateAddress(ctx context.Context, userID string, id uint64, patch AddressPatch) (*UserAddress, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row *UserAddress
	txErr := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current UserAddress
		if err := tx.Where("id = ? AND user_id = ?", id, uid).First(&current).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrAddressNotFound
			}
			return err
		}
		if patch.ReceiverName != nil {
			current.ReceiverName = *patch.ReceiverName
		}
		if patch.ReceiverPhone != nil {
			current.ReceiverPhone = *patch.ReceiverPhone
		}
		if patch.Province != nil {
			current.Province = *patch.Province
		}
		if patch.City != nil {
			current.City = *patch.City
		}
		if patch.District != nil {
			current.District = *patch.District
		}
		if patch.AddressDetail != nil {
			current.AddressDetail = *patch.AddressDetail
		}
		if err := (AddressInput{
			ReceiverName: current.ReceiverName, ReceiverPhone: current.ReceiverPhone,
			Province: current.Province, City: current.City, District: current.District,
			AddressDetail: current.AddressDetail,
		}).validate(); err != nil {
			return err
		}
		if patch.IsDefault != nil && *patch.IsDefault && !current.IsDefault {
			if err := tx.Model(&UserAddress{}).
				Where("user_id = ? AND is_default = ?", uid, true).
				Update("is_default", false).Error; err != nil {
				return err
			}
			current.IsDefault = true
		}
		current.UpdatedAt = time.Now().UTC()
		if err := tx.Save(&current).Error; err != nil {
			return err
		}
		row = &current
		return nil
	})
	if txErr != nil {
		return nil, txErr
	}
	return row, nil
}

// DeleteAddress hard-deletes one owned row; missing or foreign ids are
// ErrAddressNotFound. History is safe — orders carry snapshots.
func (s *Store) DeleteAddress(ctx context.Context, userID string, id uint64) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	res := s.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", id, uid).
		Delete(&UserAddress{})
	if res.Error != nil {
		return fmt.Errorf("storage: delete address: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return ErrAddressNotFound
	}
	return nil
}

// SetDefaultAddress moves the single default flag to one owned row, clearing
// the rest in the same transaction (#850 resolution). The row must exist.
func (s *Store) SetDefaultAddress(ctx context.Context, userID string, id uint64) (*UserAddress, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row *UserAddress
	txErr := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current UserAddress
		if err := tx.Where("id = ? AND user_id = ?", id, uid).First(&current).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrAddressNotFound
			}
			return err
		}
		if err := tx.Model(&UserAddress{}).
			Where("user_id = ? AND is_default = ? AND id <> ?", uid, true, id).
			Update("is_default", false).Error; err != nil {
			return err
		}
		if !current.IsDefault {
			if err := tx.Model(&UserAddress{}).Where("id = ?", id).
				Updates(map[string]any{"is_default": true, "updated_at": time.Now().UTC()}).Error; err != nil {
				return err
			}
			current.IsDefault = true
		}
		row = &current
		return nil
	})
	if txErr != nil {
		return nil, txErr
	}
	return row, nil
}
