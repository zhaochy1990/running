// Package wxpayclose is the timeout sweeper for shipping-fee redemption
// orders (devops#904): every order parked in pending_payment past the cutoff
// gets its WeChat order closed upstream (so a straggler payment can no longer
// land) and its points refunded — one balance credit plus one append-only
// adjust ledger row, the cancel and the refund in the same transaction.
//
// The whole sweep is idempotent by construction: the storage cancel is a
// guarded single-row UPDATE, so a repeated or concurrent sweep matches zero
// rows for orders already resolved, and a callback that paid an order between
// the close call and the cancel claims the row first and blocks the refund.
package wxpayclose

import (
	"context"
	"encoding/json"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

// JobType is the worker job carrying one sweep.
const JobType = "wxpay_order_close"

// DefaultAge is how long an order may sit in pending_payment before the
// sweep closes and refunds it (devops#904: 30 minutes).
const DefaultAge = 30 * time.Minute

// sweepLimit bounds one run's work list: the ticker re-runs every few minutes,
// so a burst larger than the batch is serviced by the next run instead of one
// unbounded transaction loop.
const sweepLimit = 200

// Closer closes orders upstream. Satisfied by *wxpay.Client (its CloseOrder
// already folds inert outcomes — never-prepaid, already-closed — into nil so
// a crash between close and refund heals on the next sweep).
type Closer interface {
	CloseOrder(ctx context.Context, outTradeNo string) error
}

// Store is the slice of storage the sweep needs.
type Store interface {
	ListPaymentExpiredRedemptions(ctx context.Context, cutoff time.Time, limit int) ([]storage.PointRedemption, error)
	CancelPendingRedemption(ctx context.Context, id string, now time.Time) (bool, error)
}

// Summary is the sweep's result JSON (and the ticker's log payload).
type Summary struct {
	Expired int `json:"expired"` // pending_payment orders past the cutoff
	Closed  int `json:"closed"`  // closed upstream AND cancelled + refunded
	Skipped int `json:"skipped"` // close failed or lost a race — left for the next sweep
}

// New returns the job handler for the wxpay_order_close sweep.
func New(store Store, closer Closer, olderThan time.Duration) job.Handler {
	return func(ctx context.Context, _ *job.Job, _ job.Heartbeat) (string, error) {
		summary, err := Sweep(ctx, store, closer, olderThan, time.Now().UTC())
		if err != nil {
			return "", err
		}
		encoded, err := json.Marshal(summary)
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	}
}

// Sweep runs one pass: list expired orders, close each upstream, then cancel +
// refund in one transaction. Per-order failures skip and count rather than
// fail the run — one unreachable close must not strand the other refunds, and
// the guarded cancel keeps a re-run of the same orders a no-op. A nil closer
// (payment module unconfigured) skips the run: pending_payment orders cannot
// exist without it.
func Sweep(ctx context.Context, store Store, closer Closer, olderThan time.Duration, now time.Time) (Summary, error) {
	summary := Summary{}
	if closer == nil {
		return summary, nil
	}
	rows, err := store.ListPaymentExpiredRedemptions(ctx, now.Add(-olderThan), sweepLimit)
	if err != nil {
		return summary, err
	}
	summary.Expired = len(rows)
	for i := range rows {
		if ctx.Err() != nil {
			return summary, ctx.Err()
		}
		// out_trade_no is always set on pending_payment rows (only fee-charged
		// orders park there), but the defensive read keeps a NULL row from
		// closing an empty trade number upstream.
		if rows[i].OutTradeNo == nil {
			summary.Skipped++
			continue
		}
		if err := closer.CloseOrder(ctx, *rows[i].OutTradeNo); err != nil {
			summary.Skipped++ // already paid upstream, transient failure — next sweep retries
			continue
		}
		ok, err := store.CancelPendingRedemption(ctx, rows[i].ID, now)
		if err != nil {
			summary.Skipped++
			continue
		}
		if ok {
			summary.Closed++
		}
	}
	return summary, nil
}
