// points.go is the redemption domain (devops#884; contract per devops#850
// resolution + devops#849 resolution/revision): the point_products shop read,
// the single-transaction redemption with its authoritative check order, the
// user's order list, and the two admin surfaces (product maintenance, order
// shipping). Product semantics: physical goods, redeem-success stock
// deduction, shipped is terminal. devops#909 adds the by_sku spec mode:
// point_product_skus rows carry per-variant inventory, the redemption
// transaction branches on the product's spec_mode while keeping one
// authoritative order, and the admin gains SKU-row maintenance.
package storage

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/zhaochy1990/stride/internal/wxpay"
)

// ─────────────────────────────────────────────────────────────────────────────
// Errors — the redemption error vocabulary is the #850 resolution's contract
// (product_inactive / out_of_stock / limit_reached / insufficient_points /
// address_not_found), carried to the API envelope verbatim.
// ─────────────────────────────────────────────────────────────────────────────

// RedemptionErrorCode is one business-rejection code of the redeem call.
type RedemptionErrorCode string

const (
	RedemptionProductInactive    RedemptionErrorCode = "product_inactive"
	RedemptionOutOfStock         RedemptionErrorCode = "out_of_stock"
	RedemptionLimitReached       RedemptionErrorCode = "limit_reached"
	RedemptionInsufficientPoints RedemptionErrorCode = "insufficient_points"
	RedemptionAddressNotFound    RedemptionErrorCode = "address_not_found"
	// RedemptionPaymentUnavailable guards the fee-charged path (devops#904):
	// the product carries a shipping fee but the WeChat Pay module is not
	// configured. The transaction rolls back with zero side effects — no
	// points deducted.
	RedemptionPaymentUnavailable RedemptionErrorCode = "payment_unavailable"
	// SKU errors (devops#909): a by_sku product redeemed without sku_id, or
	// with a sku_id that exists but belongs to another product (or the
	// product is single and carries no skus at all). Both roll the
	// transaction back with zero side effects.
	RedemptionSkuRequired RedemptionErrorCode = "sku_required"
	RedemptionSkuInvalid  RedemptionErrorCode = "sku_invalid"
)

// RedemptionError rejects a redemption with a stable business code.
type RedemptionError struct{ Code RedemptionErrorCode }

func (e *RedemptionError) Error() string { return string(e.Code) }

// ErrPointProductNotFound marks an admin product mutation on a missing id.
var ErrPointProductNotFound = errors.New("storage: point product not found")

// ErrPointRedemptionNotFound marks a ship on a missing order id.
var ErrPointRedemptionNotFound = errors.New("storage: point redemption not found")

// ErrPointProductSkuNotFound marks an admin SKU mutation on a missing id (or
// one that lives under a different product).
var ErrPointProductSkuNotFound = errors.New("storage: point product sku not found")

// errRedemptionLostRace marks a redemption INSERT that lost the
// (user_id, idempotency_key) unique race: the tx made no writes and rolled
// back; the winner's committed order is re-read for the idempotent answer.
var errRedemptionLostRace = errors.New("storage: redemption lost the idempotency race")

// jzshProvinces is the 江浙沪 free-shipping block (devops#904). The address
// book stores the native region-picker values (suffix included), and the bare
// forms are matched too so an admin-seeded address book behaves identically.
var jzshProvinces = map[string]bool{
	"江苏省": true, "浙江省": true, "上海市": true,
	"江苏": true, "浙江": true, "上海": true,
}

// shippingFeeFor returns the shipping fee in fen a product charges to a
// receiver province (devops#904): jzsh_fee charges the product's fee only
// outside 江浙沪; nationwide_free (and any unknown policy — the column is
// admin-gated to the closed enum) always charges 0.
func shippingFeeFor(p PointProduct, province string) int {
	if p.ShippingPolicy != ShippingPolicyJZSHFee || jzshProvinces[province] {
		return 0
	}
	return p.ShippingFee
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/me/points/redemptions — the single-transaction redemption
// ─────────────────────────────────────────────────────────────────────────────

// RedemptionRequest carries the caller-chosen product, address book entry,
// idempotency key and unit quantity of one redeem attempt. Quantity ≤ 0 means
// "unspecified" and resolves to 1 (legacy clients omit the field).
// PaymentReady tells the transaction whether the WeChat Pay module is
// configured (devops#904): a shipping-fee product redeemed while it is false
// is rejected payment_unavailable, zero-fee products never consult it.
// SkuID (devops#909) is optional: 0 = unspecified; a by_sku product requires
// it to name one of its own point_product_skus rows, a single product
// rejects any non-zero value.
type RedemptionRequest struct {
	ProductID      uint64
	AddressID      uint64
	IdempotencyKey string
	Quantity       int
	PaymentReady   bool
	SkuID          uint64
}

// RedemptionResult is the redeem outcome. Replayed marks the idempotent
// answers (committed key re-hit): zero side effects, the stored order again.
type RedemptionResult struct {
	Order    *PointRedemption
	Balance  int
	Replayed bool
}

// redemptionByIdempotencyKey reads one committed order by the idempotency
// anchor; a miss returns (nil, nil).
func (s *Store) redemptionByIdempotencyKey(ctx context.Context, uid, key string) (*PointRedemption, error) {
	var row PointRedemption
	err := s.db.WithContext(ctx).
		Where("user_id = ? AND idempotency_key = ?", uid, key).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// CreateRedemption runs the #850 authoritative single-transaction order:
//
//  0. (user_id, idempotency_key) re-hit → replay the committed order, zero
//     side effects; a concurrent UNIQUE collision also rolls back and replays.
//  1. the product row's locking read (SELECT ... FOR UPDATE, devops#909) —
//     the tx's first statement, the serialization point every same-product
//     redemption queues on. single: guarded stock UPDATE ... WHERE stock > 0
//     AND status='active' → 0 rows = out_of_stock. by_sku: guarded SKU-row
//     UPDATE with the same stock guard, preceded by the sku_required /
//     sku_invalid shape checks.
//  2. per-user limit COUNT — deliberately AFTER the product row lock (#849
//     revision): the lock serializes same-product concurrency, so the COUNT
//     cannot be raced past by parallel double-redeems, whatever mode the
//     product sells in.
//  3. points UPDATE ... WHERE balance >= X (zero-balance row INSERT IGNOREd
//     first) → 0 rows = insufficient_points.
//  4. INSERT order (full snapshots, sku_id/sku_label included for by_sku) +
//     INSERT redeem ledger row.
//
// devops#904 folds the shipping fee into steps 3-4: the fee is computed from
// the product's policy + the receiver province snapshot, a fee-charged order
// with the payment module unconfigured aborts payment_unavailable (the
// rollback undoes the stock decrement and skips the deduction entirely), and
// a fee-charged order lands with status=pending_payment / payment_state=pending
// / the fee+policy snapshots / out_trade_no=order id — all in this same
// commit. Zero-fee orders keep the #850 shape exactly (pending_shipment,
// payment_state=free, NULL out_trade_no).
func (s *Store) CreateRedemption(ctx context.Context, userID string, req RedemptionRequest) (*RedemptionResult, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if req.IdempotencyKey == "" || len(req.IdempotencyKey) > 64 {
		return nil, &PointValidationError{Message: "idempotency_key must be 1-64 chars"}
	}
	qty := req.Quantity
	if qty <= 0 {
		qty = 1 // field omitted (legacy clients) → one unit, the V1 behavior
	}
	if qty > 99 {
		return nil, &PointValidationError{Message: "quantity must be 1-99"}
	}

	// Step 0 fast path: the key already produced an order — replay it.
	if existing, err := s.redemptionByIdempotencyKey(ctx, uid, req.IdempotencyKey); err != nil {
		return nil, err
	} else if existing != nil {
		return s.replayedRedemptionResult(ctx, existing)
	}

	now := time.Now().UTC()
	var result *RedemptionResult
	txErr := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Step 1 first, and deliberately as the transaction's FIRST statement:
		// the product row's locking read never establishes the tx's read
		// snapshot, so every later consistent read — the limit COUNT included
		// — sees the orders committed by the same-product redemption that just
		// released this row lock (#849 revision). A plain read placed before
		// it would pin an older snapshot and let a parallel double-redeem slip
		// past per_user_limit. devops#909 swaps the old stock UPDATE for
		// SELECT ... FOR UPDATE: same row lock, same serialization point, but
		// the mode branch below can classify the product first.
		//
		// The row lock it takes is the serialization point every same-product
		// redemption queues on.
		var p PointProduct
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", req.ProductID).First(&p).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &RedemptionError{Code: RedemptionProductInactive}
		}
		if err != nil {
			return err
		}
		if p.Status != PointProductStatusActive {
			return &RedemptionError{Code: RedemptionProductInactive}
		}

		// The inventory write branches on the spec mode (devops#909). Both
		// arms share the guarded single-row UPDATE shape: stock >= qty or
		// nothing happens.
		var skuID *uint64
		var skuLabel *string
		if p.SpecMode == ProductSpecModeBySku {
			// by_sku: the SKU row is the inventory. The guard names the row
			// AND its product, so a foreign sku_id can never decrement
			// anything; the follow-up read classifies foreign/unknown vs
			// sold out (the tx rolls back right after either way).
			if req.SkuID == 0 {
				return &RedemptionError{Code: RedemptionSkuRequired}
			}
			res := tx.Exec(
				"UPDATE point_product_skus SET stock = stock - ? WHERE id = ? AND product_id = ? AND stock >= ?",
				qty, req.SkuID, p.ID, qty,
			)
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				var sku PointProductSku
				err := tx.Where("id = ?", req.SkuID).First(&sku).Error
				switch {
				case errors.Is(err, gorm.ErrRecordNotFound):
					return &RedemptionError{Code: RedemptionSkuInvalid}
				case err != nil:
					return err
				case sku.ProductID != p.ID:
					return &RedemptionError{Code: RedemptionSkuInvalid}
				default:
					return &RedemptionError{Code: RedemptionOutOfStock}
				}
			}
			var sku PointProductSku
			if err := tx.Where("id = ?", req.SkuID).First(&sku).Error; err != nil {
				return err
			}
			sid := req.SkuID
			label := sku.SpecValue
			skuID, skuLabel = &sid, &label
		} else {
			// single: any sku_id names a variant this product does not have.
			if req.SkuID != 0 {
				return &RedemptionError{Code: RedemptionSkuInvalid}
			}
			res := tx.Exec(
				"UPDATE point_products SET stock = stock - ? WHERE id = ? AND stock >= ? AND status = ?",
				qty, req.ProductID, qty, PointProductStatusActive,
			)
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				// We hold the product row lock and just read it active; the
				// guard can only fail on stock now.
				return &RedemptionError{Code: RedemptionOutOfStock}
			}
		}

		// Step 2: the per-user limit SUM of units, strictly after the product
		// row lock (#849 revision — the anti-bypass placement; orders only
		// ever accumulate, no status filtering). Units, not rows: one qty-3
		// order eats three of the allowance, product-level regardless of
		// which SKU rows the units came through (devops#909).
		if p.PerUserLimit > 0 {
			var units int64
			if err := tx.Model(&PointRedemption{}).
				Where("user_id = ? AND product_id = ?", uid, p.ID).
				Select("COALESCE(SUM(quantity), 0)").
				Scan(&units).Error; err != nil {
				return err
			}
			if units+int64(qty) > int64(p.PerUserLimit) {
				return &RedemptionError{Code: RedemptionLimitReached}
			}
		}

		// The receiver snapshot comes from the caller's own address book row;
		// a bad address rolls the whole transaction back (stock untouched).
		var addr UserAddress
		if err := tx.Where("id = ? AND user_id = ?", req.AddressID, uid).First(&addr).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return &RedemptionError{Code: RedemptionAddressNotFound}
			}
			return err
		}

		// devops#904: the receiver snapshot doubles as the shipping-fee input.
		// The gate fires before the points deduction — an unconfigured payment
		// module must reject a fee-charged redeem with zero point movement
		// (the returned error rolls the stock decrement back with it).
		fee := shippingFeeFor(p, addr.Province)
		if fee > 0 && !req.PaymentReady {
			return &RedemptionError{Code: RedemptionPaymentUnavailable}
		}

		// Step 3: the guarded deduction of price × quantity; users who never
		// earned start from a zero-balance row so the UPDATE, not a missing
		// row, rejects them.
		cost := p.PointsPrice * qty
		if err := tx.Exec(
			"INSERT IGNORE INTO user_points (user_id, balance, updated_at) VALUES (?, 0, ?)",
			uid, now,
		).Error; err != nil {
			return err
		}
		res := tx.Exec(
			"UPDATE user_points SET balance = balance - ?, updated_at = ? WHERE user_id = ? AND balance >= ?",
			cost, now, uid, cost,
		)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return &RedemptionError{Code: RedemptionInsufficientPoints}
		}

		// Step 4: the order (full snapshots) + the redeem ledger row. The
		// shipping-fee detour (devops#904) rides this same commit: fee orders
		// park in pending_payment until WeChat Pay confirms, zero-fee orders
		// walk straight to pending_shipment as before.
		order := &PointRedemption{
			ID: uuid.NewString(), UserID: uid,
			ProductID: p.ID, ProductName: p.Name, PointsCost: cost, Quantity: qty,
			SkuID: skuID, SkuLabel: skuLabel,
			IdempotencyKey: req.IdempotencyKey,
			ReceiverName:   addr.ReceiverName, ReceiverPhone: addr.ReceiverPhone,
			Province: addr.Province, City: addr.City, District: addr.District,
			AddressDetail: addr.AddressDetail,
			Status:        RedemptionStatusPendingShipment,
			PaymentState:  PaymentStateFree,
			CreatedAt:     now,
		}
		if fee > 0 {
			order.Status = RedemptionStatusPendingPayment
			order.PaymentState = PaymentStatePending
			order.ShippingFeeSnapshot = fee
			order.ShippingPolicySnapshot = p.ShippingPolicy
			// devops#904: WeChat Pay caps out_trade_no at 32 characters, so the
			// column stores the hyphen-stripped order id — the same value prepay
			// and close derive and the notify callback echoes back, keeping the
			// lookup exact.
			outTradeNo := wxpay.OutTradeNoFromOrderID(order.ID)
			order.OutTradeNo = &outTradeNo
		}
		if err := tx.Create(order).Error; err != nil {
			// Lost the unique race against the same key's winner (1213 rides
			// along when several losers holding shared dup-key locks try to
			// upgrade at once — same treatment as the check-in anchor).
			if n, ok := mysqlErrNo(err); ok && (n == 1062 || n == 1213) {
				return errRedemptionLostRace
			}
			return err
		}
		ledger := &PointTransaction{
			ID: uuid.NewString(), UserID: uid,
			Type: PointTypeRedeem, Amount: -cost, Ref: order.ID,
			CreatedAt: now,
		}
		if err := tx.Create(ledger).Error; err != nil {
			return err
		}
		balance, err := readBalance(tx, uid)
		if err != nil {
			return err
		}
		result = &RedemptionResult{Order: order, Balance: balance}
		return nil
	})
	if errors.Is(txErr, errRedemptionLostRace) {
		// The winner committed (or is committing) — replay its order. A few
		// bounded re-reads cover the commit-in-flight window.
		for attempt := 0; attempt < 3; attempt++ {
			existing, err := s.redemptionByIdempotencyKey(ctx, uid, req.IdempotencyKey)
			if err != nil {
				return nil, err
			}
			if existing != nil {
				return s.replayedRedemptionResult(ctx, existing)
			}
			time.Sleep(50 * time.Millisecond)
		}
		return nil, errRedemptionLostRace
	}
	if txErr != nil {
		return nil, txErr
	}
	return result, nil
}

// replayedRedemptionResult wraps a stored order with its owner's current
// balance — the shape of every idempotent replay answer.
func (s *Store) replayedRedemptionResult(ctx context.Context, order *PointRedemption) (*RedemptionResult, error) {
	balance, err := readBalance(s.db.WithContext(ctx), order.UserID)
	if err != nil {
		return nil, err
	}
	return &RedemptionResult{Order: order, Balance: balance, Replayed: true}, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/me/points/redemptions — cursor-paginated order list
// ─────────────────────────────────────────────────────────────────────────────

// RedemptionPage is one bounded, newest-first page of one user's orders.
type RedemptionPage struct {
	Items      []*PointRedemption
	NextCursor string
}

type redemptionCursor struct {
	ID string `json:"id"`
}

func encodeRedemptionCursor(c redemptionCursor) (string, error) {
	body, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(body), nil
}

func decodeRedemptionCursor(raw string) (redemptionCursor, error) {
	var c redemptionCursor
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || json.Unmarshal(body, &c) != nil {
		return c, &PointCursorError{Message: "invalid redemptions cursor"}
	}
	if _, err := uuid.Parse(c.ID); err != nil {
		return c, &PointCursorError{Message: "invalid redemptions cursor"}
	}
	return c, nil
}

// ListUserRedemptions returns one user's orders newest-first on the
// (user_id, id DESC) index with the ledger's keyset cursor pagination.
func (s *Store) ListUserRedemptions(ctx context.Context, userID, cursor string, limit int) (*RedemptionPage, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if limit == 0 {
		limit = DefaultPointLimit
	}
	if limit < 1 || limit > MaxPointLimit {
		return nil, &PointValidationError{Message: fmt.Sprintf("limit must be between 1 and %d", MaxPointLimit)}
	}
	query := s.db.WithContext(ctx).Where("user_id = ?", uid)
	if cursor != "" {
		c, err := decodeRedemptionCursor(cursor)
		if err != nil {
			return nil, err
		}
		query = query.Where("id < ?", c.ID)
	}
	var rows []*PointRedemption
	if err := query.Order("id DESC").Limit(limit + 1).Find(&rows).Error; err != nil {
		return nil, err
	}
	page := &RedemptionPage{Items: rows}
	if len(rows) > limit {
		encoded, err := encodeRedemptionCursor(redemptionCursor{ID: rows[limit-1].ID})
		if err != nil {
			return nil, err
		}
		page.Items = rows[:limit]
		page.NextCursor = encoded
	}
	return page, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: product maintenance (GET/POST/PATCH — deliberately no DELETE; the
// #850 resolution delists via status=inactive and never hard-deletes)
// ─────────────────────────────────────────────────────────────────────────────

// PointProductListing is one product row as the shop and admin lists carry
// it: the row itself, the caller's own redeemed unit count (the user surface
// grays out limit-reached cards with it; the admin surface leaves it 0), and
// by_sku products' SKU rows sort_order ASC (id ASC tiebreak; devops#909).
// single products carry no SKU rows.
type PointProductListing struct {
	Product       PointProduct
	RedeemedCount int
	Skus          []PointProductSku
}

// loadSkusByProduct fetches the SKU rows of the named products in one query
// and groups them by product id, sort_order ASC (id ASC tiebreak). Products
// in other modes keep no entry — the caller only attaches rows to by_sku.
func (s *Store) loadSkusByProduct(ctx context.Context, ids []uint64) (map[uint64][]PointProductSku, error) {
	grouped := make(map[uint64][]PointProductSku, len(ids))
	if len(ids) == 0 {
		return grouped, nil
	}
	var rows []PointProductSku
	if err := s.db.WithContext(ctx).
		Where("product_id IN ?", ids).
		Order("sort_order ASC, id ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, r := range rows {
		grouped[r.ProductID] = append(grouped[r.ProductID], r)
	}
	return grouped, nil
}

// ListActiveProducts returns the active shop, sort_order ASC (id ASC tiebreak),
// each row carrying the caller's own redeemed count and, for by_sku products,
// their SKU rows.
func (s *Store) ListActiveProducts(ctx context.Context, userID string) ([]PointProductListing, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []PointProduct
	if err := s.db.WithContext(ctx).
		Where("status = ?", PointProductStatusActive).
		Order("sort_order ASC, id ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	// One grouped SUM serves the whole page: per-product redeemed UNIT counts
	// for this user only (status filter on the shop, not on history). Units,
	// not rows — must match the per_user_limit SUM(quantity) semantics.
	type countRow struct {
		ProductID uint64
		Total     int64
	}
	var counts []countRow
	if err := s.db.WithContext(ctx).Model(&PointRedemption{}).
		Select("product_id, COALESCE(SUM(quantity), 0) AS total").
		Where("user_id = ?", uid).
		Group("product_id").Scan(&counts).Error; err != nil {
		return nil, err
	}
	byProduct := make(map[uint64]int, len(counts))
	for _, c := range counts {
		byProduct[c.ProductID] = int(c.Total)
	}
	skus, err := s.loadSkusByProduct(ctx, productIDs(rows))
	if err != nil {
		return nil, err
	}
	out := make([]PointProductListing, len(rows))
	for i, r := range rows {
		row := PointProductListing{Product: r, RedeemedCount: byProduct[r.ID]}
		if r.SpecMode == ProductSpecModeBySku {
			row.Skus = skus[r.ID]
		}
		out[i] = row
	}
	return out, nil
}

// productIDs collects the products' ids in row order (a small IN-list helper
// for the SKU batch load).
func productIDs(rows []PointProduct) []uint64 {
	ids := make([]uint64, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	return ids
}

// AdminListProducts returns every product — active and inactive — for the
// admin maintenance list, sort_order ASC (id ASC tiebreak), by_sku products
// with their SKU rows (devops#909).
func (s *Store) AdminListProducts(ctx context.Context) ([]PointProductListing, error) {
	var rows []PointProduct
	if err := s.db.WithContext(ctx).
		Order("sort_order ASC, id ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	skus, err := s.loadSkusByProduct(ctx, productIDs(rows))
	if err != nil {
		return nil, err
	}
	out := make([]PointProductListing, len(rows))
	for i, r := range rows {
		row := PointProductListing{Product: r}
		if r.SpecMode == ProductSpecModeBySku {
			row.Skus = skus[r.ID]
		}
		out[i] = row
	}
	return out, nil
}

// AdminCreateProduct inserts one product row; timestamps are stamped here so
// the admin list's created_at/updated_at round-trip exactly.
func (s *Store) AdminCreateProduct(ctx context.Context, row *PointProduct) error {
	now := time.Now().UTC()
	row.CreatedAt, row.UpdatedAt = now, now
	if err := s.db.WithContext(ctx).Create(row).Error; err != nil {
		return err
	}
	return nil
}

// ProductPatch is the admin PATCH body mapped onto storage: every field
// optional, absent = unchanged. PointsPrice/Stock/PerUserLimit are absolute
// values (#850 resolution: 改价/改库存=绝对值). ShippingPolicy and SpecMode
// are closed enums (devops#904 / devops#909; the API validates them, this
// layer stores verbatim).
type ProductPatch struct {
	Name           *string
	Description    *string
	ImageURL       *string
	PointsPrice    *int
	Stock          *int
	PerUserLimit   *int
	Status         *string
	SortOrder      *int
	ShippingPolicy *string
	ShippingFee    *int
	SpecMode       *string
}

// AdminPatchProduct applies the partial update; a missing id is
// ErrPointProductNotFound.
func (s *Store) AdminPatchProduct(ctx context.Context, id uint64, patch ProductPatch) (*PointProduct, error) {
	var row PointProduct
	if err := s.db.WithContext(ctx).Where("id = ?", id).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPointProductNotFound
		}
		return nil, err
	}
	if patch.Name != nil {
		row.Name = *patch.Name
	}
	// Patch pointers stay valid for the duration of the call, so they can be
	// assigned straight into the row.
	if patch.Description != nil {
		row.Description = patch.Description
	}
	if patch.ImageURL != nil {
		row.ImageURL = patch.ImageURL
	}
	if patch.PointsPrice != nil {
		row.PointsPrice = *patch.PointsPrice
	}
	if patch.Stock != nil {
		row.Stock = *patch.Stock
	}
	if patch.PerUserLimit != nil {
		row.PerUserLimit = *patch.PerUserLimit
	}
	if patch.Status != nil {
		row.Status = *patch.Status
	}
	if patch.SortOrder != nil {
		row.SortOrder = *patch.SortOrder
	}
	if patch.ShippingPolicy != nil {
		row.ShippingPolicy = *patch.ShippingPolicy
	}
	if patch.ShippingFee != nil {
		row.ShippingFee = *patch.ShippingFee
	}
	if patch.SpecMode != nil {
		row.SpecMode = *patch.SpecMode
	}
	row.UpdatedAt = time.Now().UTC()
	if err := s.db.WithContext(ctx).Save(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: SKU rows (devops#909) — create / patch / delete under one product.
// Rows are inventory lines, not history: orders snapshot sku_id/sku_label, so
// a deletion never rewrites existing orders.
// ─────────────────────────────────────────────────────────────────────────────

// AdminCreateProductSku inserts one SKU row under an existing product; a
// missing product id is ErrPointProductNotFound. Timestamps are stamped here
// so the admin list's created_at/updated_at round-trip exactly.
func (s *Store) AdminCreateProductSku(ctx context.Context, productID uint64, row *PointProductSku) error {
	var p PointProduct
	if err := s.db.WithContext(ctx).Where("id = ?", productID).First(&p).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPointProductNotFound
		}
		return err
	}
	row.ID = 0
	row.ProductID = productID
	now := time.Now().UTC()
	row.CreatedAt, row.UpdatedAt = now, now
	if err := s.db.WithContext(ctx).Create(row).Error; err != nil {
		return err
	}
	return nil
}

// SkuPatch is the admin SKU PATCH body: every field optional, absent =
// unchanged. Stock is an absolute value (#849 / #909 范式).
type SkuPatch struct {
	SpecValue *string
	Stock     *int
	SortOrder *int
}

// AdminPatchProductSku applies the partial update; the SKU must exist under
// the named product, else ErrPointProductSkuNotFound.
func (s *Store) AdminPatchProductSku(ctx context.Context, productID, skuID uint64, patch SkuPatch) (*PointProductSku, error) {
	var row PointProductSku
	if err := s.db.WithContext(ctx).
		Where("id = ? AND product_id = ?", skuID, productID).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPointProductSkuNotFound
		}
		return nil, err
	}
	if patch.SpecValue != nil {
		row.SpecValue = *patch.SpecValue
	}
	if patch.Stock != nil {
		row.Stock = *patch.Stock
	}
	if patch.SortOrder != nil {
		row.SortOrder = *patch.SortOrder
	}
	row.UpdatedAt = time.Now().UTC()
	if err := s.db.WithContext(ctx).Save(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

// AdminDeleteProductSku removes one SKU row; a missing or foreign id is
// ErrPointProductSkuNotFound. Existing orders keep their sku snapshot.
func (s *Store) AdminDeleteProductSku(ctx context.Context, productID, skuID uint64) error {
	res := s.db.WithContext(ctx).
		Where("id = ? AND product_id = ?", skuID, productID).
		Delete(&PointProductSku{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrPointProductSkuNotFound
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: order list + ship
// ─────────────────────────────────────────────────────────────────────────────

// AdminRedemptionPage is one bounded page of the admin order list, newest
// first, optionally filtered by fulfillment status.
type AdminRedemptionPage struct {
	Items      []*PointRedemption
	NextCursor string
}

// adminRedemptionCursor is the composite keyset anchor: created_at has
// second-and-finer ties (datetime(6) still shares instants under burst), so
// id breaks them and the pair is stable across pages.
type adminRedemptionCursor struct {
	CreatedAt time.Time `json:"created_at"`
	ID        string    `json:"id"`
}

func encodeAdminRedemptionCursor(c adminRedemptionCursor) (string, error) {
	body, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(body), nil
}

func decodeAdminRedemptionCursor(raw string) (adminRedemptionCursor, error) {
	var c adminRedemptionCursor
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || json.Unmarshal(body, &c) != nil || c.ID == "" || c.CreatedAt.IsZero() {
		return c, &PointCursorError{Message: "invalid admin redemptions cursor"}
	}
	if _, err := uuid.Parse(c.ID); err != nil {
		return c, &PointCursorError{Message: "invalid admin redemptions cursor"}
	}
	return c, nil
}

// AdminListRedemptions returns orders newest-first (created_at DESC, id DESC —
// the (status, created_at) index serves the filtered shape), status-filtered
// when status is non-empty.
func (s *Store) AdminListRedemptions(ctx context.Context, status, cursor string, limit int) (*AdminRedemptionPage, error) {
	if status != "" && !IsRedemptionStatus(status) {
		return nil, &PointValidationError{Message: "status must be pending_payment, pending_shipment, shipped or cancelled"}
	}
	if limit == 0 {
		limit = DefaultPointLimit
	}
	if limit < 1 || limit > MaxPointLimit {
		return nil, &PointValidationError{Message: fmt.Sprintf("limit must be between 1 and %d", MaxPointLimit)}
	}
	query := s.db.WithContext(ctx).Model(&PointRedemption{})
	if status != "" {
		query = query.Where("status = ?", status)
	}
	if cursor != "" {
		c, err := decodeAdminRedemptionCursor(cursor)
		if err != nil {
			return nil, err
		}
		// Outer parens keep the OR from leaking past the status filter's AND.
		query = query.Where(
			"(created_at < ? OR (created_at = ? AND id < ?))", c.CreatedAt, c.CreatedAt, c.ID,
		)
	}
	var rows []*PointRedemption
	if err := query.
		Order("created_at DESC, id DESC").Limit(limit + 1).Find(&rows).Error; err != nil {
		return nil, err
	}
	page := &AdminRedemptionPage{Items: rows}
	if len(rows) > limit {
		last := rows[limit-1]
		encoded, err := encodeAdminRedemptionCursor(adminRedemptionCursor{CreatedAt: last.CreatedAt, ID: last.ID})
		if err != nil {
			return nil, err
		}
		page.Items = rows[:limit]
		page.NextCursor = encoded
	}
	return page, nil
}

// AdminShipRedemption runs the terminal pending_shipment → shipped transition.
// Re-shipping is idempotent: the stored order (original tracking number
// included) comes back untouched — the guarded UPDATE matches only pending
// rows. A missing id is ErrPointRedemptionNotFound.
func (s *Store) AdminShipRedemption(ctx context.Context, id, trackingNo string, now time.Time) (*PointRedemption, error) {
	if _, err := uuid.Parse(id); err != nil {
		return nil, ErrPointRedemptionNotFound
	}
	res := s.db.WithContext(ctx).Exec(
		"UPDATE point_redemptions SET status = ?, tracking_no = ?, shipped_at = ? WHERE id = ? AND status = ?",
		RedemptionStatusShipped, trackingNo, now, id, RedemptionStatusPendingShipment,
	)
	if res.Error != nil {
		return nil, res.Error
	}
	var row PointRedemption
	if err := s.db.WithContext(ctx).Where("id = ?", id).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPointRedemptionNotFound
		}
		return nil, err
	}
	// row.Status == shipped here in both paths: freshly shipped, or a repeat
	// ship returning the stored state.
	return &row, nil
}
