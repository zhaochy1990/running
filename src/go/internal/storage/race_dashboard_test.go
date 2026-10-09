package storage

import (
	"context"
	"testing"
)

// TestRaceDashboardRows_ScopeAndOrdering covers the dashboard row read: the
// country predicate, the inclusive-from / exclusive-to date bound, and the
// race_date/name/id ordering the buckets inherit.
func TestRaceDashboardRows_ScopeAndOrdering(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()

	seedRaceEvent(t, st, "源A", "B赛事", "2031-05-02")
	seedRaceEvent(t, st, "源A", "A赛事", "2031-05-02")
	seedRaceEvent(t, st, "源A", "C赛事", "2031-05-10")
	seedRaceEvent(t, st, "源A", "早赛事", "2031-04-01")
	idOverseas := seedRaceEvent(t, st, "源A", "海外赛事", "2031-05-03")
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("id = ?", idOverseas).
		Update("country", "JPN").Error; err != nil {
		t.Fatalf("set country: %v", err)
	}

	// cn 谓词 = country 精确等于 CHN;from 含端点,to 不含端点。
	rows, err := st.ListRaceCalendarDashboardRows(ctx, RaceDashboardScope{
		Country: "CHN", FromDate: "2031-05-01", ToDate: "2031-05-10",
	})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	want := []string{"A赛事", "B赛事"}
	if len(rows) != len(want) {
		t.Fatalf("rows = %d, want %d (%+v)", len(rows), len(want), namesOf(rows))
	}
	for i, row := range rows {
		if row.Name != want[i] {
			t.Fatalf("row[%d] = %s, want %s (ordering must be race_date,name,id)", i, row.Name, want[i])
		}
	}

	// 无时间界:cn 全量按序返回。
	rows, err = st.ListRaceCalendarDashboardRows(ctx, RaceDashboardScope{Country: "CHN"})
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("cn rows = %d (%v), want 4", len(rows), namesOf(rows))
	}
	if rows[0].Name != "早赛事" || rows[3].Name != "C赛事" {
		t.Fatalf("ordering broken: %v", namesOf(rows))
	}
}

// TestRaceDashboardRows_NeverMaintainedBranch covers the widened read: a bare
// sync row from any season rides along a bounded window, while maintained and
// published rows stay bound by it.
func TestRaceDashboardRows_NeverMaintainedBranch(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()

	// 过去年份的裸同步行:唯一应当越界的行。
	seedRaceEvent(t, st, "源A", "过去裸行", "2021-01-01")
	// 过去年份但带内容:必须留在窗外。
	idContent := seedRaceEvent(t, st, "源A", "过去维护行", "2022-01-01")
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("id = ?", idContent).
		Updates(map[string]any{"climate": []byte(`{"summary":"x"}`)}).Error; err != nil {
		t.Fatalf("seed content: %v", err)
	}
	// 过去年份的已发布裸行:已发布的一票语义不受同步新增桶影响。
	idPublished := seedRaceEvent(t, st, "源A", "过去已发布行", "2023-01-01")
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("id = ?", idPublished).
		Update("published", true).Error; err != nil {
		t.Fatalf("seed published: %v", err)
	}
	// 窗内维护行:常规时间过滤返回。
	idFuture := seedRaceEvent(t, st, "源A", "未来维护行", "2031-06-01")
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("id = ?", idFuture).
		Updates(map[string]any{"climate": []byte(`{"summary":"x"}`)}).Error; err != nil {
		t.Fatalf("seed future content: %v", err)
	}

	// 不放宽:upcoming 只看到窗内行。
	rows, err := st.ListRaceCalendarDashboardRows(ctx, RaceDashboardScope{FromDate: "2031-01-01"})
	if err != nil {
		t.Fatalf("list narrow: %v", err)
	}
	if len(rows) != 1 || rows[0].Name != "未来维护行" {
		t.Fatalf("narrow rows = %v, want [未来维护行]", namesOf(rows))
	}

	// 放宽:过去裸行越界进入,维护行与已发布行仍被窗挡住。
	rows, err = st.ListRaceCalendarDashboardRows(ctx, RaceDashboardScope{
		FromDate: "2031-01-01", IncludeNeverMaintainedSync: true,
	})
	if err != nil {
		t.Fatalf("list widened: %v", err)
	}
	if len(rows) != 2 || rows[0].Name != "过去裸行" || rows[1].Name != "未来维护行" {
		t.Fatalf("widened rows = %v, want [过去裸行 未来维护行]", namesOf(rows))
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
