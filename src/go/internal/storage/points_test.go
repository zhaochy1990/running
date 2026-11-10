package storage

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

// redemptionUser is a fresh user id per run: every test is re-runnable against
// a database that already holds rows.
func redemptionUser(t *testing.T) string {
	t.Helper()
	return uuid.NewString()
}

// migrateRedemptionTables creates the tables openTestStore's base AutoMigrate
// does not cover.
func migrateRedemptionTables(t *testing.T, st *Store) {
	t.Helper()
	ctx := context.Background()
	if err := st.AutoMigratePoints(ctx); err != nil {
		t.Fatalf("automigrate points: %v", err)
	}
	if err := st.AutoMigrateAddresses(ctx); err != nil {
		t.Fatalf("automigrate addresses: %v", err)
	}
}

// seedUserBalance pins a user's materialized balance (the tests control the
// ledger state directly; earning it via check-ins would need seven days).
func seedUserBalance(t *testing.T, st *Store, uid string, balance int) {
	t.Helper()
	err := st.db.Exec(
		"INSERT INTO user_points (user_id, balance, updated_at) VALUES (?, ?, ?) "+
			"ON DUPLICATE KEY UPDATE balance = VALUES(balance), updated_at = VALUES(updated_at)",
		uid, balance, time.Now().UTC(),
	).Error
	if err != nil {
		t.Fatalf("seed balance: %v", err)
	}
}

// seedProduct inserts one product row straight into the table.
func seedProduct(t *testing.T, st *Store, name string, price, stock, limit int, status string) uint64 {
	t.Helper()
	description := "seed description"
	row := &PointProduct{
		Name: name, Description: &description, PointsPrice: price,
		Stock: stock, PerUserLimit: limit, Status: status,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if err := st.db.Create(row).Error; err != nil {
		t.Fatalf("seed product: %v", err)
	}
	return row.ID
}

// seedAddress inserts one address-book row directly (bypassing the ≤10 cap
// helpers where tests need raw rows).
func seedAddress(t *testing.T, st *Store, uid string, isDefault bool) *UserAddress {
	t.Helper()
	now := time.Now().UTC()
	row := &UserAddress{
		UserID: uid, ReceiverName: "张三", ReceiverPhone: "13800138000",
		Province: "上海市", City: "上海市", District: "浦东新区",
		AddressDetail: "世纪大道 100 号", IsDefault: isDefault,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := st.db.Create(row).Error; err != nil {
		t.Fatalf("seed address: %v", err)
	}
	return row
}

// redeemReq builds a redeem request against a product/address pair.
func redeemReq(productID uint64, addressID uint64, key string) RedemptionRequest {
	return RedemptionRequest{ProductID: productID, AddressID: addressID, IdempotencyKey: key}
}

func mustRedeemCode(t *testing.T, err error) RedemptionErrorCode {
	t.Helper()
	var e *RedemptionError
	if !errors.As(err, &e) {
		t.Fatalf("err = %v, want *RedemptionError", err)
	}
	return e.Code
}

// ─────────────────────────────────────────────────────────────────────────────
// The redemption transaction
// ─────────────────────────────────────────────────────────────────────────────

func TestPointRedemption_HappyPath(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	productID := seedProduct(t, st, "毛巾", 50, 5, 0, PointProductStatusActive)
	addr := seedAddress(t, st, uid, true)

	res, err := st.CreateRedemption(ctx, uid, redeemReq(productID, addr.ID, "key-1"))
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}
	if res.Replayed {
		t.Fatal("first redeem must not be a replay")
	}
	o := res.Order
	if o.ID == "" || o.Status != RedemptionStatusPendingShipment {
		t.Fatalf("order = %+v", o)
	}
	if o.ProductID != productID || o.ProductName != "毛巾" || o.PointsCost != 50 {
		t.Fatalf("snapshot wrong: %+v", o)
	}
	if o.ReceiverName != "张三" || o.Province != "上海市" || o.AddressDetail != "世纪大道 100 号" {
		t.Fatalf("receiver snapshot wrong: %+v", o)
	}
	if res.Balance != 50 {
		t.Fatalf("balance = %d, want 50", res.Balance)
	}
	var product PointProduct
	if err := st.db.Where("id = ?", productID).First(&product).Error; err != nil {
		t.Fatal(err)
	}
	if product.Stock != 4 {
		t.Fatalf("stock = %d, want 4", product.Stock)
	}
	// Ledger row: type=redeem, amount=-X, ref=order id (#850 step 4).
	var ledger PointTransaction
	if err := st.db.Where("ref = ?", o.ID).First(&ledger).Error; err != nil {
		t.Fatalf("ledger row: %v", err)
	}
	if ledger.Type != PointTypeRedeem || ledger.Amount != -50 || ledger.UserID != uid {
		t.Fatalf("ledger = %+v", ledger)
	}
}

func TestPointRedemption_IdempotentReplay_Sequential(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	productID := seedProduct(t, st, "贴纸", 20, 10, 0, PointProductStatusActive)
	addr := seedAddress(t, st, uid, false)

	first, err := st.CreateRedemption(ctx, uid, redeemReq(productID, addr.ID, "same-key"))
	if err != nil {
		t.Fatalf("first redeem: %v", err)
	}
	second, err := st.CreateRedemption(ctx, uid, redeemReq(productID, addr.ID, "same-key"))
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !second.Replayed || second.Order.ID != first.Order.ID {
		t.Fatalf("replay = %+v, want order %s", second, first.Order.ID)
	}
	if second.Balance != 80 {
		t.Fatalf("replay balance = %d, want 80 (deducted once)", second.Balance)
	}
	var product PointProduct
	if err := st.db.Where("id = ?", productID).First(&product).Error; err != nil {
		t.Fatal(err)
	}
	if product.Stock != 9 {
		t.Fatalf("stock = %d, want 9 (decremented once)", product.Stock)
	}
	var count int64
	if err := st.db.Model(&PointRedemption{}).Where("user_id = ?", uid).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("orders = %d, want 1", count)
	}
}

// TestPointRedemption_Quantity_MultiUnit proves the quantity semantics: cost
// = price × quantity, stock decrements by quantity, and per_user_limit counts
// UNITS (SUM(quantity)) not orders — one qty-3 order eats three of the
// allowance.
func TestPointRedemption_Quantity_MultiUnit(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 200)
	productID := seedProduct(t, st, "毛巾-qty", 50, 5, 3, PointProductStatusActive)
	addr := seedAddress(t, st, uid, true)

	req := redeemReq(productID, addr.ID, "key-q1")
	req.Quantity = 3
	res, err := st.CreateRedemption(ctx, uid, req)
	if err != nil {
		t.Fatalf("redeem qty=3: %v", err)
	}
	if res.Order.Quantity != 3 || res.Order.PointsCost != 150 {
		t.Fatalf("order = %+v, want quantity 3 cost 150", res.Order)
	}
	if res.Balance != 50 {
		t.Fatalf("balance = %d, want 50", res.Balance)
	}
	var product PointProduct
	if err := st.db.Where("id = ?", productID).First(&product).Error; err != nil {
		t.Fatal(err)
	}
	if product.Stock != 2 {
		t.Fatalf("stock = %d, want 2", product.Stock)
	}

	// Units semantics: 3 units already redeemed against limit 3 — one more
	// unit (a second ORDER) must breach, same as a third qty-1 order would.
	if _, err := st.CreateRedemption(ctx, uid, redeemReq(productID, addr.ID, "key-q2")); err != nil {
		if code := mustRedeemCode(t, err); code != RedemptionLimitReached {
			t.Fatalf("code = %s, want limit_reached", code)
		}
	} else {
		t.Fatal("second order unexpectedly succeeded past unit limit")
	}

	// Stock overshoot on an unlimited product: stock 2, ask 3 → out_of_stock,
	// stock untouched by the rolled-back tx.
	p2 := seedProduct(t, st, "水壶-qty", 10, 2, 0, PointProductStatusActive)
	req3 := redeemReq(p2, addr.ID, "key-q3")
	req3.Quantity = 3
	if _, err := st.CreateRedemption(ctx, uid, req3); err != nil {
		if code := mustRedeemCode(t, err); code != RedemptionOutOfStock {
			t.Fatalf("code = %s, want out_of_stock", code)
		}
	} else {
		t.Fatal("overshoot redeem unexpectedly succeeded")
	}
	var p2row PointProduct
	if err := st.db.Where("id = ?", p2).First(&p2row).Error; err != nil {
		t.Fatal(err)
	}
	if p2row.Stock != 2 {
		t.Fatalf("stock after failed overshoot = %d, want 2", p2row.Stock)
	}
}

func TestPointRedemption_LimitReached_Sequential(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 1000)
	productID := seedProduct(t, st, "贴纸-limited", 20, 10, 1, PointProductStatusActive)
	addr := seedAddress(t, st, uid, false)

	if _, err := st.CreateRedemption(ctx, uid, redeemReq(productID, addr.ID, "k1")); err != nil {
		t.Fatalf("first redeem: %v", err)
	}
	if _, err := st.CreateRedemption(ctx, uid, redeemReq(productID, addr.ID, "k2")); err != nil {
		code := mustRedeemCode(t, err)
		if code != RedemptionLimitReached {
			t.Fatalf("code = %s, want limit_reached", code)
		}
	} else {
		t.Fatal("second redeem unexpectedly succeeded")
	}
	var count int64
	if err := st.db.Model(&PointRedemption{}).Where("user_id = ?", uid).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("orders = %d, want 1", count)
	}
	// Another product is unaffected by this product's limit.
	other := seedProduct(t, st, "帽子-limited-other", 20, 5, 0, PointProductStatusActive)
	if _, err := st.CreateRedemption(ctx, uid, redeemReq(other, addr.ID, "k3")); err != nil {
		t.Fatalf("other product redeem: %v", err)
	}
}

// TestPointRedemption_ConcurrentSameProduct_LimitHolds is the #849 revision's
// anti-bypass proof: COUNT runs after the stock UPDATE, so parallel
// double-redeems cannot slip past per_user_limit.
func TestPointRedemption_ConcurrentSameProduct_LimitHolds(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100000)
	productID := seedProduct(t, st, "钥匙扣-limited", 10, 100, 1, PointProductStatusActive)
	addr := seedAddress(t, st, uid, false)

	const racers = 8
	codes := make([]RedemptionErrorCode, racers)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res, err := st.CreateRedemption(ctx, uid, redeemReq(productID, addr.ID, "race-"+uuid.NewString()))
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				var e *RedemptionError
				if !errors.As(err, &e) {
					t.Errorf("racer %d: unexpected error %v", i, err)
					return
				}
				codes[i] = e.Code
				return
			}
			if res.Replayed {
				t.Errorf("racer %d: fresh key replayed — impossible", i)
			}
			codes[i] = ""
		}(i)
	}
	wg.Wait()
	wins := 0
	for _, c := range codes {
		if c == "" {
			wins++
			continue
		}
		if c != RedemptionLimitReached {
			t.Fatalf("unexpected rejection %s", c)
		}
	}
	if wins != 1 {
		t.Fatalf("wins = %d, want exactly 1 (per_user_limit=1)", wins)
	}
	var product PointProduct
	if err := st.db.Where("id = ?", productID).First(&product).Error; err != nil {
		t.Fatal(err)
	}
	if product.Stock != 99 {
		t.Fatalf("stock = %d, want 99 (exactly one decrement persisted)", product.Stock)
	}
	var count int64
	if err := st.db.Model(&PointRedemption{}).Where("user_id = ?", uid).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("orders = %d, want 1", count)
	}
}

// TestPointRedemption_ConcurrentNoOversell proves the stock>0 guard: one unit
// on the shelf, many concurrent buyers → exactly one order.
func TestPointRedemption_ConcurrentNoOversell(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	productID := seedProduct(t, st, "绝版勋章", 10, 1, 0, PointProductStatusActive)
	const racers = 6
	codes := make([]RedemptionErrorCode, racers)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		uid := redemptionUser(t)
		seedUserBalance(t, st, uid, 100)
		addr := seedAddress(t, st, uid, false)
		go func(i int, uid string, addrID uint64) {
			defer wg.Done()
			_, err := st.CreateRedemption(ctx, uid, redeemReq(productID, addrID, "buy-"+uuid.NewString()))
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				var e *RedemptionError
				if !errors.As(err, &e) {
					t.Errorf("racer %d: unexpected error %v", i, err)
					return
				}
				codes[i] = e.Code
				return
			}
			codes[i] = ""
		}(i, uid, addr.ID)
	}
	wg.Wait()
	wins := 0
	for _, c := range codes {
		if c == "" {
			wins++
			continue
		}
		if c != RedemptionOutOfStock {
			t.Fatalf("unexpected rejection %s", c)
		}
	}
	if wins != 1 {
		t.Fatalf("wins = %d, want exactly 1 (stock=1)", wins)
	}
	var product PointProduct
	if err := st.db.Where("id = ?", productID).First(&product).Error; err != nil {
		t.Fatal(err)
	}
	if product.Stock != 0 {
		t.Fatalf("stock = %d, want 0", product.Stock)
	}
}

func TestPointRedemption_InsufficientPoints(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t) // no user_points row at all
	productID := seedProduct(t, st, "贵品", 999, 5, 0, PointProductStatusActive)
	addr := seedAddress(t, st, uid, false)

	if _, err := st.CreateRedemption(ctx, uid, redeemReq(productID, addr.ID, "poor")); err != nil {
		if code := mustRedeemCode(t, err); code != RedemptionInsufficientPoints {
			t.Fatalf("code = %s, want insufficient_points", code)
		}
	} else {
		t.Fatal("redeem without balance unexpectedly succeeded")
	}
	var product PointProduct
	if err := st.db.Where("id = ?", productID).First(&product).Error; err != nil {
		t.Fatal(err)
	}
	if product.Stock != 5 {
		t.Fatalf("stock = %d, want 5 (tx rolled back)", product.Stock)
	}
	var count int64
	if err := st.db.Model(&PointRedemption{}).Where("user_id = ?", uid).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("orders = %d, want 0", count)
	}
}

func TestPointRedemption_ProductInactiveOrMissing(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	inactive := seedProduct(t, st, "下架品", 10, 5, 0, PointProductStatusInactive)
	addr := seedAddress(t, st, uid, false)

	_, err := st.CreateRedemption(ctx, uid, redeemReq(inactive, addr.ID, "k"))
	if code := mustRedeemCode(t, err); code != RedemptionProductInactive {
		t.Fatalf("code = %s, want product_inactive", code)
	}
	_, err = st.CreateRedemption(ctx, uid, redeemReq(999999, addr.ID, "k2"))
	if code := mustRedeemCode(t, err); code != RedemptionProductInactive {
		t.Fatalf("missing product: code = %s, want product_inactive", code)
	}
}

func TestPointRedemption_AddressNotFound(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	productID := seedProduct(t, st, "毛巾2", 10, 5, 0, PointProductStatusActive)

	_, err := st.CreateRedemption(ctx, uid, redeemReq(productID, 999999, "k"))
	if code := mustRedeemCode(t, err); code != RedemptionAddressNotFound {
		t.Fatalf("code = %s, want address_not_found", code)
	}
	// Another user's address is equally invisible.
	otherUID := redemptionUser(t)
	foreign := seedAddress(t, st, otherUID, false)
	_, err = st.CreateRedemption(ctx, uid, redeemReq(productID, foreign.ID, "k2"))
	if code := mustRedeemCode(t, err); code != RedemptionAddressNotFound {
		t.Fatalf("foreign address: code = %s, want address_not_found", code)
	}
}

func TestListUserRedemptions_CursorPagination(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 1000)
	productID := seedProduct(t, st, "分页品", 10, 50, 0, PointProductStatusActive)
	addr := seedAddress(t, st, uid, false)

	for i := 0; i < 3; i++ {
		if _, err := st.CreateRedemption(ctx, uid, redeemReq(productID, addr.ID, "page-"+uuid.NewString())); err != nil {
			t.Fatalf("redeem %d: %v", i, err)
		}
	}
	// Another user's orders must never leak into the page.
	otherUID := redemptionUser(t)
	seedUserBalance(t, st, otherUID, 100)
	if _, err := st.CreateRedemption(ctx, otherUID, redeemReq(productID, seedAddress(t, st, otherUID, false).ID, "other")); err != nil {
		t.Fatal(err)
	}

	page1, err := st.ListUserRedemptions(ctx, uid, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page1.Items) != 2 || page1.NextCursor == "" {
		t.Fatalf("page1 = %d items, cursor %q", len(page1.Items), page1.NextCursor)
	}
	if page1.Items[0].ID == page1.Items[1].ID {
		t.Fatal("page rows not distinct")
	}
	page2, err := st.ListUserRedemptions(ctx, uid, page1.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page2.Items) != 1 || page2.NextCursor != "" {
		t.Fatalf("page2 = %d items, cursor %q; want 1 item, empty cursor", len(page2.Items), page2.NextCursor)
	}
	if page2.Items[0].ID == page1.Items[0].ID || page2.Items[0].ID == page1.Items[1].ID {
		t.Fatal("page overlap")
	}
	if _, err := st.ListUserRedemptions(ctx, uid, "garbage", 2); err == nil {
		t.Fatal("garbage cursor accepted")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: products + ship
// ─────────────────────────────────────────────────────────────────────────────

func TestPointProduct_AdminCRUD(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)

	row := &PointProduct{Name: "admin品", PointsPrice: 100, Stock: 1, PerUserLimit: 0, Status: PointProductStatusActive}
	if err := st.AdminCreateProduct(ctx, row); err != nil {
		t.Fatalf("create: %v", err)
	}
	if row.ID == 0 || row.CreatedAt.IsZero() {
		t.Fatalf("row = %+v (timestamps must be stamped)", row)
	}
	rows, err := st.AdminListProducts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for i := range rows {
		if rows[i].Product.ID == row.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("created product missing from admin list")
	}

	price, stock, limit, sortOrder := 150, 7, 3, 9
	inactive := PointProductStatusInactive
	name := "admin品2"
	patched, err := st.AdminPatchProduct(ctx, row.ID, ProductPatch{
		Name: &name, PointsPrice: &price, Stock: &stock,
		PerUserLimit: &limit, Status: &inactive, SortOrder: &sortOrder,
	})
	if err != nil {
		t.Fatalf("patch: %v", err)
	}
	if patched.PointsPrice != 150 || patched.Stock != 7 || patched.PerUserLimit != 3 ||
		patched.Status != PointProductStatusInactive || patched.SortOrder != 9 || patched.Name != name {
		t.Fatalf("patched = %+v", patched)
	}
	if _, err := st.AdminPatchProduct(ctx, 999999, ProductPatch{}); err != ErrPointProductNotFound {
		t.Fatalf("missing id err = %v, want ErrPointProductNotFound", err)
	}
}

func TestAdminShipRedemption_Terminal(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	productID := seedProduct(t, st, "发货品", 10, 5, 0, PointProductStatusActive)
	addr := seedAddress(t, st, uid, false)
	res, err := st.CreateRedemption(ctx, uid, redeemReq(productID, addr.ID, "ship-me"))
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}
	now := time.Now().UTC()
	shipped, err := st.AdminShipRedemption(ctx, res.Order.ID, "顺丰速运", "SF123456", now)
	if err != nil {
		t.Fatalf("ship: %v", err)
	}
	if shipped.Status != RedemptionStatusShipped || shipped.TrackingNo == nil || *shipped.TrackingNo != "SF123456" {
		t.Fatalf("shipped = %+v", shipped)
	}
	if shipped.CourierCompany == nil || *shipped.CourierCompany != "顺丰速运" {
		t.Fatalf("courier = %v, want 顺丰速运", shipped.CourierCompany)
	}
	if shipped.ShippedAt == nil {
		t.Fatal("shipped_at missing")
	}
	// Re-ship is idempotent: current state returns, the original courier and
	// tracking number are not overwritten.
	again, err := st.AdminShipRedemption(ctx, res.Order.ID, "京东物流", "JD-OTHER", now)
	if err != nil {
		t.Fatalf("re-ship: %v", err)
	}
	if again.TrackingNo == nil || *again.TrackingNo != "SF123456" {
		t.Fatalf("re-ship tracking = %v, want the original SF123456", again.TrackingNo)
	}
	if again.CourierCompany == nil || *again.CourierCompany != "顺丰速运" {
		t.Fatalf("re-ship courier = %v, want the original 顺丰速运", again.CourierCompany)
	}
	if _, err := st.AdminShipRedemption(ctx, uuid.NewString(), "顺丰速运", "SF", now); err != ErrPointRedemptionNotFound {
		t.Fatalf("missing order err = %v, want ErrPointRedemptionNotFound", err)
	}
}
