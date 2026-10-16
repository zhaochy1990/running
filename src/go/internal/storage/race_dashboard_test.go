package storage

import (
	"context"
	"reflect"
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

	ids := []uint64{
		seedRaceEvent(t, st, "源A", "B赛事", "2031-05-02"),
		seedRaceEvent(t, st, "源A", "A赛事", "2031-05-02"),
		seedRaceEvent(t, st, "源A", "C赛事", "2031-05-10"),
		seedRaceEvent(t, st, "源A", "早赛事", "2031-04-01"),
		seedRaceEvent(t, st, "源A", "边界赛事", "2031-05-01"),
	}
	idOverseas := seedRaceEvent(t, st, "源A", "海外赛事", "2031-05-03")
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("id = ?", idOverseas).
		Update("country", "JPN").Error; err != nil {
		t.Fatalf("set country: %v", err)
	}

	// The read is table-wide (the store takes only a country), so on a shared
	// database the fixture rows are picked out by id; membership and ordering
	// stay exact (devops#563).
	fixture := map[uint64]bool{}
	for _, id := range append(ids, idOverseas) {
		fixture[id] = true
	}
	fixtureNames := func(country string) []string {
		t.Helper()
		rows, err := st.ListRaceCalendarDashboardRows(ctx, country)
		if err != nil {
			t.Fatalf("list %q: %v", country, err)
		}
		var names []string
		for _, row := range rows {
			if fixture[row.ID] {
				names = append(names, row.Name)
			}
		}
		return names
	}

	// 海外行(JPN)不在;时间域过滤是 handler 的职责。
	want := []string{"早赛事", "边界赛事", "A赛事", "B赛事", "C赛事"}
	if got := fixtureNames("CHN"); !reflect.DeepEqual(got, want) {
		t.Fatalf("rows = %v, want %v (ordering must be race_date,name,id)", got, want)
	}

	// 空国家 = 无过滤,海外行也返回。
	wantAll := []string{"早赛事", "边界赛事", "A赛事", "B赛事", "海外赛事", "C赛事"}
	if got := fixtureNames(""); !reflect.DeepEqual(got, wantAll) {
		t.Fatalf("unbounded rows = %v, want %v", got, wantAll)
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

	// Fixture cities the shared local database never holds (devops#563).
	const seededCity = "测试市-甲"
	addRaceCityContentCleanup(t, st, seededCity, "测试市-乙")
	for _, city := range []string{seededCity, "测试市-乙"} {
		if _, err := st.UpsertRaceCityContent(ctx, &RaceCityContent{City: city}); err != nil {
			t.Fatalf("seed %s: %v", city, err)
		}
	}

	rows, err := st.ListRaceCityContentByCities(ctx, []string{seededCity, "福州市"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 1 || rows[0].City != seededCity {
		t.Fatalf("rows = %+v, want only %s", rows, seededCity)
	}
	rows, err = st.ListRaceCityContentByCities(ctx, nil)
	if err != nil {
		t.Fatalf("empty list: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("empty cities = %d rows, want 0", len(rows))
	}
}
