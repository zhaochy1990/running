package storage

import (
	"context"
	"testing"
)

// TestRaceDashboardRows_ScopeAndOrdering covers the dashboard row read: the
// country predicate, the inclusive-from / exclusive-to date bounds applied by
// the handler (the storage read itself is unbounded in time), and the
// race_date/name/id ordering the buckets inherit.
func TestRaceDashboardRows_ScopeAndOrdering(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()

	seedRaceEvent(t, st, "源A", "B赛事", "2031-05-02")
	seedRaceEvent(t, st, "源A", "A赛事", "2031-05-02")
	seedRaceEvent(t, st, "源A", "C赛事", "2031-05-10")
	seedRaceEvent(t, st, "源A", "早赛事", "2031-04-01")
	seedRaceEvent(t, st, "源A", "边界赛事", "2031-05-01")
	idOverseas := seedRaceEvent(t, st, "源A", "海外赛事", "2031-05-03")
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("id = ?", idOverseas).
		Update("country", "JPN").Error; err != nil {
		t.Fatalf("set country: %v", err)
	}

	rows, err := st.ListRaceCalendarDashboardRows(ctx, "CHN")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	// 全量按序返回,海外行(JPN)不在;时间域过滤是 handler 的职责。
	want := []string{"早赛事", "边界赛事", "A赛事", "B赛事", "C赛事"}
	if len(rows) != len(want) {
		t.Fatalf("rows = %v, want %v", namesOf(rows), want)
	}
	for i, row := range rows {
		if row.Name != want[i] {
			t.Fatalf("row[%d] = %s, want %s (ordering must be race_date,name,id)", i, row.Name, want[i])
		}
	}

	// 空国家 = 无过滤,海外行也返回。
	rows, err = st.ListRaceCalendarDashboardRows(ctx, "")
	if err != nil {
		t.Fatalf("list unbounded: %v", err)
	}
	if len(rows) != 6 {
		t.Fatalf("unbounded rows = %d (%v), want 6", len(rows), namesOf(rows))
	}
}

// TestRaceDashboardItemsByEventIDs covers the batch item read and its empty
// id-list guard.
func TestRaceDashboardItemsByEventIDs(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()

	idA := seedRaceEvent(t, st, "源A", "赛事A", "2031-05-01")
	idB := seedRaceEvent(t, st, "源A", "赛事B", "2031-05-02")
	for _, row := range []RaceCalendarItem{
		{RaceEventID: idA, Name: "全程", Type: "Marathon"},
		{RaceEventID: idA, Name: "半程", Type: "HalfMarathon"},
		{RaceEventID: idB, Name: "全程", Type: "Marathon"},
	} {
		if err := st.CreateRaceCalendarItem(ctx, &row); err != nil {
			t.Fatalf("seed item: %v", err)
		}
	}

	rows, err := st.ListRaceCalendarItemsByEventIDs(ctx, []uint64{idA})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("items = %d, want 2", len(rows))
	}
	rows, err = st.ListRaceCalendarItemsByEventIDs(ctx, nil)
	if err != nil {
		t.Fatalf("empty list: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("empty ids = %d rows, want 0", len(rows))
	}
}

// TestRaceDashboardCityContentByCities covers the batch city read.
func TestRaceDashboardCityContentByCities(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()

	for _, city := range []string{"厦门市", "杭州市"} {
		if _, err := st.UpsertRaceCityContent(ctx, &RaceCityContent{City: city}); err != nil {
			t.Fatalf("seed %s: %v", city, err)
		}
	}

	rows, err := st.ListRaceCityContentByCities(ctx, []string{"厦门市", "福州市"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 1 || rows[0].City != "厦门市" {
		t.Fatalf("rows = %+v, want only 厦门市", rows)
	}
	rows, err = st.ListRaceCityContentByCities(ctx, nil)
	if err != nil {
		t.Fatalf("empty list: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("empty cities = %d rows, want 0", len(rows))
	}
}

func namesOf(rows []RaceCalendarEvent) []string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Name)
	}
	return out
}
