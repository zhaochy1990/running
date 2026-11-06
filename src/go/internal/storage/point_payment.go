// point_payment.go is the shipping-fee payment state machine over redemption
// orders (devops#904): the reads the pay/notify endpoints need, the verified
// callback's strictly one-way pending → paid transition, and the timeout
// sweep's cancel + refund. Every mutation is a guarded single-row UPDATE (or
// one transaction whose first statement is that guard), so callbacks and the
// sweep can race safely: exactly one side wins, the loser is a no-op.
package storage

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// GetUserRedemption reads one of the caller's own orders for the pay
// endpoint; a missing or foreign order is ErrPointRedemptionNotFound.
func (s *Store) GetUserRedemption(ctx context.Context, userID, id string) (*PointRedemption, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row PointRedemption
	if err := s.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", id, uid).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPointRedemptionNotFound
		}
		return nil, err
	}
	return &row, nil
}

// GetRedemptionByOutTradeNo reads one order by its WeChat trade number — the
// only handle a payment callback carries (it knows no user). A miss returns
// (nil, nil): the caller answers the notify with a no-op, never an error.
func (s *Store) GetRedemptionByOutTradeNo(ctx context.Context, outTradeNo string) (*PointRedemption, error) {
	var row PointRedemption
	if err := s.db.WithContext(ctx).
		Where("out_trade_no = ?", outTradeNo).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &row, nil
}

// MarkRedemptionPaid applies the notify callback's transition in one guarded
// UPDATE: payment_state pending → paid, status pending_payment →
// pending_shipment, paid_at stamped — strictly one-way (devops#904), so a
// replayed or late notification matches zero rows and reports false. An
// already-cancelled order also matches zero rows: the sweep won that race,
// the points were refunded, and no late callback may resurrect it as paid.
func (s *Store) MarkRedemptionPaid(ctx context.Context, outTradeNo string, paidAt time.Time) (bool, error) {
	res := s.db.WithContext(ctx).Exec(
		"UPDATE point_redemptions SET payment_state = ?, status = ?, paid_at = ? "+
			"WHERE out_trade_no = ? AND payment_state = ? AND status = ?",
		PaymentStatePaid, RedemptionStatusPendingShipment, paidAt,
		outTradeNo, PaymentStatePending, RedemptionStatusPendingPayment,
	)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}

// ListPaymentExpiredRedemptions returns fee-charged orders still parked in
// pending_payment past their age cutoff, oldest first, bounded — the timeout
// sweep's work list.
func (s *Store) ListPaymentExpiredRedemptions(ctx context.Context, cutoff time.Time, limit int) ([]PointRedemption, error) {
	var rows []PointRedemption
	if err := s.db.WithContext(ctx).
		Where("status = ? AND created_at <= ?", RedemptionStatusPendingPayment, cutoff).
		Order("created_at ASC").Limit(limit).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// CancelPendingRedemption runs the sweep's per-order outcome in one
// transaction: the guarded pending_payment → cancelled UPDATE is the claim
// (a callback that paid the order in the meantime matches zero rows and the
// sweep must not refund it), then the points go back the way they came —
// the balance credit plus one append-only adjust ledger row (+points,
// ref=order id), the first production writer of the adjust type (devops#904).
// Reports false when the claim matched nothing: the order is already paid,
// shipped or cancelled, and a re-run of the sweep is a no-op.
func (s *Store) CancelPendingRedemption(ctx context.Context, id string, now time.Time) (bool, error) {
	refunded := false
	txErr := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Exec(
			"UPDATE point_redemptions SET status = ? WHERE id = ? AND status = ?",
			RedemptionStatusCancelled, id, RedemptionStatusPendingPayment,
		)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return nil // paid/shipped/cancelled in the meantime — zero side effects
		}
		var row PointRedemption
		if err := tx.Where("id = ?", id).First(&row).Error; err != nil {
			return err
		}
		// Mirror the deduction's zero-balance guard: a user who never earned
		// (and was never deducted either) still needs a row to credit.
		if err := tx.Exec(
			"INSERT IGNORE INTO user_points (user_id, balance, updated_at) VALUES (?, 0, ?)",
			row.UserID, now,
		).Error; err != nil {
			return err
		}
		if err := tx.Exec(
			"UPDATE user_points SET balance = balance + ?, updated_at = ? WHERE user_id = ?",
			row.PointsCost, now, row.UserID,
		).Error; err != nil {
			return err
		}
		ledger := &PointTransaction{
			ID: uuid.NewString(), UserID: row.UserID,
			Type: PointTypeAdjust, Amount: row.PointsCost, Ref: row.ID,
			CreatedAt: now,
		}
		if err := tx.Create(ledger).Error; err != nil {
			return err
		}
		refunded = true
		return nil
	})
	if txErr != nil {
		return false, txErr
	}
	return refunded, nil
}
