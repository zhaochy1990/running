// point_sku_test.go drives the by_sku redemption domain against a real MySQL
// (devops#909): the sku_required/sku_invalid/out_of_stock shape checks, the
// SKU-row stock decrement with its single-mode compatibility, the
// product-level per_user_limit across SKUs, the concurrency proofs (no
// oversell on one row, no limit bypass across rows), and the cancel-time
// restock for both modes with its idempotent re-run. CI runs it via the
// "Points-shop + address book tests (MySQL)" step (the TestPointRedemption
// regex).
package storage

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// seedBySkuProduct inserts one active by_sku product.
func seedBySkuProduct(t *testing.T, st *Store, name string, price int) uint64 {
	t.Helper()
	description := "sku seed description"
	row := &PointProduct{
		Name: name, Description: &description, PointsPrice: price,
		Status: PointProductStatusActive, SpecMode: ProductSpecModeBySku,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if err := st.db.Create(row).Error; err != nil {
		t.Fatalf("seed by_sku product: %v", err)
	}
	return row.ID
}

// seedSku inserts one SKU row under the product and returns its id.
func seedSku(t *testing.T, st *Store, productID uint64, spec string, stock int) uint64 {
	t.Helper()
	row := &PointProductSku{
		ProductID: productID, SpecValue: spec, Stock: stock,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if err := st.db.Create(row).Error; err != nil {
		t.Fatalf("seed sku: %v", err)
	}
	return row.ID
}

func skuStock(t *testing.T, st *Store, skuID uint64) int {
	t.Helper()
	var row PointProductSku
	if err := st.db.Where("id = ?", skuID).First(&row).Error; err != nil {
		t.Fatalf("reload sku: %v", err)
	}
	return row.Stock
}

func productStock(t *testing.T, st *Store, productID uint64) int {
	t.Helper()
	var row PointProduct
	if err := st.db.Where("id = ?", productID).First(&row).Error; err != nil {
		t.Fatalf("reload product: %v", err)
	}
	return row.Stock
}

func redeemSkuReq(productID, skuID, addressID uint64, key string) RedemptionRequest {
	req := redeemReq(productID, addressID, key)
	req.SkuID = skuID
	return req
}

// ─────────────────────────────────────────────────────────────────────────────
// The by_sku redemption transaction
// ─────────────────────────────────────────────────────────────────────────────

func TestPointRedemptionSku_HappyPath(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	productID := seedBySkuProduct(t, st, "竞速背心", 50)
	skuL := seedSku(t, st, productID, "L", 3)
	skuXL := seedSku(t, st, productID, "XL", 1)
	addr := seedAddress(t, st, uid, true)

	res, err := st.CreateRedemption(ctx, uid, redeemSkuReq(productID, skuL, addr.ID, "sku-key-1"))
	if err != nil {
		t.Fatalf("redeem L: %v", err)
	}
	if res.Replayed || res.Order.Status != RedemptionStatusPendingShipment {
		t.Fatalf("order = %+v", res.Order)
	}
	// The SKU snapshot rides the order; the chosen row lost one unit, the
	// sibling row and the product-level column are untouched.
	if res.Order.SkuID == nil || *res.Order.SkuID != skuL ||
		res.Order.SkuLabel == nil || *res.Order.SkuLabel != "L" {
		t.Fatalf("sku snapshot wrong: %+v", res.Order)
	}
	if got := skuStock(t, st, skuL); got != 2 {
		t.Fatalf("sku L stock = %d, want 2", got)
	}
	if got := skuStock(t, st, skuXL); got != 1 {
		t.Fatalf("sku XL stock = %d, want 1", got)
	}
	if got := productStock(t, st, productID); got != 0 {
		t.Fatalf("product stock = %d, want 0 (by_sku never decrements it)", got)
	}
	if res.Balance != 50 {
		t.Fatalf("balance = %d, want 50", res.Balance)
	}

	// Idempotent replay returns the stored order with its size snapshot and
	// zero side effects.
	replay, err := st.CreateRedemption(ctx, uid, redeemSkuReq(productID, skuL, addr.ID, "sku-key-1"))
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !replay.Replayed || replay.Order.ID != res.Order.ID ||
		replay.Order.SkuLabel == nil || *replay.Order.SkuLabel != "L" {
		t.Fatalf("replay = %+v, want the stored order with label L", replay.Order)
	}
	if got := skuStock(t, st, skuL); got != 2 {
		t.Fatalf("replay decremented sku L: stock = %d, want 2", got)
	}
}

func TestPointRedemptionSku_ShapeChecks(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 1000)
	bySku := seedBySkuProduct(t, st, "背心-by_sku", 10)
	sku := seedSku(t, st, bySku, "M", 5)
	other := seedBySkuProduct(t, st, "背心-other", 10)
	otherSku := seedSku(t, st, other, "S", 5)
	single := seedProduct(t, st, "毛巾-single", 10, 5, 0, PointProductStatusActive)
	addr := seedAddress(t, st, uid, true)

	// by_sku without sku_id → sku_required, zero side effects.
	if _, err := st.CreateRedemption(ctx, uid, redeemReq(bySku, addr.ID, "sku-missing")); err == nil {
		t.Fatal("by_sku redeem without sku_id unexpectedly succeeded")
	} else if code := mustRedeemCode(t, err); code != RedemptionSkuRequired {
		t.Fatalf("code = %s, want sku_required", code)
	}
	// Foreign sku_id (another product's row) → sku_invalid.
	if _, err := st.CreateRedemption(ctx, uid, redeemSkuReq(bySku, otherSku, addr.ID, "sku-foreign")); err == nil {
		t.Fatal("foreign sku unexpectedly accepted")
	} else if code := mustRedeemCode(t, err); code != RedemptionSkuInvalid {
		t.Fatalf("code = %s, want sku_invalid", code)
	}
	// Unknown sku_id → sku_invalid too.
	if _, err := st.CreateRedemption(ctx, uid, redeemSkuReq(bySku, 999999, addr.ID, "sku-unknown")); err == nil {
		t.Fatal("unknown sku unexpectedly accepted")
	} else if code := mustRedeemCode(t, err); code != RedemptionSkuInvalid {
		t.Fatalf("code = %s, want sku_invalid", code)
	}
	// A single product rejects any sku_id: nothing can belong to it.
	if _, err := st.CreateRedemption(ctx, uid, redeemSkuReq(single, sku, addr.ID, "sku-on-single")); err == nil {
		t.Fatal("single product with sku_id unexpectedly accepted")
	} else if code := mustRedeemCode(t, err); code != RedemptionSkuInvalid {
		t.Fatalf("code = %s, want sku_invalid", code)
	}

	// Every rejection above rolled back: inventory untouched, no orders.
	if got := skuStock(t, st, sku); got != 5 {
		t.Fatalf("sku stock after rejections = %d, want 5", got)
	}
	if got := productStock(t, st, single); got != 5 {
		t.Fatalf("single stock after rejections = %d, want 5", got)
	}
	var orders int64
	st.db.Model(&PointRedemption{}).Where("user_id = ?", uid).Count(&orders)
	if orders != 0 {
		t.Fatalf("orders = %d, want 0", orders)
	}
}

func TestPointRedemptionSku_OutOfStock(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 1000)
	productID := seedBySkuProduct(t, st, "背心-soldout", 10)
	sku := seedSku(t, st, productID, "XL", 1)
	addr := seedAddress(t, st, uid, true)

	// Stock overshoot: ask 2 of 1 → out_of_stock, sku row untouched by the
	// rolled-back tx.
	req := redeemSkuReq(productID, sku, addr.ID, "sku-qty2")
	req.Quantity = 2
	if _, err := st.CreateRedemption(ctx, uid, req); err == nil {
		t.Fatal("qty-2 redeem on stock-1 sku unexpectedly succeeded")
	} else if code := mustRedeemCode(t, err); code != RedemptionOutOfStock {
		t.Fatalf("code = %s, want out_of_stock", code)
	}
	if got := skuStock(t, st, sku); got != 1 {
		t.Fatalf("sku stock after oversell attempt = %d, want 1", got)
	}
	if got := balanceOf(t, st, uid); got != 1000 {
		t.Fatalf("balance = %d, want 1000 (rollback)", got)
	}

	// A second buyer of the last unit succeeds and drains the row.
	uid2 := redemptionUser(t)
	seedUserBalance(t, st, uid2, 100)
	addr2 := seedAddress(t, st, uid2, false)
	if _, err := st.CreateRedemption(ctx, uid2, redeemSkuReq(productID, sku, addr2.ID, "sku-last")); err != nil {
		t.Fatalf("last-unit redeem: %v", err)
	}
	if got := skuStock(t, st, sku); got != 0 {
		t.Fatalf("sku stock = %d, want 0", got)
	}
	// One more unit on the empty row → out_of_stock.
	if _, err := st.CreateRedemption(ctx, uid2, redeemSkuReq(productID, sku, addr2.ID, "sku-empty")); err == nil {
		t.Fatal("empty-row redeem unexpectedly succeeded")
	} else if code := mustRedeemCode(t, err); code != RedemptionOutOfStock {
		t.Fatalf("code = %s, want out_of_stock", code)
	}
}

// TestPointRedemptionSku_LimitAcrossSkus proves the per_user_limit stays a
// product-level SUM(quantity): units bought through two different SKU rows
// add up against one allowance.
func TestPointRedemptionSku_LimitAcrossSkus(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 1000)
	productID := seedBySkuProduct(t, st, "背心-limited", 10)
	if err := st.db.Model(&PointProduct{ID: productID}).Update("per_user_limit", 2).Error; err != nil {
		t.Fatal(err)
	}
	skuS := seedSku(t, st, productID, "S", 10)
	skuM := seedSku(t, st, productID, "M", 10)
	addr := seedAddress(t, st, uid, true)

	if _, err := st.CreateRedemption(ctx, uid, redeemSkuReq(productID, skuS, addr.ID, "lim-1")); err != nil {
		t.Fatalf("first sku redeem: %v", err)
	}
	if _, err := st.CreateRedemption(ctx, uid, redeemSkuReq(productID, skuM, addr.ID, "lim-2")); err != nil {
		t.Fatalf("second sku redeem: %v", err)
	}
	// Third unit through yet another row breaches the product-level limit.
	skuL := seedSku(t, st, productID, "L", 10)
	if _, err := st.CreateRedemption(ctx, uid, redeemSkuReq(productID, skuL, addr.ID, "lim-3")); err == nil {
		t.Fatal("third unit unexpectedly succeeded past product limit 2")
	} else if code := mustRedeemCode(t, err); code != RedemptionLimitReached {
		t.Fatalf("code = %s, want limit_reached", code)
	}
}

// TestPointRedemptionSku_ConcurrentNoOversell proves the SKU-row guard: one
// unit on the row, many concurrent buyers → exactly one order.
func TestPointRedemptionSku_ConcurrentNoOversell(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	productID := seedBySkuProduct(t, st, "背心-race", 10)
	sku := seedSku(t, st, productID, "XL", 1)
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
			_, err := st.CreateRedemption(ctx, uid, redeemSkuReq(productID, sku, addrID, "buy-"+uuid.NewString()))
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
		t.Fatalf("wins = %d, want exactly 1 (sku stock=1)", wins)
	}
	if got := skuStock(t, st, sku); got != 0 {
		t.Fatalf("sku stock = %d, want 0", got)
	}
}

// TestPointRedemptionSku_ConcurrentLimitHolds is the #849 anti-bypass proof
// carried over to by_sku: same-product redemptions serialize on the product
// row lock even when they buy different SKUs, so parallel double-redeems
// cannot slip past per_user_limit.
func TestPointRedemptionSku_ConcurrentLimitHolds(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100000)
	productID := seedBySkuProduct(t, st, "背心-race-limit", 10)
	if err := st.db.Model(&PointProduct{ID: productID}).Update("per_user_limit", 1).Error; err != nil {
		t.Fatal(err)
	}
	skuS := seedSku(t, st, productID, "S", 100)
	skuM := seedSku(t, st, productID, "M", 100)
	addr := seedAddress(t, st, uid, false)

	const racers = 8
	codes := make([]RedemptionErrorCode, racers)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		sku := skuS
		if i%2 == 1 {
			sku = skuM // half the racers pick the sibling row
		}
		go func(i int, skuID uint64) {
			defer wg.Done()
			_, err := st.CreateRedemption(ctx, uid, redeemSkuReq(productID, skuID, addr.ID, "race-"+uuid.NewString()))
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
		}(i, sku)
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
	var orders int64
	st.db.Model(&PointRedemption{}).Where("user_id = ?", uid).Count(&orders)
	if orders != 1 {
		t.Fatalf("orders = %d, want 1", orders)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel-time restock (devops#909)
// ─────────────────────────────────────────────────────────────────────────────

func TestPointRedemptionSku_CancelRestock(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	now := time.Now().UTC()

	// by_sku fee order: timeout-cancel must refund the points AND refill the
	// SKU row — the pre-#909 gap kept the stock reserved forever.
	uid := redemptionUser(t)
	seedUserBalance(t, st, uid, 100)
	skuProduct := seedBySkuProduct(t, st, "背心-cancel", 50)
	if err := st.db.Model(&PointProduct{ID: skuProduct}).Updates(map[string]any{
		"shipping_policy": ShippingPolicyJZSHFee, "shipping_fee": 800,
	}).Error; err != nil {
		t.Fatal(err)
	}
	sku := seedSku(t, st, skuProduct, "L", 3)
	shandong := seedAddressIn(t, st, uid, "山东省")
	req := redeemReadyReq(skuProduct, shandong.ID, "cancel-sku-1")
	req.SkuID = sku
	res, err := st.CreateRedemption(ctx, uid, req)
	if err != nil {
		t.Fatalf("by_sku fee redeem: %v", err)
	}
	if res.Order.Status != RedemptionStatusPendingPayment {
		t.Fatalf("fee order status = %s, want pending_payment", res.Order.Status)
	}
	if got := skuStock(t, st, sku); got != 2 {
		t.Fatalf("sku stock after redeem = %d, want 2", got)
	}

	ok, err := st.CancelPendingRedemption(ctx, res.Order.ID, now)
	if err != nil || !ok {
		t.Fatalf("cancel: ok=%v err=%v", ok, err)
	}
	if got := skuStock(t, st, sku); got != 3 {
		t.Fatalf("sku stock after cancel = %d, want 3 (restocked)", got)
	}
	if got := balanceOf(t, st, uid); got != 100 {
		t.Fatalf("balance after cancel = %d, want 100 (refunded)", got)
	}

	// Double run is a no-op: the claim gate matches zero rows, nothing
	// double-restocks or double-refunds.
	ok, err = st.CancelPendingRedemption(ctx, res.Order.ID, now)
	if err != nil || ok {
		t.Fatalf("re-cancel: ok=%v err=%v, want ok=false", ok, err)
	}
	if got := skuStock(t, st, sku); got != 3 {
		t.Fatalf("sku stock after re-cancel = %d, want 3", got)
	}
	if got := balanceOf(t, st, uid); got != 100 {
		t.Fatalf("balance after re-cancel = %d, want 100", got)
	}

	// single fee order: same refill on the product-level column, no sku
	// snapshot on the order.
	uid2 := redemptionUser(t)
	seedUserBalance(t, st, uid2, 100)
	single := seedFeeProduct(t, st, "跑鞋-cancel", 50, 4, 800)
	shandong2 := seedAddressIn(t, st, uid2, "山东省")
	res2, err := st.CreateRedemption(ctx, uid2, redeemReadyReq(single, shandong2.ID, "cancel-single-1"))
	if err != nil {
		t.Fatalf("single fee redeem: %v", err)
	}
	if res2.Order.SkuID != nil || res2.Order.SkuLabel != nil {
		t.Fatalf("single order must carry no sku snapshot: %+v", res2.Order)
	}
	if got := productStock(t, st, single); got != 3 {
		t.Fatalf("single stock after redeem = %d, want 3", got)
	}
	if ok, err := st.CancelPendingRedemption(ctx, res2.Order.ID, now); err != nil || !ok {
		t.Fatalf("single cancel: ok=%v err=%v", ok, err)
	}
	if got := productStock(t, st, single); got != 4 {
		t.Fatalf("single stock after cancel = %d, want 4 (restocked)", got)
	}
	if got := balanceOf(t, st, uid2); got != 100 {
		t.Fatalf("single balance after cancel = %d, want 100", got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Lists carry the SKU rows; admin SKU-row maintenance
// ─────────────────────────────────────────────────────────────────────────────

func TestPointProductSku_ListsAndAdminCRUD(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)

	bySku := seedBySkuProduct(t, st, "背心-list", 10)
	seedSku(t, st, bySku, "B", 1)
	seedSku(t, st, bySku, "A", 2)
	single := seedProduct(t, st, "毛巾-list", 10, 7, 0, PointProductStatusActive)

	// User shop: by_sku carries the SKU rows in insertion order (same
	// sort_order → id ASC tiebreak), single carries none.
	shop, err := st.ListActiveProducts(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	var bySkuRow, singleRow *PointProductListing
	for i := range shop {
		switch shop[i].Product.ID {
		case bySku:
			bySkuRow = &shop[i]
		case single:
			singleRow = &shop[i]
		}
	}
	if bySkuRow == nil || len(bySkuRow.Skus) != 2 ||
		bySkuRow.Skus[0].SpecValue != "B" || bySkuRow.Skus[1].SpecValue != "A" {
		t.Fatalf("by_sku shop row = %+v (want skus B,A)", bySkuRow)
	}
	if singleRow == nil || len(singleRow.Skus) != 0 {
		t.Fatalf("single shop row must carry no skus: %+v", singleRow)
	}

	// Admin list mirrors the same shape.
	adminRows, err := st.AdminListProducts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The admin list is global, so only this run's product counts.
	adminSkus := -1
	for i := range adminRows {
		if adminRows[i].Product.ID == bySku {
			adminSkus = len(adminRows[i].Skus)
		}
	}
	if adminSkus != 2 {
		t.Fatalf("admin list skus for product %d = %d, want 2", bySku, adminSkus)
	}

	// CRUD: create under a missing product is product_not_found.
	if err := st.AdminCreateProductSku(ctx, 999999, &PointProductSku{SpecValue: "X"}); err != ErrPointProductNotFound {
		t.Fatalf("create under missing product err = %v, want ErrPointProductNotFound", err)
	}
	created := &PointProductSku{SpecValue: "C", Stock: 5, SortOrder: 3}
	if err := st.AdminCreateProductSku(ctx, bySku, created); err != nil {
		t.Fatalf("create sku: %v", err)
	}
	if created.ID == 0 || created.ProductID != bySku || created.CreatedAt.IsZero() || created.UpdatedAt.IsZero() {
		t.Fatalf("created = %+v (ids/timestamps must be stamped)", created)
	}

	// Patch: absolute stock, scoped to (product, sku).
	newStock, newLabel, newSort := 9, "C-plus", 1
	patched, err := st.AdminPatchProductSku(ctx, bySku, created.ID, SkuPatch{
		SpecValue: &newLabel, Stock: &newStock, SortOrder: &newSort,
	})
	if err != nil {
		t.Fatalf("patch sku: %v", err)
	}
	if patched.SpecValue != "C-plus" || patched.Stock != 9 || patched.SortOrder != 1 {
		t.Fatalf("patched = %+v", patched)
	}
	// Foreign product id → sku_not_found.
	if _, err := st.AdminPatchProductSku(ctx, single, created.ID, SkuPatch{}); err != ErrPointProductSkuNotFound {
		t.Fatalf("foreign patch err = %v, want ErrPointProductSkuNotFound", err)
	}

	// Delete: scoped the same way, then gone.
	if err := st.AdminDeleteProductSku(ctx, single, created.ID); err != ErrPointProductSkuNotFound {
		t.Fatalf("foreign delete err = %v, want ErrPointProductSkuNotFound", err)
	}
	if err := st.AdminDeleteProductSku(ctx, bySku, created.ID); err != nil {
		t.Fatalf("delete sku: %v", err)
	}
	var count int64
	if err := st.db.Model(&PointProductSku{}).Where("id = ?", created.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("deleted sku row still present (%d rows)", count)
	}
	if err := st.AdminDeleteProductSku(ctx, bySku, created.ID); err != ErrPointProductSkuNotFound {
		t.Fatalf("re-delete err = %v, want ErrPointProductSkuNotFound", err)
	}
}
