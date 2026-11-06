package storage

import "time"

// PointTransaction is one append-only ledger row (devops#848 resolution): it is
// only ever INSERTed, never UPDATEd or DELETEd. There is deliberately no
// balance_after column — the balance truth lives in user_points, and a
// reconciliation script can be added later without a schema change.
type PointTransaction struct {
	ID string `gorm:"column:id;type:char(36);primaryKey;index:idx_user_points_order,priority:2,sort:desc"`
	// UserID + id DESC is the ledger page index: cursor pagination walks one
	// user's newest-first stream on a single secondary index.
	UserID    string    `gorm:"column:user_id;type:char(36);not null;index:idx_user_points_order,priority:1"`
	Type      string    `gorm:"column:type;type:varchar(16);not null"`
	Amount    int       `gorm:"column:amount;not null"` // positive earn, negative redeem
	Ref       string    `gorm:"column:ref;type:varchar(64);not null"`
	Remark    *string   `gorm:"column:remark;type:varchar(255)"`
	CreatedAt time.Time `gorm:"column:created_at;type:datetime(6);autoCreateTime:false"`
}

func (PointTransaction) TableName() string { return "point_transactions" }

// Transaction types. earn_checkin and redeem are produced by the check-in /
// shop flows; adjust is the operations refund slot (devops#904 first enables
// it: the timeout close job credits back a cancelled order's points as
// amount=+points with ref=order id). expire stays unused because points never
// expire (#847 resolution).
const (
	PointTypeEarnCheckin = "earn_checkin"
	PointTypeRedeem      = "redeem"
	PointTypeExpire      = "expire" // reserved, V1 never produces it
	PointTypeAdjust      = "adjust"
)

// UserPoint is the materialized per-user balance. Updates go through the
// atomic upsert (INSERT ... ON DUPLICATE KEY UPDATE balance = balance + ?),
// so concurrent earns need no explicit lock (#848 resolution).
type UserPoint struct {
	UserID    string    `gorm:"column:user_id;type:char(36);primaryKey"`
	Balance   int       `gorm:"column:balance;not null;default:0"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:datetime(6);autoUpdateTime:false"`
}

func (UserPoint) TableName() string { return "user_points" }

// PointProduct is one redeemable physical-good item (devops#850 resolution).
// It is global content (same standing as roadmap_features): never hard-deleted,
// delisting = status inactive. The shop only ever shows active rows.
type PointProduct struct {
	ID          uint64  `gorm:"column:id;primaryKey;autoIncrement"`
	Name        string  `gorm:"column:name;type:varchar(128);not null"`
	Description *string `gorm:"column:description;type:varchar(1024)"`
	// ImageURL is a COS direct link, uploaded via the admin endpoint POST
	// /api/admin/points/product-images (devops#896).
	ImageURL     *string `gorm:"column:image_url;type:varchar(512)"`
	PointsPrice  int     `gorm:"column:points_price;not null"`
	Stock        int     `gorm:"column:stock;not null;default:0"`          // redeem-success deducts, admin restocks; only decrements in V1 (#849)
	PerUserLimit int     `gorm:"column:per_user_limit;not null;default:0"` // 0 = unlimited (#849 revision)
	// Status carries the closed draft/active/inactive lifecycle (devops#896).
	// The API defaults new rows to draft; the column default below only
	// backstops raw INSERTs (seed scripts) that omit the column, and existing
	// databases keep it as-is — no migration.
	Status string `gorm:"column:status;type:varchar(16);not null;default:active"`
	// Shipping policy (devops#904). nationwide_free is the stock behaviour:
	// every pre-#904 row gets it through the column defaults below, so the
	// migration never changes what an existing product charges.
	ShippingPolicy string `gorm:"column:shipping_policy;type:varchar(16);not null;default:nationwide_free"`
	// ShippingFee is the flat fee in fen charged under jzsh_fee when the
	// receiver province sits outside 江苏/浙江/上海. 0 (the default) means the
	// fee slot is unused; the redemption snapshot freezes whatever it held.
	ShippingFee int       `gorm:"column:shipping_fee;not null;default:0"`
	SortOrder   int       `gorm:"column:sort_order;not null;default:0"`
	CreatedAt   time.Time `gorm:"column:created_at;type:datetime(6);autoCreateTime:false"`
	UpdatedAt   time.Time `gorm:"column:updated_at;type:datetime(6);autoUpdateTime:false"`
}

func (PointProduct) TableName() string { return "point_products" }

// Product lifecycle (devops#896): draft is the pre-publication state — admin
// uploads and prices a product before it ever hits the shop. Users only ever
// see active rows, and the redeem guard admits active only, so draft and
// inactive are both invisible on the user surface. Delisting keeps the row
// (orders snapshot the name/price, but the product row itself is retained
// history too — #850 resolution).
const (
	PointProductStatusDraft    = "draft"
	PointProductStatusActive   = "active"
	PointProductStatusInactive = "inactive"
)

// IsPointProductStatus reports whether s is a storable product status.
func IsPointProductStatus(s string) bool {
	return s == PointProductStatusDraft ||
		s == PointProductStatusActive ||
		s == PointProductStatusInactive
}

// Shipping policies (devops#904). nationwide_free keeps the pre-#904
// behaviour — no address ever pays shipping. jzsh_fee charges ShippingFee fen
// only when the receiver province sits outside the 江浙沪 (Jiangsu/Zhejiang/
// Shanghai) block.
const (
	ShippingPolicyNationwideFree = "nationwide_free"
	ShippingPolicyJZSHFee        = "jzsh_fee"
)

// IsShippingPolicy reports whether s is a storable shipping policy.
func IsShippingPolicy(s string) bool {
	return s == ShippingPolicyNationwideFree || s == ShippingPolicyJZSHFee
}

// PointRedemption is one redemption order (devops#850 resolution). The row is
// a historical fact: product_name/points_cost and the six receiver columns are
// snapshots taken at redeem time, immune to later product edits and address
// book changes. Fulfillment walks pending_shipment → shipped (terminal);
// devops#904 adds the shipping-fee detour in front: fee-charged orders start
// in pending_payment and only reach pending_shipment once WeChat Pay confirms
// (or stay there for zero-fee orders), and a pending_payment order that times
// out goes to cancelled with its points refunded via an adjust ledger row.
type PointRedemption struct {
	// ID is the public order number (the miniprogram renders it with an
	// "R-" prefix); id DESC under a user walks their newest-first order list.
	ID     string `gorm:"column:id;type:char(36);primaryKey;index:idx_point_redemptions_user,priority:2,sort:desc"`
	UserID string `gorm:"column:user_id;type:char(36);not null;index:idx_point_redemptions_user,priority:1;uniqueIndex:uk_point_redemptions_user_idem,priority:1"`
	// ProductID + the name/price snapshots. ProductID feeds the per-user
	// limit SUM; the snapshot columns feed every render, forever.
	ProductID   uint64 `gorm:"column:product_id;not null"`
	ProductName string `gorm:"column:product_name;type:varchar(128);not null"`
	PointsCost  int    `gorm:"column:points_cost;not null"`
	// Quantity is the unit count this order carries; cost = price × quantity.
	// default:1 keeps pre-quantity rows and legacy clients at one unit, so
	// SUM(quantity) == the old COUNT(rows) limit semantics.
	Quantity int `gorm:"column:quantity;not null;default:1"`
	// IdempotencyKey is client-supplied; UNIQUE(user_id, idempotency_key)
	// makes one key exactly one order (#850 resolution).
	IdempotencyKey string `gorm:"column:idempotency_key;type:varchar(64);not null;uniqueIndex:uk_point_redemptions_user_idem,priority:2"`

	// Receiver snapshot, redundant from the address book (six columns per the
	// #850 resolution): editing or deleting the address never rewrites history.
	ReceiverName  string `gorm:"column:receiver_name;type:varchar(64);not null"`
	ReceiverPhone string `gorm:"column:receiver_phone;type:varchar(32);not null"`
	Province      string `gorm:"column:province;type:varchar(32);not null"`
	City          string `gorm:"column:city;type:varchar(32);not null"`
	District      string `gorm:"column:district;type:varchar(32);not null"`
	AddressDetail string `gorm:"column:address_detail;type:varchar(255);not null"`

	// Shipping-fee + payment state (devops#904). The fee/policy snapshots are
	// taken in the redeem transaction, the same commit that deducts the
	// points, so a product's fee can change without touching open orders.
	// out_trade_no is the WeChat merchant trade number; it equals the order id
	// and stays NULL for zero-fee orders (they never talk to WeChat Pay). The
	// UNIQUE index doubles as the callback's address: a notify names no user,
	// only this number. The column defaults backstop pre-#904 rows as free
	// orders, so the migration is behaviour-neutral.
	ShippingFeeSnapshot    int        `gorm:"column:shipping_fee_snapshot;not null;default:0"`
	ShippingPolicySnapshot string     `gorm:"column:shipping_policy_snapshot;type:varchar(16);not null;default:nationwide_free"`
	PaymentState           string     `gorm:"column:payment_state;type:varchar(16);not null;default:free"`
	PaidAt                 *time.Time `gorm:"column:paid_at;type:datetime(6)"`
	OutTradeNo             *string    `gorm:"column:out_trade_no;type:varchar(64);uniqueIndex"`

	Status string `gorm:"column:status;type:varchar(16);not null;default:pending_shipment;index:idx_point_redemptions_status,priority:1"`
	// TrackingNo + ShippedAt arrive together at the terminal ship transition.
	TrackingNo *string    `gorm:"column:tracking_no;type:varchar(64)"`
	ShippedAt  *time.Time `gorm:"column:shipped_at;type:datetime(6)"`

	CreatedAt time.Time `gorm:"column:created_at;type:datetime(6);autoCreateTime:false;index:idx_point_redemptions_status,priority:2"`
}

func (PointRedemption) TableName() string { return "point_redemptions" }

// Fulfillment states. shipped and cancelled are terminal — the row never
// leaves either (#849, cancelled per devops#904). pending_payment is the
// shipping-fee detour: only a confirmed payment (pending → paid, via the
// WeChat notify) or the timeout sweep (→ cancelled) moves an order out of it.
const (
	RedemptionStatusPendingPayment  = "pending_payment"
	RedemptionStatusPendingShipment = "pending_shipment"
	RedemptionStatusShipped         = "shipped"
	RedemptionStatusCancelled       = "cancelled"
)

// IsRedemptionStatus reports whether s is a storable redemption status.
func IsRedemptionStatus(s string) bool {
	return s == RedemptionStatusPendingPayment ||
		s == RedemptionStatusPendingShipment ||
		s == RedemptionStatusShipped ||
		s == RedemptionStatusCancelled
}

// Payment states (devops#904): free covers every zero-fee order (including
// all pre-#904 rows through the column default), pending marks a fee-charged
// order waiting for WeChat Pay, paid is set by the verified notify callback —
// strictly one-way, replayed notifications no-op.
const (
	PaymentStateFree    = "free"
	PaymentStatePending = "pending"
	PaymentStatePaid    = "paid"
)
