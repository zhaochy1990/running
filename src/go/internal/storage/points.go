// points.go is the redemption domain (devops#884; contract per devops#850
// resolution + devops#849 resolution/revision): the point_products shop read,
// the single-transaction redemption with its authoritative check order, the
// user's order list, and the two admin surfaces (product maintenance, order
// shipping). Product semantics: physical goods only, redeem-success stock
// deduction, no cancel/refund/reversal — shipped is terminal.
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
)

// RedemptionError rejects a redemption with a stable business code.
type RedemptionError struct{ Code RedemptionErrorCode }

func (e *RedemptionError) Error() string { return string(e.Code) }

// ErrPointProductNotFound marks an admin product mutation on a missing id.
var ErrPointProductNotFound = errors.New("storage: point product not found")

// ErrPointRedemptionNotFound marks a ship on a missing order id.
var ErrPointRedemptionNotFound = errors.New("storage: point redemption not found")

// errRedemptionLostRace marks a redemption INSERT that lost the
// (user_id, idempotency_key) unique race: the tx made no writes and rolled
// back; the winner's committed order is re-read for the idempotent answer.
var errRedemptionLostRace = errors.New("storage: redemption lost the idempotency race")

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/me/points/redemptions — the single-transaction redemption
// ─────────────────────────────────────────────────────────────────────────────

// RedemptionRequest carries the caller-chosen product, address book entry and
// idempotency key of one redeem attempt.
type RedemptionRequest struct {
	ProductID      uint64
	AddressID      uint64
	IdempotencyKey string
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
//  1. stock UPDATE ... WHERE stock > 0 AND status='active' → 0 rows =
//     product_inactive or out_of_stock (classified by a follow-up read).
//  2. per-user limit COUNT — deliberately AFTER the stock UPDATE (#849
//     revision): the product row lock the UPDATE takes serializes same-product
//     concurrency, so the COUNT cannot be raced past by parallel double-redeems.
//  3. points UPDATE ... WHERE balance >= X (zero-balance row INSERT IGNOREd
//     first) → 0 rows = insufficient_points.
//  4. INSERT order (full snapshots) + INSERT redeem ledger row.
func (s *Store) CreateRedemption(ctx context.Context, userID string, req RedemptionRequest) (*RedemptionResult, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if req.IdempotencyKey == "" || len(req.IdempotencyKey) > 64 {
		return nil, &PointValidationError{Message: "idempotency_key must be 1-64 chars"}
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
		// the guarded stock decrement is a locking read (it never establishes
		// the tx's read snapshot), so every later consistent read — the limit
		// COUNT included — sees the orders committed by the same-product
		// redemption that just released this row lock (#849 revision). A plain
		// read placed before the UPDATE would pin an older snapshot and let a
		// parallel double-redeem slip past per_user_limit.
		//
		// The row lock it takes is the serialization point every same-product
		// redemption queues on.
		res := tx.Exec(
			"UPDATE point_products SET stock = stock - 1 WHERE id = ? AND stock > 0 AND status = ?",
			req.ProductID, PointProductStatusActive,
		)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			// Classify the guard failure: inactive/unknown vs sold out. This
			// read pins a snapshot, but the tx rolls back right after.
			var p PointProduct
			err := tx.Where("id = ?", req.ProductID).First(&p).Error
			switch {
			case errors.Is(err, gorm.ErrRecordNotFound):
				return &RedemptionError{Code: RedemptionProductInactive}
			case err != nil:
				return err
			case p.Status != PointProductStatusActive:
				return &RedemptionError{Code: RedemptionProductInactive}
			default:
				return &RedemptionError{Code: RedemptionOutOfStock}
			}
		}
		// Snapshot source: the tx's first consistent read, established only
		// now — after we hold the product row lock. Only name/price/limit feed
		// the order, so our own decrement showing up here is irrelevant.
		var p PointProduct
		if err := tx.Where("id = ?", req.ProductID).First(&p).Error; err != nil {
			return err
		}

		// Step 2: the per-user limit COUNT, strictly after the stock UPDATE so
		// it runs under the product row lock (#849 revision — the anti-bypass
		// placement; orders only ever accumulate, no status filtering).
		if p.PerUserLimit > 0 {
			var count int64
			if err := tx.Model(&PointRedemption{}).
				Where("user_id = ? AND product_id = ?", uid, p.ID).
				Count(&count).Error; err != nil {
				return err
			}
			if count >= int64(p.PerUserLimit) {
				return &RedemptionError{Code: RedemptionLimitReached}
			}
		}

		// The receiver snapshot comes from the caller's own address book row;
		// a bad address rolls the whole transaction back (stock untouched).
		var addr UserAddress
		err := tx.Where("id = ? AND user_id = ?", req.AddressID, uid).First(&addr).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &RedemptionError{Code: RedemptionAddressNotFound}
		}
		if err != nil {
			return err
		}

		// Step 3: the guarded deduction; users who never earned start from a
		// zero-balance row so the UPDATE, not a missing row, rejects them.
		if err := tx.Exec(
			"INSERT IGNORE INTO user_points (user_id, balance, updated_at) VALUES (?, 0, ?)",
			uid, now,
		).Error; err != nil {
			return err
		}
		res = tx.Exec(
			"UPDATE user_points SET balance = balance - ?, updated_at = ? WHERE user_id = ? AND balance >= ?",
			p.PointsPrice, now, uid, p.PointsPrice,
		)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return &RedemptionError{Code: RedemptionInsufficientPoints}
		}

		// Step 4: the order (full snapshots) + the redeem ledger row.
		order := &PointRedemption{
			ID: uuid.NewString(), UserID: uid,
			ProductID: p.ID, ProductName: p.Name, PointsCost: p.PointsPrice,
			IdempotencyKey: req.IdempotencyKey,
			ReceiverName:   addr.ReceiverName, ReceiverPhone: addr.ReceiverPhone,
			Province: addr.Province, City: addr.City, District: addr.District,
			AddressDetail: addr.AddressDetail,
			Status:        RedemptionStatusPendingShipment,
			CreatedAt:     now,
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
			Type: PointTypeRedeem, Amount: -p.PointsPrice, Ref: order.ID,
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

// PointProductWithCount is one shop row plus how many of it the caller already
// redeemed (the #852 UI grays out limit-reached cards with this number).
type PointProductWithCount struct {
	Product       PointProduct
	RedeemedCount int
}

// ListActiveProducts returns the active shop, sort_order ASC (id ASC tiebreak),
// each row carrying the caller's own redeemed count.
func (s *Store) ListActiveProducts(ctx context.Context, userID string) ([]PointProductWithCount, error) {
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
	// One grouped COUNT serves the whole page: per-product redeemed counts for
	// this user only (status filter on the shop, not on history).
	type countRow struct {
		ProductID uint64
		Total     int64
	}
	var counts []countRow
	if err := s.db.WithContext(ctx).Model(&PointRedemption{}).
		Select("product_id, COUNT(*) AS total").
		Where("user_id = ?", uid).
		Group("product_id").Scan(&counts).Error; err != nil {
		return nil, err
	}
	byProduct := make(map[uint64]int, len(counts))
	for _, c := range counts {
		byProduct[c.ProductID] = int(c.Total)
	}
	out := make([]PointProductWithCount, len(rows))
	for i, r := range rows {
		out[i] = PointProductWithCount{Product: r, RedeemedCount: byProduct[r.ID]}
	}
	return out, nil
}

// AdminListProducts returns every product — active and inactive — for the
// admin maintenance list, sort_order ASC (id ASC tiebreak).
func (s *Store) AdminListProducts(ctx context.Context) ([]PointProduct, error) {
	var rows []PointProduct
	if err := s.db.WithContext(ctx).
		Order("sort_order ASC, id ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
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
// values (#850 resolution: 改价/改库存=绝对值).
type ProductPatch struct {
	Name         *string
	Description  *string
	ImageURL     *string
	PointsPrice  *int
	Stock        *int
	PerUserLimit *int
	Status       *string
	SortOrder    *int
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
	row.UpdatedAt = time.Now().UTC()
	if err := s.db.WithContext(ctx).Save(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
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
		return nil, &PointValidationError{Message: "status must be pending_shipment or shipped"}
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
