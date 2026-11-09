// wxpayclose_test.go drives the sweep against a fake store + closer: the
// close-first-then-refund order, the skip paths (close failure, nil closer,
// lost races), and the state machine's never-refund-a-paid-order guarantee.
package wxpayclose

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/wxpay"
)

type fakeStore struct {
	rows   []storage.PointRedemption
	closed map[string]bool // ids CancelPendingRedemption has transitioned
	// failCancel makes the cancel error once per id (transient failure path).
	failCancel map[string]int
}

func newFakeStore(rows ...storage.PointRedemption) *fakeStore {
	return &fakeStore{rows: rows, closed: map[string]bool{}, failCancel: map[string]int{}}
}

func (f *fakeStore) ListPaymentExpiredRedemptions(_ context.Context, cutoff time.Time, limit int) ([]storage.PointRedemption, error) {
	var out []storage.PointRedemption
	for _, r := range f.rows {
		if !r.CreatedAt.After(cutoff) {
			out = append(out, r)
		}
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (f *fakeStore) CancelPendingRedemption(_ context.Context, id string, _ time.Time) (bool, error) {
	if f.failCancel[id] > 0 {
		f.failCancel[id]--
		return false, errors.New("cancel failed once")
	}
	if f.closed[id] {
		return false, nil // already resolved (the guarded UPDATE matched nothing)
	}
	f.closed[id] = true
	return true, nil
}

type fakeCloser struct {
	// errByTradeNo maps an order's out_trade_no to a close failure.
	errByTradeNo map[string]error
	closed       []string
}

func (f *fakeCloser) CloseOrder(_ context.Context, outTradeNo string) error {
	if err, ok := f.errByTradeNo[outTradeNo]; ok {
		return err
	}
	f.closed = append(f.closed, outTradeNo)
	return nil
}

func feeOrder(id string, minutesOld int) storage.PointRedemption {
	// The stored column carries the raw hyphenated order id — the shape every
	// pre-normalization fee row has (devops#904 legacy rows).
	tradeNo := id
	return storage.PointRedemption{
		ID: id, Status: storage.RedemptionStatusPendingPayment,
		PaymentState: storage.PaymentStatePending, PointsCost: 100,
		OutTradeNo: &tradeNo,
		CreatedAt:  time.Now().UTC().Add(-time.Duration(minutesOld) * time.Minute),
	}
}

func TestSweepCancelsAndCounts(t *testing.T) {
	store := newFakeStore(feeOrder("old-1", 45), feeOrder("old-2", 31))
	closer := &fakeCloser{}

	summary, err := Sweep(context.Background(), store, closer, DefaultAge, time.Now().UTC())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if summary.Expired != 2 || summary.Closed != 2 || summary.Skipped != 0 {
		t.Fatalf("unexpected summary: %+v", summary)
	}
	if len(closer.closed) != 2 {
		t.Fatalf("expected both orders closed upstream, got %v", closer.closed)
	}
	if !store.closed["old-1"] || !store.closed["old-2"] {
		t.Fatalf("expected both orders cancelled + refunded: %v", store.closed)
	}
}

func TestSweepOnlyTouchesExpiredOrders(t *testing.T) {
	store := newFakeStore(feeOrder("fresh", 5), feeOrder("expired", 31))
	closer := &fakeCloser{}

	summary, err := Sweep(context.Background(), store, closer, DefaultAge, time.Now().UTC())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if summary.Expired != 1 || summary.Closed != 1 {
		t.Fatalf("the 30-minute guard must spare fresh orders: %+v", summary)
	}
	for _, trade := range closer.closed {
		if strings.Contains(trade, "fresh") {
			t.Fatalf("fresh order must not be closed upstream: %v", closer.closed)
		}
	}
}

func TestSweepSkipsFailedCloses(t *testing.T) {
	store := newFakeStore(feeOrder("paid-upstream", 40), feeOrder("closable", 40))
	closer := &fakeCloser{errByTradeNo: map[string]error{
		// A paid order surfaces as a generic close failure: the client only
		// folds never-payable codes into nil, so money already moved upstream
		// can never be refunded by this sweep. The key is the id-derived
		// trade number the sweep actually sends.
		wxpay.OutTradeNoFromOrderID("paid-upstream"): errors.New("wxpay: close order: ORDERPAID"),
	}}

	summary, err := Sweep(context.Background(), store, closer, DefaultAge, time.Now().UTC())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if summary.Skipped != 1 || summary.Closed != 1 {
		t.Fatalf("the paid order must be skipped, the other closed: %+v", summary)
	}
	if store.closed["paid-upstream"] {
		t.Fatal("a paid-upstream order must never be cancelled or refunded")
	}
}

func TestSweepDerivesTradeNoFromOrderIDNotColumn(t *testing.T) {
	// Legacy stuck rows carry the raw 36-character hyphenated UUID in the
	// out_trade_no column — a value WeChat rejects with PARAM_ERROR, so a
	// sweep reading the column could never close them. The sweep sends the
	// id-derived 32-character number instead: close answers ORDER_NOT_EXIST
	// (the prepay on those rows never succeeded), the inert outcome folds
	// into nil, and the refund + cancel below unsticks the row without any
	// data migration (devops#904).
	legacyID := "3f2b8a41-9c0d-4e6f-8a2b-1d3c5e7f9a0b"
	legacy := feeOrder(legacyID, 45)
	// A NULL-column row closes the same way: the order id is the only input.
	nullColumn := feeOrder(uuid.NewString(), 45)
	nullColumn.OutTradeNo = nil
	store := newFakeStore(legacy, nullColumn)
	closer := &fakeCloser{}

	summary, err := Sweep(context.Background(), store, closer, DefaultAge, time.Now().UTC())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if summary.Closed != 2 {
		t.Fatalf("both rows must close, cancel and refund: %+v", summary)
	}
	if got := closer.closed[0]; got != wxpay.OutTradeNoFromOrderID(legacyID) {
		t.Fatalf("close sent %q, want the id-derived %q — never the stored column", got, wxpay.OutTradeNoFromOrderID(legacyID))
	}
	if got := closer.closed[0]; len(got) != 32 || strings.Contains(got, "-") {
		t.Fatalf("close sent %q: want a 32-character hyphen-free trade number", got)
	}
	if got := closer.closed[1]; got != wxpay.OutTradeNoFromOrderID(nullColumn.ID) {
		t.Fatalf("NULL-column row must close on its derived id, got %q", got)
	}
}

func TestSweepSurvivesCancelFailureAndRerun(t *testing.T) {
	store := newFakeStore(feeOrder("flaky", 40))
	store.failCancel["flaky"] = 1
	closer := &fakeCloser{}

	summary, err := Sweep(context.Background(), store, closer, DefaultAge, time.Now().UTC())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if summary.Skipped != 1 || summary.Closed != 0 {
		t.Fatalf("a failed cancel must skip, not fail: %+v", summary)
	}
	// The retry (a crash between close and refund heals the same way: the
	// upstream close lands on an already-closed order, inert code -> nil).
	summary, err = Sweep(context.Background(), store, closer, DefaultAge, time.Now().UTC())
	if err != nil {
		t.Fatalf("rerun: %v", err)
	}
	if summary.Closed != 1 {
		t.Fatalf("the rerun must finish the refund: %+v", summary)
	}
	// And a third run matches zero rows everywhere: idempotent no-op.
	summary, err = Sweep(context.Background(), store, closer, DefaultAge, time.Now().UTC())
	if err != nil {
		t.Fatalf("third run: %v", err)
	}
	if summary.Closed != 0 || summary.Expired != 1 {
		t.Fatalf("resolved orders must stay resolved; the list keeps returning the row: %+v", summary)
	}
}

func TestSweepNilCloserIsNoop(t *testing.T) {
	store := newFakeStore(feeOrder("old-1", 45))
	summary, err := Sweep(context.Background(), store, nil, DefaultAge, time.Now().UTC())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if summary.Expired != 0 || summary.Closed != 0 {
		t.Fatalf("a nil closer (module inert) must not sweep: %+v", summary)
	}
}

func TestSweepLostRaceIsNotClosed(t *testing.T) {
	// The callback paid the order between the sweep's list and its cancel:
	// the guarded claim matches zero rows, the refund never happens, and the
	// sweep treats it as a silent no-op rather than an error.
	store := newFakeStore(feeOrder("raced", 40))
	store.closed["raced"] = true // simulate the callback having resolved it as paid
	closer := &fakeCloser{}

	summary, err := Sweep(context.Background(), store, closer, DefaultAge, time.Now().UTC())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if summary.Closed != 0 || summary.Skipped != 0 {
		t.Fatalf("a raced order must be a silent no-op: %+v", summary)
	}
}
