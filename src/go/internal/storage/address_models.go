package storage

import "time"

// UserAddress is one entry of a user's address book (devops#850 resolution:
// independent domain file). Rows are hard-deletable — redemption orders carry
// a six-column receiver snapshot, so removing an address never hurts history.
// The service layer caps each user at 10 entries; at most one row per user
// carries is_default (enforced in the same transaction that sets it).
type UserAddress struct {
	ID            uint64    `gorm:"column:id;primaryKey;autoIncrement"`
	UserID        string    `gorm:"column:user_id;type:char(36);not null;index:idx_user_addresses_user"`
	ReceiverName  string    `gorm:"column:receiver_name;type:varchar(64);not null"`
	ReceiverPhone string    `gorm:"column:receiver_phone;type:varchar(32);not null"`
	Province      string    `gorm:"column:province;type:varchar(32);not null"`
	City          string    `gorm:"column:city;type:varchar(32);not null"`
	District      string    `gorm:"column:district;type:varchar(32);not null"`
	AddressDetail string    `gorm:"column:address_detail;type:varchar(255);not null"`
	IsDefault     bool      `gorm:"column:is_default;not null;default:false"`
	CreatedAt     time.Time `gorm:"column:created_at;type:datetime(6);autoCreateTime:false"`
	UpdatedAt     time.Time `gorm:"column:updated_at;type:datetime(6);autoUpdateTime:false"`
}

func (UserAddress) TableName() string { return "user_addresses" }
