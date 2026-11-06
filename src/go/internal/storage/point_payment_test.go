// point_payment_test.go drives the shipping-fee state machine against a real
// MySQL (devops#904): the fee computation at redeem time, the inert-module
// gate with zero point movement, the callback's strictly one-way pending →
// paid transition, and the timeout sweep's cancel + refund with its
// idempotent re-run and callback-race semantics. CI runs it via the
// "Points-shop + address book tests (MySQL)" step (the TestWxpay regex).
package storage

import (
	"context"
	"testing"
	"time"
)

// seedFeeProduct inserts one jzsh_fee product charging feeFen outside 江浙沪.
func seedFeeProduct(t *testing.T, st *Store, name string, price, stock int, feeFen int) uint64 {
	t.Helper()
	description := "fee seed description"
	row := &PointProduct{
		Name: name, Description: &description, PointsPrice: price,
		Stock: stock, Status: PointProductStatusActive,
		ShippingPolicy: ShippingPolicyJZSHFee, ShippingFee: feeFen,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if err := st.db.Create(row).Error; err != nil {
		t.Fatalf("seed fee product: %v", err)
	}
	return row.ID
}

// seedAddressIn inserts one address-book row in the given province.
func seedAddressIn(t *testing.T, st *Store, uid, province string) *UserAddress {
	t.Helper()
	now := time.Now().UTC()
	row := &UserAddress{
		UserID: uid, ReceiverName: "李四", ReceiverPhone: "13900139000",
		Province: province, City: province, District: "某区",
		AddressDetail: "测试路 1 号", IsDefault: true,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := st.db.Create(row).Error; err != nil {
		t.Fatalf("seed address: %v", err)
	}
	return row
}

// redeemReadyReq is redeemReq with the payment module configured.
func redeemReadyReq(productID, addressID uint64, key string) RedemptionRequest {
	req := redeemReq(productID, addressID, key)
	req.PaymentReady = true
	return req
}

func orderPaidFen(t *testing.T, st *Store, orderID string) (string, int, *string, *time.Time) {
	t.Helper()
	var row PointRedemption
	if err := st.db.Where("id = ?", orderID).First(&row).Error; err != nil {
		t.Fatalf("reload order: %v", err)
	}
	return row.Status, row.ShippingFeeSnapshot, row.OutTradeNo, row.PaidAt
}

func balanceOf(t *testing.T, st *Store, uid string) int {
	t.Helper()
	b, err := readBalance(st.db, uid)
	if err != nil {
		t.Fatalf("read balance: %v", err)
	}
	return b
}

func TestWxpayRedeemFeeChargedState(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	productID := seedFeeProduct(t, st, "跑鞋", 50, 5, 800)
	shandong := seedAddressIn(t, st, uid, "山东省")

	// 山东地址: fee 800 fen charged, order parks in pending_payment.
	res, err := st.CreateRedemption(ctx, uid, redeemReadyReq(productID, shandong.ID, "wx-fee-key-1"))
	if err != nil {
		t.Fatalf("redeem (shandong): %v", err)
	}
	if res.Order.Status != RedemptionStatusPendingPayment || res.Order.PaymentState != PaymentStatePending {
		t.Fatalf("fee order state wrong: %+v", res.Order)
	}
	if res.Order.ShippingFeeSnapshot != 800 || res.Order.ShippingPolicySnapshot != ShippingPolicyJZSHFee {
		t.Fatalf("fee snapshot wrong: %+v", res.Order)
	}
	if res.Order.OutTradeNo == nil || *res.Order.OutTradeNo != res.Order.ID {
		t.Fatalf("out_trade_no must equal the order id: %+v", res.Order.OutTradeNo)
	}
	if res.Balance != 50 {
		t.Fatalf("balance = %d, want 50 (points deducted)", res.Balance)
	}

	// 上海地址 (another user, zero fee even under jzsh_fee): straight to
	// pending_shipment, payment_state=free, no out_trade_no.
	uid2 := redemptionUser(t)
	seedUserBalance(t, st, uid2, 100)
	shanghai2 := seedAddressIn(t, st, uid2, "上海市")
	res2, err := st.CreateRedemption(ctx, uid2, redeemReadyReq(productID, shanghai2.ID, "wx-fee-key-2"))
	if err != nil {
		t.Fatalf("redeem (shanghai): %v", err)
	}
	status, fee, tradeNo, paidAt := orderPaidFen(t, st, res2.Order.ID)
	if status != RedemptionStatusPendingShipment || fee != 0 || tradeNo != nil || paidAt != nil {
		t.Fatalf("zero-fee order must keep the stock shape: status=%s fee=%d tradeNo=%v paidAt=%v", status, fee, tradeNo, paidAt)
	}
	if res2.Order.PaymentState != PaymentStateFree {
		t.Fatalf("zero-fee payment_state = %s, want free", res2.Order.PaymentState)
	}
}

func TestWxpayPaymentUnavailableGate(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	productID := seedFeeProduct(t, st, "跑鞋", 50, 5, 800)
	addr := seedAddressIn(t, st, uid, "山东省")

	// Module unconfigured (PaymentReady=false): fee-charged redeem is rejected
	// payment_unavailable with ZERO side effects — stock restored, no points
	// deducted, no order, no ledger row.
	_, err := st.CreateRedemption(ctx, uid, redeemReq(productID, addr.ID, "wx-gate-key"))
	code := mustRedeemCode(t, err)
	if code != RedemptionPaymentUnavailable {
		t.Fatalf("code = %s, want payment_unavailable", code)
	}
	if got := balanceOf(t, st, uid); got != 100 {
		t.Fatalf("balance = %d, want 100 (zero deduction)", got)
	}
	var product PointProduct
	if err := st.db.Where("id = ?", productID).First(&product).Error; err != nil {
		t.Fatal(err)
	}
	if product.Stock != 5 {
		t.Fatalf("stock = %d, want 5 (rollback restored it)", product.Stock)
	}
	var orders, ledgers int64
	st.db.Model(&PointRedemption{}).Where("user_id = ?", uid).Count(&orders)
	st.db.Model(&PointTransaction{}).Where("user_id = ?", uid).Count(&ledgers)
	if orders != 0 || ledgers != 0 {
		t.Fatalf("gate rejection must leave no order/ledger rows: %d/%d", orders, ledgers)
	}
}

func TestWxpayMarkRedemptionPaidIdempotent(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	productID := seedFeeProduct(t, st, "跑鞋", 50, 5, 800)
	addr := seedAddressIn(t, st, uid, "山东省")
	res, err := st.CreateRedemption(ctx, uid, redeemReadyReq(productID, addr.ID, "wx-paid-key"))
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}

	// The verified callback: pending → paid, exactly once.
	paidAt := time.Now().UTC().Truncate(time.Second)
	ok, err := st.MarkRedemptionPaid(ctx, *res.Order.OutTradeNo, paidAt)
	if err != nil || !ok {
		t.Fatalf("first notify: ok=%v err=%v", ok, err)
	}
	status, _, _, stored := orderPaidFen(t, st, res.Order.ID)
	if status != RedemptionStatusPendingShipment || stored == nil {
		t.Fatalf("paid order must move to pending_shipment with paid_at: status=%s", status)
	}

	// A replayed notification no-ops.
	ok, err = st.MarkRedemptionPaid(ctx, *res.Order.OutTradeNo, time.Now().UTC())
	if err != nil || ok {
		t.Fatalf("replayed notify must be a no-op: ok=%v err=%v", ok, err)
	}
	// And a paid order can never be paid a second time by a different amount
	// window or a late duplicate.
	if got := balanceOf(t, st, uid); got != 50 {
		t.Fatalf("balance = %d, want 50 (no refund on paid)", got)
	}
}

func TestWxpayCancelPendingRedemptionRefund(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	productID := seedFeeProduct(t, st, "跑鞋", 50, 5, 800)
	addr := seedAddressIn(t, st, uid, "山东省")
	res, err := st.CreateRedemption(ctx, uid, redeemReadyReq(productID, addr.ID, "wx-cancel-key"))
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}

	// The sweep cancels and refunds in one transaction.
	now := time.Now().UTC()
	ok, err := st.CancelPendingRedemption(ctx, res.Order.ID, now)
	if err != nil || !ok {
		t.Fatalf("cancel: ok=%v err=%v", ok, err)
	}
	status, _, _, _ := orderPaidFen(t, st, res.Order.ID)
	if status != RedemptionStatusCancelled {
		t.Fatalf("status = %s, want cancelled", status)
	}
	if got := balanceOf(t, st, uid); got != 100 {
		t.Fatalf("balance = %d, want 100 (refunded)", got)
	}
	var ledger PointTransaction
	if err := st.db.Where("ref = ? AND type = ?", res.Order.ID, PointTypeAdjust).First(&ledger).Error; err != nil {
		t.Fatalf("adjust ledger row: %v", err)
	}
	if ledger.Amount != 50 || ledger.UserID != uid {
		t.Fatalf("adjust ledger = %+v, want +50 (the points cost)", ledger)
	}

	// A re-run (or a racing second sweep) matches zero rows: no double refund.
	ok, err = st.CancelPendingRedemption(ctx, res.Order.ID, now)
	if err != nil || ok {
		t.Fatalf("re-cancel must be a no-op: ok=%v err=%v", ok, err)
	}
	if got := balanceOf(t, st, uid); got != 100 {
		t.Fatalf("balance = %d, want 100 (single refund)", got)
	}
}

func TestWxpayCallbackWinsRaceOverSweep(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	productID := seedFeeProduct(t, st, "跑鞋", 50, 5, 800)
	addr := seedAddressIn(t, st, uid, "山东省")
	res, err := st.CreateRedemption(ctx, uid, redeemReadyReq(productID, addr.ID, "wx-race-key"))
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}

	// The callback pays first; the late sweep's cancel must refuse (money
	// moved — never cancel, never refund), and a late callback after the
	// cancel must equally refuse. Both directions of the race keep the
	// order consistent.
	paidAt := time.Now().UTC().Truncate(time.Second)
	if ok, err := st.MarkRedemptionPaid(ctx, *res.Order.OutTradeNo, paidAt); err != nil || !ok {
		t.Fatalf("pay: ok=%v err=%v", ok, err)
	}
	if ok, err := st.CancelPendingRedemption(ctx, res.Order.ID, time.Now().UTC()); err != nil || ok {
		t.Fatalf("late sweep cancel must refuse a paid order: ok=%v err=%v", ok, err)
	}
	status, _, _, _ := orderPaidFen(t, st, res.Order.ID)
	if status != RedemptionStatusPendingShipment {
		t.Fatalf("paid order must stay pending_shipment, got %s", status)
	}

	// The mirror race: cancelled first, then a late SUCCESS callback — the
	// refund already ran; the callback must NOT resurrect the order as paid.
	uid2 := redemptionUser(t)
	seedUserBalance(t, st, uid2, 100)
	addr2 := seedAddressIn(t, st, uid2, "山东省")
	res2, err := st.CreateRedemption(ctx, uid2, redeemReadyReq(productID, addr2.ID, "wx-race-key-2"))
	if err != nil {
		t.Fatalf("redeem 2: %v", err)
	}
	if ok, err := st.CancelPendingRedemption(ctx, res2.Order.ID, time.Now().UTC()); err != nil || !ok {
		t.Fatalf("cancel 2: ok=%v err=%v", ok, err)
	}
	if ok, err := st.MarkRedemptionPaid(ctx, *res2.Order.OutTradeNo, time.Now().UTC()); err != nil || ok {
		t.Fatalf("late callback after cancel must no-op: ok=%v err=%v", ok, err)
	}
	status2, _, _, paid := orderPaidFen(t, st, res2.Order.ID)
	if status2 != RedemptionStatusCancelled || paid != nil {
		t.Fatalf("cancelled order must stay cancelled unpaid: status=%s paid=%v", status2, paid)
	}
}

func TestWxpayLegacyRowsBehaveFree(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	// Seed a product row without touching the new columns (raw SQL insert, as
	// a pre-#904 database would hold it): the column defaults must make it
	// behave exactly as before — no fee anywhere, pending_shipment.
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	now := time.Now().UTC()
	if err := st.db.Exec(
		"INSERT INTO point_products (name, points_price, stock, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		"legacy毛巾", 50, 5, PointProductStatusActive, now, now,
	).Error; err != nil {
		t.Fatalf("seed legacy product: %v", err)
	}
	var product PointProduct
	if err := st.db.Where("name = ?", "legacy毛巾").First(&product).Error; err != nil {
		t.Fatal(err)
	}
	if product.ShippingPolicy != ShippingPolicyNationwideFree || product.ShippingFee != 0 {
		t.Fatalf("legacy product defaults wrong: %+v", product)
	}
	addr := seedAddressIn(t, st, uid, "山东省") // even an out-of-block province pays nothing
	res, err := st.CreateRedemption(ctx, uid, redeemReq(product.ID, addr.ID, "wx-legacy-key"))
	if err != nil {
		t.Fatalf("legacy redeem must succeed without payment config: %v", err)
	}
	status, fee, tradeNo, _ := orderPaidFen(t, st, res.Order.ID)
	if status != RedemptionStatusPendingShipment || fee != 0 || tradeNo != nil {
		t.Fatalf("legacy redeem shape changed: status=%s fee=%d tradeNo=%v", status, fee, tradeNo)
	}
}
