package storage

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// shanghaiTime builds an instant from a Shanghai wall-clock time, the way a
// client experiences it.
func shanghaiTime(t *testing.T, y int, m time.Month, d, hh, mm, ss int) time.Time {
	t.Helper()
	return time.Date(y, m, d, hh, mm, ss, 0, shanghaiLoc)
}

func TestShanghaiDay_Boundary(t *testing.T) {
	// The day boundary flips at Shanghai midnight (#847 resolution item 2).
	before := shanghaiTime(t, 2026, 11, 3, 23, 59, 59)
	after := shanghaiTime(t, 2026, 11, 4, 0, 0, 1)
	if shanghaiDay(before) != shanghaiDay(after).AddDate(0, 0, -1) {
		t.Fatalf("day boundary wrong: %v vs %v", shanghaiDay(before), shanghaiDay(after))
	}
	if got := shanghaiDay(before).Format("2006-01-02"); got != "2026-11-03" {
		t.Fatalf("shanghaiDay = %q, want 2026-11-03", got)
	}
	// UTC instants land on their Shanghai calendar day: 2026-11-03 17:00 UTC is
	// already 2026-11-04 01:00 in Shanghai.
	if got := shanghaiDay(time.Date(2026, 11, 3, 17, 0, 0, 0, time.UTC)).Format("2006-01-02"); got != "2026-11-04" {
		t.Fatalf("UTC→Shanghai day = %q, want 2026-11-04", got)
	}
}

func TestRewardForPosition(t *testing.T) {
	// [1,1,1,1,2,2,3]: a full cycle pays 11 points (#847 resolution item 1).
	total := 0
	for pos := 1; pos <= 7; pos++ {
		total += rewardForPosition(pos)
	}
	if total != 11 {
		t.Fatalf("full cycle pays %d, want 11", total)
	}
	want := []int{1, 1, 1, 1, 2, 2, 3}
	for pos, w := range want {
		if got := rewardForPosition(pos + 1); got != w {
			t.Errorf("position %d pays %d, want %d", pos+1, got, w)
		}
	}
}

func TestPointCursorRoundTrip(t *testing.T) {
	cursor := pointCursor{ID: "11111111-1111-4111-8111-111111111111"}
	encoded, err := encodePointCursor(cursor)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodePointCursor(encoded)
	if err != nil || got != cursor {
		t.Fatalf("cursor = %+v, %v; want %+v", got, err, cursor)
	}
	for _, bad := range []string{"not-a-cursor", "", "b2VtZQ"} {
		if _, err := decodePointCursor(bad); err == nil {
			t.Errorf("malformed cursor %q unexpectedly accepted", bad)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// MySQL-backed behaviour tests: the state machine, the transaction, and the
// pagination are SQL-level (uk_user_date idempotency, ON DUPLICATE KEY
// upsert), so they only run against a real MySQL — see the "Check-in + points
// ledger tests (MySQL)" step in .github/workflows/ci.yml.
// ─────────────────────────────────────────────────────────────────────────────

// checkInUser returns a fresh per-test user id so reruns against a shared
// database never collide.
func checkInUser(t *testing.T) string {
	t.Helper()
	return uuid.NewString()
}

// migrateCheckInTables creates the three check-in/points tables openTestStore's
// base AutoMigrate does not cover.
func migrateCheckInTables(t *testing.T, st *Store) {
	t.Helper()
	ctx := context.Background()
	if err := st.AutoMigrateCheckIn(ctx); err != nil {
		t.Fatalf("automigrate check-in: %v", err)
	}
	if err := st.AutoMigratePoints(ctx); err != nil {
		t.Fatalf("automigrate points: %v", err)
	}
}

func TestCheckIn_StateMachineProgression(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateCheckInTables(t, st)
	uid := checkInUser(t)
	day := func(n int) time.Time {
		return shanghaiTime(t, 2026, 11, 1, 9, 0, 0).AddDate(0, 0, n)
	}

	// First check-in is D1; positions 1-7 pay [1,1,1,1,2,2,3]; day 8 rolls to a
	// new cycle's D1 (#847 state machine).
	wantPoints := []int{1, 1, 1, 1, 2, 2, 3, 1}
	balance := 0
	for i, wantPts := range wantPoints {
		res, err := st.CreateCheckIn(ctx, uid, day(i))
		if err != nil {
			t.Fatalf("day %d check-in: %v", i+1, err)
		}
		balance += wantPts
		if res.AlreadyCheckedIn {
			t.Fatalf("day %d: unexpected duplicate", i+1)
		}
		if res.CyclePosition != (i%7)+1 || res.StreakDays != (i%7)+1 {
			t.Fatalf("day %d: position = %d, want %d", i+1, res.CyclePosition, (i%7)+1)
		}
		if res.PointsEarned != wantPts {
			t.Fatalf("day %d: points = %d, want %d", i+1, res.PointsEarned, wantPts)
		}
		if res.D7Completed != (i == 6) {
			t.Fatalf("day %d: d7_completed = %v", i+1, res.D7Completed)
		}
		if res.Balance != balance {
			t.Fatalf("day %d: balance = %d, want %d", i+1, res.Balance, balance)
		}
	}
}

func TestCheckIn_BrokenStreakResets(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateCheckInTables(t, st)
	day := func(n int) time.Time {
		return shanghaiTime(t, 2026, 11, 1, 9, 0, 0).AddDate(0, 0, n)
	}

	// D1, then skip days, then check in again: missing 1 day and missing 3 days
	// carry the same semantics — the next check-in is a new cycle's D1.
	for _, tc := range []struct{ skip int }{{1}, {3}} {
		uid := checkInUser(t)
		if _, err := st.CreateCheckIn(ctx, uid, day(0)); err != nil {
			t.Fatal(err)
		}
		res, err := st.CreateCheckIn(ctx, uid, day(1+tc.skip))
		if err != nil {
			t.Fatal(err)
		}
		if res.CyclePosition != 1 || res.PointsEarned != 1 || res.D7Completed {
			t.Fatalf("skip %d: %+v, want new-cycle D1 with 1 point", tc.skip, res)
		}
	}
}

func TestCheckIn_DuplicateSameDayIdempotent(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateCheckInTables(t, st)
	uid := checkInUser(t)
	morning := shanghaiTime(t, 2026, 11, 5, 8, 0, 0)
	evening := shanghaiTime(t, 2026, 11, 5, 21, 0, 0)

	first, err := st.CreateCheckIn(ctx, uid, morning)
	if err != nil {
		t.Fatal(err)
	}
	second, err := st.CreateCheckIn(ctx, uid, evening)
	if err != nil {
		t.Fatal(err)
	}
	if !second.AlreadyCheckedIn || second.PointsEarned != 0 {
		t.Fatalf("duplicate = %+v, want already_checked_in with zero points", second)
	}
	if second.StreakDays != first.StreakDays || second.CyclePosition != first.CyclePosition {
		t.Fatalf("duplicate snapshots changed: %+v vs %+v", second, first)
	}
	if second.Balance != first.Balance {
		t.Fatalf("duplicate paid again: balance %d, want %d", second.Balance, first.Balance)
	}

	var rows []CheckInRecord
	if err := st.db.WithContext(ctx).Where("user_id = ?", uid).Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	var ledger []PointTransaction
	if err := st.db.WithContext(ctx).Where("user_id = ?", uid).Find(&ledger).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || len(ledger) != 1 {
		t.Fatalf("duplicate wrote rows: %d check-ins, %d ledger entries", len(rows), len(ledger))
	}
}

func TestCheckIn_ConcurrentSameDay(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateCheckInTables(t, st)
	uid := checkInUser(t)
	when := shanghaiTime(t, 2026, 11, 7, 8, 30, 0)

	// Same-day concurrent double submit: one INSERT wins, the other turns
	// idempotent (#847 resolution boundary ruling).
	const n = 4
	results := make([]*CheckInResult, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = st.CreateCheckIn(ctx, uid, when)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent check-in %d: %v", i, err)
		}
	}
	fresh := 0
	for _, res := range results {
		if !res.AlreadyCheckedIn {
			fresh++
		} else if res.PointsEarned != 0 {
			t.Fatalf("idempotent result paid points: %+v", res)
		}
	}
	if fresh != 1 {
		t.Fatalf("%d fresh check-ins, want exactly 1", fresh)
	}

	var balance int
	if err := st.db.WithContext(ctx).Raw("SELECT balance FROM user_points WHERE user_id = ?", uid).Scan(&balance).Error; err != nil {
		t.Fatal(err)
	}
	if balance != 1 {
		t.Fatalf("balance = %d, want 1 (zero double-earn)", balance)
	}
}

func TestCheckIn_CrossMidnightBothCount(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateCheckInTables(t, st)
	uid := checkInUser(t)

	// 23:59:59 and the next day's 00:00:01 are two different natural days —
	// both check-ins stand, and the streak advances (#847 boundary ruling).
	before := shanghaiTime(t, 2026, 11, 9, 23, 59, 59)
	after := shanghaiTime(t, 2026, 11, 10, 0, 0, 1)
	first, err := st.CreateCheckIn(ctx, uid, before)
	if err != nil {
		t.Fatal(err)
	}
	second, err := st.CreateCheckIn(ctx, uid, after)
	if err != nil {
		t.Fatal(err)
	}
	if first.CyclePosition != 1 || second.CyclePosition != 2 {
		t.Fatalf("positions = %d/%d, want 1/2", first.CyclePosition, second.CyclePosition)
	}
	if second.AlreadyCheckedIn {
		t.Fatal("midnight-crossing check-in wrongly treated as duplicate")
	}
}

func TestCheckInStatus_Derivations(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateCheckInTables(t, st)
	day := func(n int) time.Time {
		return shanghaiTime(t, 2026, 11, 1, 9, 0, 0).AddDate(0, 0, n)
	}

	t.Run("broken_or_first_day", func(t *testing.T) {
		uid := checkInUser(t)
		got, err := st.GetCheckInStatus(ctx, uid, day(5))
		if err != nil {
			t.Fatal(err)
		}
		if !got.CanCheckIn || got.StreakDays != 0 || !got.WouldStartNewCycle || got.RewardPreview != 1 {
			t.Fatalf("status = %+v, want fresh-cycle D1 shape", got)
		}
		if len(got.Cycle) != 7 || got.Cycle[0].Status != "today" || got.Cycle[1].Status != "upcoming" {
			t.Fatalf("cycle = %+v, want all-upcoming with D1=today", got.Cycle)
		}
	})

	t.Run("mid_cycle_live_streak", func(t *testing.T) {
		uid := checkInUser(t)
		for i := 0; i < 3; i++ { // D1..D3 on Nov 1..3, queried on Nov 4
			if _, err := st.CreateCheckIn(ctx, uid, day(i)); err != nil {
				t.Fatal(err)
			}
		}
		got, err := st.GetCheckInStatus(ctx, uid, day(3))
		if err != nil {
			t.Fatal(err)
		}
		// D1-D3 are done; today's check-in would be D4, which pays 1.
		if got.StreakDays != 3 || got.RewardPreview != 1 || got.WouldStartNewCycle {
			t.Fatalf("status = %+v, want streak 3, next reward 1 (D4)", got)
		}
		if got.Cycle[2].Status != "checked" || got.Cycle[3].Status != "today" || got.Cycle[4].Status != "upcoming" {
			t.Fatalf("cycle = %+v, want 3 checked + today + upcoming", got.Cycle)
		}
		if got.Cycle[3].Points != 1 {
			t.Fatalf("today cell preview = %d, want 1", got.Cycle[3].Points)
		}
	})

	t.Run("d7_completed_today_and_next_day_rollover", func(t *testing.T) {
		uid := checkInUser(t)
		var last *CheckInResult
		var err error
		for i := 0; i < 7; i++ {
			last, err = st.CreateCheckIn(ctx, uid, day(i))
			if err != nil {
				t.Fatal(err)
			}
		}
		if !last.D7Completed {
			t.Fatal("D7 check-in did not flag d7_completed")
		}
		// Same day, after the D7 check-in: the grid lights up row-complete.
		got, err := st.GetCheckInStatus(ctx, uid, day(6))
		if err != nil {
			t.Fatal(err)
		}
		if got.CanCheckIn || got.StreakDays != 7 || !got.WouldStartNewCycle {
			t.Fatalf("status = %+v, want completed-cycle shape", got)
		}
		for _, cell := range got.Cycle {
			if cell.Status != "checked" {
				t.Fatalf("cell %+v not checked; the row should be fully lit", cell)
			}
		}
		// Next day (unchecked): today starts the new cycle as D1.
		next, err := st.GetCheckInStatus(ctx, uid, day(7))
		if err != nil {
			t.Fatal(err)
		}
		if !next.CanCheckIn || next.StreakDays != 7 || next.RewardPreview != 1 || !next.WouldStartNewCycle {
			t.Fatalf("status = %+v, want rolling new-cycle shape with streak 7", next)
		}
		if next.Cycle[0].Status != "today" || next.Cycle[1].Status != "upcoming" {
			t.Fatalf("cycle = %+v, want new cycle with D1=today", next.Cycle)
		}
		// And the check-in itself lands as the new cycle's D1.
		res, err := st.CreateCheckIn(ctx, uid, day(7))
		if err != nil {
			t.Fatal(err)
		}
		if res.CyclePosition != 1 || res.PointsEarned != 1 || res.D7Completed {
			t.Fatalf("day-8 check-in = %+v, want new cycle D1", res)
		}
	})

	t.Run("month_block_carries_earned_points", func(t *testing.T) {
		uid := checkInUser(t)
		for i := 0; i < 5; i++ {
			if _, err := st.CreateCheckIn(ctx, uid, day(i)); err != nil {
				t.Fatal(err)
			}
		}
		got, err := st.GetCheckInStatus(ctx, uid, day(4))
		if err != nil {
			t.Fatal(err)
		}
		if got.MonthLabel != "2026-11" {
			t.Fatalf("month label = %q", got.MonthLabel)
		}
		want := []int{1, 1, 1, 1, 2}
		if len(got.MonthChecked) != len(want) {
			t.Fatalf("month entries = %d, want %d", len(got.MonthChecked), len(want))
		}
		for i, m := range got.MonthChecked {
			if m.Date.Format("2006-01-02") != day(i).Format("2006-01-02") || m.Points != want[i] {
				t.Fatalf("entry %d = %v %d, want %s %d", i, m.Date.Format("2006-01-02"), m.Points, day(i).Format("2006-01-02"), want[i])
			}
		}
	})
}

func TestListPointTransactions_Pagination(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateCheckInTables(t, st)
	uid := checkInUser(t)

	// Five check-ins over five days seed five earn_checkin ledger rows.
	for i := 0; i < 5; i++ {
		if _, err := st.CreateCheckIn(ctx, uid, shanghaiTime(t, 2026, 11, 1, 9, 0, 0).AddDate(0, 0, i)); err != nil {
			t.Fatal(err)
		}
	}

	seen := map[string]bool{}
	cursor := ""
	pages := 0
	for {
		page, err := st.ListPointTransactions(ctx, uid, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) > 2 {
			t.Fatalf("page %d returned %d items over the limit", pages, len(page.Items))
		}
		for _, row := range page.Items {
			if seen[row.ID] {
				t.Fatalf("row %s appeared on two pages", row.ID)
			}
			seen[row.ID] = true
			if row.Type != PointTypeEarnCheckin || row.Amount <= 0 || row.Ref == "" {
				t.Fatalf("ledger row %+v not an earn_checkin with ref", row)
			}
		}
		pages++
		if page.NextCursor == "" {
			break
		}
		if pages > 10 {
			t.Fatal("pagination did not terminate")
		}
		cursor = page.NextCursor
	}
	if len(seen) != 5 || pages != 3 {
		t.Fatalf("paginated %d rows over %d pages, want 5 rows over 3 pages", len(seen), pages)
	}

	if _, err := st.ListPointTransactions(ctx, uid, "broken-cursor", 2); err == nil {
		t.Fatal("malformed cursor unexpectedly accepted")
	}
	if _, err := st.ListPointTransactions(ctx, uid, "", 51); err == nil {
		t.Fatal("limit over the max unexpectedly accepted")
	}
}
