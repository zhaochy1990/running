package storage

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

// seedAdminBalance pins a balance row with an explicit updated_at so the
// updated_at_desc ordering tests are deterministic.
func seedAdminBalance(t *testing.T, st *Store, uid string, balance int, at time.Time) {
	t.Helper()
	err := st.db.Exec(
		"INSERT INTO user_points (user_id, balance, updated_at) VALUES (?, ?, ?) "+
			"ON DUPLICATE KEY UPDATE balance = VALUES(balance), updated_at = VALUES(updated_at)",
		uid, balance, at.UTC(),
	).Error
	if err != nil {
		t.Fatalf("seed balance: %v", err)
	}
}

// migrateProviderTable creates provider_credentials; openTestStore's base
// AutoMigrate does not cover the watch models.
func migrateProviderTable(t *testing.T, st *Store) {
	t.Helper()
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
}

// seedProvider inserts one watch binding row.
func seedProvider(t *testing.T, st *Store, uid, provider string, at time.Time) {
	t.Helper()
	row := &ProviderCredential{
		UserID: uid, Provider: provider, UpdatedAt: at.UTC(),
		Secret: []byte("test-secret"),
	}
	if err := st.db.Create(row).Error; err != nil {
		t.Fatalf("seed provider: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/points/balances — storage side
// ─────────────────────────────────────────────────────────────────────────────

func TestAdminPointBalances_SortsPaginationAndFilters(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigratePoints(ctx); err != nil {
		t.Fatalf("automigrate points: %v", err)
	}
	migrateProviderTable(t, st)

	base := time.Now().UTC().Add(-time.Hour)
	ids := make([]string, 4)
	for i := range ids {
		ids[i] = uuid.NewString()
	}
	// updated_at ordering: u0 newest … u3 oldest. Balances chosen so the
	// balance sorts walk a different order (u2 > u1 > u3 > u0).
	seedAdminBalance(t, st, ids[0], 5, base.Add(3*time.Minute))
	seedAdminBalance(t, st, ids[1], 40, base.Add(2*time.Minute))
	seedAdminBalance(t, st, ids[2], 100, base.Add(1*time.Minute))
	seedAdminBalance(t, st, ids[3], 10, base)
	// The shared test database holds unrelated user_points rows; every
	// ordering assertion runs through the id-set filter so the fixture is
	// isolated regardless of what else the table carries.
	all := []string{ids[0], ids[1], ids[2], ids[3]}

	t.Run("default sort is updated_at_desc", func(t *testing.T) {
		page, err := st.AdminListPointBalances(ctx, "", "", 0, "", all)
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		var got []string
		for _, row := range page.Items {
			got = append(got, row.UserID)
		}
		if len(got) != 4 || got[0] != ids[0] || got[3] != ids[3] {
			t.Fatalf("order = %v, want newest first %v", got, ids)
		}
	})

	t.Run("balance sorts walk both directions", func(t *testing.T) {
		desc, err := st.AdminListPointBalances(ctx, PointBalanceSortBalanceDesc, "", 0, "", all)
		if err != nil {
			t.Fatalf("list desc: %v", err)
		}
		var seen []int
		for _, row := range desc.Items {
			seen = append(seen, row.Balance)
		}
		if len(seen) != 4 || seen[0] != 100 || seen[1] != 40 || seen[2] != 10 || seen[3] != 5 {
			t.Fatalf("balance desc = %v, want [100 40 10 5]", seen)
		}
		asc, err := st.AdminListPointBalances(ctx, PointBalanceSortBalanceAsc, "", 0, "", all)
		if err != nil {
			t.Fatalf("list asc: %v", err)
		}
		if asc.Items[0].Balance != 5 || asc.Items[3].Balance != 100 {
			t.Fatalf("balance asc = %d..%d, want 5..100", asc.Items[0].Balance, asc.Items[3].Balance)
		}
	})

	t.Run("cursor pagination walks every row exactly once", func(t *testing.T) {
		var got []string
		cursor := ""
		for round := 0; round < 10; round++ {
			page, err := st.AdminListPointBalances(ctx, PointBalanceSortUpdatedAtDesc, cursor, 2, "", all)
			if err != nil {
				t.Fatalf("page %d: %v", round, err)
			}
			for _, row := range page.Items {
				got = append(got, row.UserID)
			}
			if page.NextCursor == "" {
				break
			}
			cursor = page.NextCursor
		}
		if len(got) != 4 || got[0] != ids[0] || got[3] != ids[3] {
			t.Fatalf("cursor walk = %v, want all four newest first", got)
		}
	})

	t.Run("balance cursor carries its own key", func(t *testing.T) {
		page, err := st.AdminListPointBalances(ctx, PointBalanceSortBalanceDesc, "", 2, "", all)
		if err != nil {
			t.Fatalf("first page: %v", err)
		}
		if page.NextCursor == "" {
			t.Fatalf("first page: no cursor for a 4-row set")
		}
		page2, err := st.AdminListPointBalances(ctx, PointBalanceSortBalanceDesc, page.NextCursor, 2, "", all)
		if err != nil {
			t.Fatalf("second page: %v", err)
		}
		// Scoped to the fixture: two deterministic pages, no repeats.
		if len(page.Items) != 2 || len(page2.Items) != 2 {
			t.Fatalf("pages = %d + %d rows, want 2 + 2", len(page.Items), len(page2.Items))
		}
		seen := map[string]bool{}
		for _, row := range append(append([]AdminPointBalance{}, page.Items...), page2.Items...) {
			if seen[row.UserID] {
				t.Fatalf("user %s repeated across balance pages", row.UserID)
			}
			seen[row.UserID] = true
		}
	})

	t.Run("cursor minted for another sort is rejected", func(t *testing.T) {
		page, err := st.AdminListPointBalances(ctx, PointBalanceSortBalanceDesc, "", 1, "", all)
		if err != nil {
			t.Fatalf("seed page: %v", err)
		}
		if page.NextCursor == "" {
			t.Fatalf("seed page: no cursor")
		}
		if _, err := st.AdminListPointBalances(ctx, PointBalanceSortUpdatedAtDesc, page.NextCursor, 2, "", nil); err == nil {
			t.Fatalf("cross-sort cursor accepted")
		}
	})

	t.Run("user_id filter is exact", func(t *testing.T) {
		page, err := st.AdminListPointBalances(ctx, "", "", 0, ids[2], nil)
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		if len(page.Items) != 1 || page.Items[0].UserID != ids[2] || page.Items[0].Balance != 100 {
			t.Fatalf("items = %+v, want exactly %s@100", page.Items, ids[2])
		}
	})

	t.Run("empty phone id set yields an empty page", func(t *testing.T) {
		page, err := st.AdminListPointBalances(ctx, "", "", 0, "", []string{})
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		if len(page.Items) != 0 || page.NextCursor != "" {
			t.Fatalf("items = %+v, want empty page", page.Items)
		}
	})

	t.Run("phone id set filters and canonicalizes", func(t *testing.T) {
		// Mixed-case ids must never leak past the canonical guard.
		page, err := st.AdminListPointBalances(ctx, "", "", 0, "", []string{ids[1], ids[3]})
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		if len(page.Items) != 2 {
			t.Fatalf("items = %d, want 2", len(page.Items))
		}
	})

	t.Run("validation rejections", func(t *testing.T) {
		if _, err := st.AdminListPointBalances(ctx, "balance", "", 0, "", nil); err == nil {
			t.Fatalf("invalid sort accepted")
		}
		if _, err := st.AdminListPointBalances(ctx, "", "", 99, "", nil); err == nil {
			t.Fatalf("oversized limit accepted")
		}
	})
}

func TestAdminPointBalances_ProvidersByUser(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigratePoints(ctx); err != nil {
		t.Fatalf("automigrate points: %v", err)
	}

	double := uuid.NewString()
	single := uuid.NewString()
	none := uuid.NewString()
	seedAdminBalance(t, st, double, 1, time.Now().UTC())
	seedAdminBalance(t, st, single, 2, time.Now().UTC())
	seedAdminBalance(t, st, none, 3, time.Now().UTC())
	// Double-bind: garmin bound first, coros re-bound (fresh updated_at) —
	// newest first is the display contract.
	migrateProviderTable(t, st)
	seedProvider(t, st, double, "garmin", time.Now().UTC().Add(-2*time.Hour))
	seedProvider(t, st, double, "coros", time.Now().UTC())
	seedProvider(t, st, single, "coros", time.Now().UTC())

	page, err := st.AdminListPointBalances(ctx, "", "", 0, "", []string{double, single, none})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	byID := map[string]AdminPointBalance{}
	for _, row := range page.Items {
		byID[row.UserID] = row
	}
	got := byID[double].Providers
	if len(got) != 2 || got[0] != "coros" || got[1] != "garmin" {
		t.Fatalf("double-bind providers = %v, want [coros garmin] (newest first)", got)
	}
	if p := byID[single].Providers; len(p) != 1 || p[0] != "coros" {
		t.Fatalf("single provider = %v, want [coros]", p)
	}
	if p := byID[none].Providers; len(p) != 0 {
		t.Fatalf("unbound providers = %v, want empty", p)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/points/balances/:user_id/adjustments — storage side
// ─────────────────────────────────────────────────────────────────────────────

func TestAdminPointAdjust_Balance(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigratePoints(ctx); err != nil {
		t.Fatalf("automigrate points: %v", err)
	}

	t.Run("increase on an existing balance", func(t *testing.T) {
		uid := uuid.NewString()
		seedAdminBalance(t, st, uid, 30, time.Now().UTC().Add(-time.Minute))
		res, err := st.AdminAdjustPointBalance(ctx, uid, 50, "活动补偿", time.Now().UTC())
		if err != nil {
			t.Fatalf("adjust: %v", err)
		}
		if res.Balance != 80 {
			t.Fatalf("balance = %d, want 80", res.Balance)
		}
		if res.Transaction.Type != PointTypeAdjust || res.Transaction.Amount != 50 {
			t.Fatalf("ledger = %s/%d, want adjust/50", res.Transaction.Type, res.Transaction.Amount)
		}
		if res.Transaction.Remark == nil || *res.Transaction.Remark != "活动补偿" {
			t.Fatalf("remark = %v, want the reason verbatim", res.Transaction.Remark)
		}
		if balance, err := readBalance(st.db.WithContext(ctx), uid); err != nil || balance != 80 {
			t.Fatalf("stored balance = %d (%v), want 80", balance, err)
		}
	})

	t.Run("deduction below zero is allowed (欠账 semantics)", func(t *testing.T) {
		uid := uuid.NewString()
		seedAdminBalance(t, st, uid, 10, time.Now().UTC())
		res, err := st.AdminAdjustPointBalance(ctx, uid, -100, "违规扣除", time.Now().UTC())
		if err != nil {
			t.Fatalf("adjust: %v", err)
		}
		if res.Balance != -90 {
			t.Fatalf("balance = %d, want -90", res.Balance)
		}
	})

	t.Run("bootstrap adjusts a user who never earned", func(t *testing.T) {
		uid := uuid.NewString()
		res, err := st.AdminAdjustPointBalance(ctx, uid, 7, "迁移补录", time.Now().UTC())
		if err != nil {
			t.Fatalf("adjust: %v", err)
		}
		if res.Balance != 7 {
			t.Fatalf("balance = %d, want 7", res.Balance)
		}
	})

	t.Run("validation rejections", func(t *testing.T) {
		uid := uuid.NewString()
		for _, amount := range []int{0, MaxPointAdjustAmount + 1, -MaxPointAdjustAmount - 1} {
			if _, err := st.AdminAdjustPointBalance(ctx, uid, amount, "r", time.Now().UTC()); err == nil {
				t.Fatalf("amount %d accepted", amount)
			}
		}
	})

	t.Run("concurrent adjustments sum exactly", func(t *testing.T) {
		uid := uuid.NewString()
		seedAdminBalance(t, st, uid, 0, time.Now().UTC())
		var wg sync.WaitGroup
		errs := make(chan error, 10)
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func(n int) {
				defer wg.Done()
				_, err := st.AdminAdjustPointBalance(ctx, uid, 1, fmt.Sprintf("并发-%d", n), time.Now().UTC())
				errs <- err
			}(i)
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatalf("concurrent adjust: %v", err)
			}
		}
		if balance, err := readBalance(st.db.WithContext(ctx), uid); err != nil || balance != 10 {
			t.Fatalf("balance = %d (%v), want 10", balance, err)
		}
	})
}
