package storage

import (
	"context"
	"testing"
)

// migrateRaceContent ensures the race-content schema exists for the integration
// test and empties it (children first) so each test starts isolated. The
// race_calendar tables are cleared too: the content tests seed their own
// events. AutoMigrateRaceContent drops the retired pre-merge tables, so they
// are not in the clear list.
func migrateRaceContent(t *testing.T, st *Store) {
	t.Helper()
	ctx := context.Background()
	if err := st.AutoMigrateRaceCalendar(ctx); err != nil {
		t.Fatalf("automigrate race_calendar: %v", err)
	}
	if err := st.AutoMigrateRaceContent(ctx); err != nil {
		t.Fatalf("automigrate race content: %v", err)
	}
	for _, table := range []string{"race_city_content", "race_calendar_item", "race_calendar"} {
		if err := st.db.WithContext(ctx).Exec("DELETE FROM " + table).Error; err != nil {
			t.Fatalf("clear %s: %v", table, err)
		}
	}
}

// seedRaceEvent inserts one race_calendar event directly and returns its id,
// bypassing the sync merge so tests control the business key exactly.
func seedRaceEvent(t *testing.T, st *Store, source, name, raceDate string) uint64 {
	t.Helper()
	row := RaceCalendarEvent{
		Source: source, Name: name, RaceDate: raceDate, Country: "CHN",
		Month: 5, DayOfMonth: 1, Origin: RaceOriginSync,
	}
	if err := st.db.Create(&row).Error; err != nil {
		t.Fatalf("seed event: %v", err)
	}
	return row.ID
}

func floatPtr(v float64) *float64 { return &v }

func TestRaceCityContent_Upsert(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()

	// Create.
	in := &RaceCityContent{
		City:        "厦门市",
		Province:    strPtr("福建省"),
		Attractions: []CityAttraction{{Name: "鼓浪屿", Description: "世界文化遗产"}},
	}
	got, err := st.UpsertRaceCityContent(ctx, in)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got.ID == 0 {
		t.Fatalf("created = %+v, want an id", got)
	}

	// Update: 保存即生效 — the write replaces the live content.
	in.Intro = &CityIntro{Overview: "海滨城市"}
	if _, err := st.UpsertRaceCityContent(ctx, in); err != nil {
		t.Fatalf("update: %v", err)
	}
	row, err := st.GetRaceCityContent(ctx, "厦门市")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if row.Intro == nil || row.Intro.Overview != "海滨城市" || len(row.Attractions) != 1 {
		t.Fatalf("updated = %+v, want the new intro kept", row)
	}

	// Missing city reads as nil, not an error.
	if row, err := st.GetRaceCityContent(ctx, "不存在市"); err != nil || row != nil {
		t.Fatalf("missing city = (%v, %v), want (nil, nil)", row, err)
	}
}

func TestRaceCityContent_AIDraft(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()

	// New city → a row with only the intro filled.
	got, err := st.UpsertRaceCityContentAIDraft(ctx, &RaceCityContent{
		City:  "厦门市",
		Intro: &CityIntro{Overview: "海滨城市", Culture: "闽南文化", Food: "沙茶面", History: "经济特区"},
	})
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}
	if got.ID == 0 {
		t.Fatalf("created = %+v, want an id", got)
	}
	if got.Province != nil || len(got.Attractions) != 0 {
		t.Fatalf("created = %+v, want only the intro", got)
	}

	// A later AI draft merges the intro and keeps the other sections.
	province := "福建省"
	if _, err := st.UpsertRaceCityContent(ctx, &RaceCityContent{
		City: "厦门市", Province: &province,
		Attractions: []CityAttraction{{Name: "鼓浪屿", Description: "世界文化遗产"}},
	}); err != nil {
		t.Fatalf("seed other sections: %v", err)
	}
	got, err = st.UpsertRaceCityContentAIDraft(ctx, &RaceCityContent{
		City:  "厦门市",
		Intro: &CityIntro{Overview: "更新概览", Culture: "更新文化", Food: "更新美食", History: "更新历史"},
	})
	if err != nil {
		t.Fatalf("merge draft: %v", err)
	}
	if got.Province == nil || *got.Province != "福建省" || len(got.Attractions) != 1 {
		t.Fatalf("merged = %+v, want other sections preserved", got)
	}
	if got.Intro == nil || got.Intro.Overview != "更新概览" || got.Intro.History != "更新历史" {
		t.Fatalf("merged = %+v, want the intro overwritten", got)
	}
}

// TestRaceContent_RoundTripsOnEventRow covers the merge's core write/read path:
// the six content sections live on the race_calendar row and round-trip through
// the model write.
func TestRaceContent_RoundTripsOnEventRow(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()
	eventID := seedRaceEvent(t, st, "中国田协", "气候马拉松", "2031-01-05")

	var event RaceCalendarEvent
	if err := st.db.WithContext(ctx).First(&event, eventID).Error; err != nil {
		t.Fatalf("read event: %v", err)
	}
	avg, high, low := 2.5, 9.0, -3.0
	rain, humidity := 20, 45
	wind := "东北风3级"
	event.PartitionRule = &RacePartitionRule{Mode: "by_item", Description: "分项出发"}
	event.SignupChannels = []RaceSignupChannel{{Name: "官网", Type: "官网", URL: "https://example.com"}}
	event.PacketPickup = []RacePacketPickup{{Time: "1月3日 9:00-18:00", Location: "会展中心"}}
	event.Climate = &RaceClimate{Summary: "干冷晴朗，昼夜温差大"}
	event.WeatherWindows = []RaceWeatherWindow{{
		WindowStart: "12-25", WindowEnd: "01-10",
		AvgTempC: &avg, TempHighC: &high, TempLowC: &low,
		RainProbabilityPct: &rain, HumidityPct: &humidity, Wind: &wind,
	}}
	if err := st.UpdateRaceCalendarEvent(ctx, &event); err != nil {
		t.Fatalf("update: %v", err)
	}

	got, err := st.GetRaceCalendarEvent(ctx, eventID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.HasContent() {
		t.Fatalf("got = %+v, want HasContent", got)
	}
	if got.PartitionRule == nil || got.PartitionRule.Mode != "by_item" ||
		len(got.SignupChannels) != 1 || len(got.PacketPickup) != 1 ||
		got.Climate == nil || got.Climate.Summary != "干冷晴朗，昼夜温差大" {
		t.Fatalf("got = %+v, want the sections round-tripped", got)
	}
	w := got.WeatherWindows[0]
	if w.AvgTempC == nil || *w.AvgTempC != 2.5 || w.TempLowC == nil || *w.TempLowC != -3 ||
		w.RainProbabilityPct == nil || *w.RainProbabilityPct != 20 || w.Wind == nil || *w.Wind != wind {
		t.Fatalf("window = %+v, want the numeric fields preserved", w)
	}

	// A full clear leaves no content and nothing to protect.
	got.PartitionRule = nil
	got.SignupChannels = nil
	got.PacketPickup = nil
	got.Climate = nil
	got.WeatherWindows = nil
	if got.HasContent() {
		t.Fatalf("cleared = %+v, want HasContent false", got)
	}
}

// TestRaceCalendar_StaleDeleteKeepsContentRows is THE invariant test of the
// merge: a stale row that carries admin-maintained content is never deleted —
// it is flagged content_stale and kept, items and their content included.
func TestRaceCalendar_StaleDeleteKeepsContentRows(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()
	src, year := "测试源-内容保护", "2034"

	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, []RaceCalendarEvent{
		{Name: "带内容马拉松", RaceDate: "2034-01-10", Country: "CHN"},
		{Name: "无内容马拉松", RaceDate: "2034-02-10", Country: "CHN"},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var withContent RaceCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND name = ?", src, "带内容马拉松").First(&withContent).Error; err != nil {
		t.Fatalf("read event: %v", err)
	}
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("id = ?", withContent.ID).
		Update("climate", []byte(`{"summary":"温润多雨"}`)).Error; err != nil {
		t.Fatalf("seed content: %v", err)
	}
	if err := st.CreateRaceCalendarItem(ctx, &RaceCalendarItem{
		RaceEventID: withContent.ID, Name: "全程马拉松", Type: "Marathon",
		Origin: RaceOriginSync, DistanceKm: floatPtr(42.195),
	}); err != nil {
		t.Fatalf("seed item content: %v", err)
	}

	// Re-sync the year without either race: both keys go stale.
	res, err := st.ReplaceRaceCalendarYear(ctx, src, year, []RaceCalendarEvent{
		{Name: "新面孔马拉松", RaceDate: "2034-03-10", Country: "CHN"},
	})
	if err != nil {
		t.Fatalf("re-sync: %v", err)
	}
	if res.Deleted != 1 || res.ContentStale != 1 {
		t.Fatalf("res = %+v, want 1 deleted + 1 content-stale", res)
	}

	var flagged RaceCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND name = ?", src, "带内容马拉松").First(&flagged).Error; err != nil {
		t.Fatalf("flagged row missing: %v", err)
	}
	if !flagged.ContentStale || !flagged.HasContent() || flagged.Climate == nil || flagged.Climate.Summary != "温润多雨" {
		t.Fatalf("flagged = %+v, want content_stale + intact content", flagged)
	}
	items, err := st.ListRaceCalendarItems(ctx, flagged.ID)
	if err != nil || len(items) != 1 {
		t.Fatalf("items = (%+v, %v), want the item kept", items, err)
	}
	if items[0].DistanceKm == nil || *items[0].DistanceKm != 42.195 {
		t.Fatalf("item = %+v, want the content columns kept", items[0])
	}

	// The list filter surfaces exactly the flagged row.
	rows, total, err := st.ListRaceCalendarEvents(ctx, RaceCalendarListFilter{ContentStale: true, Page: 1, PerPage: 20})
	if err != nil || total != 1 || len(rows) != 1 || rows[0].ID != flagged.ID {
		t.Fatalf("content_stale filter = (%d, %+v, %v), want the flagged row", total, rows, err)
	}
}

// TestRaceCalendar_StaleFlagClearedOnResync covers the flag lifecycle's clear
// half: a re-listed key is refreshed in place and un-flagged, and the sync
// still does not overwrite the content columns.
func TestRaceCalendar_StaleFlagClearedOnResync(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()
	src, year := "测试源-清标", "2035"
	key := "2035-01-10"

	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, []RaceCalendarEvent{
		{Name: "回归马拉松", RaceDate: key, Country: "CHN", City: strPtr("抓取城市")},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("source = ? AND name = ?", src, "回归马拉松").
		Updates(map[string]any{"climate": []byte(`{"summary":" admin"}`), "content_stale": true}).Error; err != nil {
		t.Fatalf("flag: %v", err)
	}

	// Upstream lists the same key again — the merge refreshes the row and
	// clears the flag; the admin content column is untouched.
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, []RaceCalendarEvent{
		{Name: "回归马拉松", RaceDate: key, Country: "CHN", City: strPtr("新抓取城市")},
	}); err != nil {
		t.Fatalf("re-sync: %v", err)
	}
	got, err := st.GetRaceCalendarEvent(ctx, func() uint64 {
		var row RaceCalendarEvent
		if err := st.db.WithContext(ctx).Where("source = ? AND name = ?", src, "回归马拉松").First(&row).Error; err != nil {
			t.Fatalf("read: %v", err)
		}
		return row.ID
	}())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.ContentStale {
		t.Fatalf("content_stale still set, want cleared")
	}
	if got.City == nil || *got.City != "新抓取城市" {
		t.Fatalf("city = %v, want the upstream refresh", got.City)
	}
	if got.Climate == nil || got.Climate.Summary != " admin" {
		t.Fatalf("climate = %+v, want the admin content untouched by the sync", got.Climate)
	}
}

// TestRaceItemContent_SurvivesSyncMerge is the item-level counterpart of the
// event merge invariant: the sync refreshes the sync-managed fields (type) in
// place, and everything it never writes — the ten content columns and the
// admin-maintained entry fields — survives on the same row.
func TestRaceItemContent_SurvivesSyncMerge(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()
	src, year := "测试源-重建项目", "2037"

	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, []RaceCalendarEvent{
		{Name: "重建马拉松", RaceDate: "2037-01-10", Country: "CHN"},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var event RaceCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND name = ?", src, "重建马拉松").First(&event).Error; err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := st.CreateRaceCalendarItem(ctx, &RaceCalendarItem{
		RaceEventID: event.ID, Name: "全程马拉松", Type: "Marathon", Origin: RaceOriginSync,
		StartTime: strPtr("07:30"), Quota: intPtr(30000), DistanceKm: floatPtr(42.195),
	}); err != nil {
		t.Fatalf("seed item: %v", err)
	}

	// The sync re-lists the same item name with a different upstream type.
	if _, err := st.ReplaceRaceCalendarItems(ctx, src, []RaceCalendarItemBatch{{
		Name: "重建马拉松", RaceDate: "2037-01-10",
		Items: []RaceCalendarItem{{Name: "全程马拉松", Type: "HalfMarathon"}},
	}}); err != nil {
		t.Fatalf("sync: %v", err)
	}

	items, err := st.ListRaceCalendarItems(ctx, event.ID)
	if err != nil || len(items) != 1 {
		t.Fatalf("items = (%+v, %v), want one item", items, err)
	}
	got := items[0]
	if got.Type != "HalfMarathon" {
		t.Errorf("type = %q, want the upstream refresh", got.Type)
	}
	if got.DistanceKm == nil || *got.DistanceKm != 42.195 {
		t.Errorf("distance = %v, want the content kept", got.DistanceKm)
	}
	if got.StartTime == nil || *got.StartTime != "07:30" || got.Quota == nil || *got.Quota != 30000 {
		t.Errorf("item = %+v, want the admin-maintained entry fields kept", got)
	}
}

// TestRaceCalendarItem_RenameKeepsContent pins the payoff of folding content
// onto the item row: a rename carries the content along as part of the same
// write. The old split-table design needed a follow-up UPDATE to chase the
// content row to the new name.
func TestRaceCalendarItem_RenameKeepsContent(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()
	eventID := seedRaceEvent(t, st, "测试源-改名", "改名马拉松", "2038-01-05")

	item := &RaceCalendarItem{
		RaceEventID: eventID, Name: "全程马拉松", Type: "Marathon",
		Origin: RaceOriginManual, DistanceKm: floatPtr(42.195),
	}
	if err := st.CreateRaceCalendarItem(ctx, item); err != nil {
		t.Fatalf("seed: %v", err)
	}

	item.Name = "全程马拉松（改）"
	if err := st.UpdateRaceCalendarItem(ctx, item); err != nil {
		t.Fatalf("rename: %v", err)
	}

	got, err := st.GetRaceCalendarItem(ctx, item.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Name != "全程马拉松（改）" || got.DistanceKm == nil || *got.DistanceKm != 42.195 {
		t.Fatalf("got = %+v, want the content carried by the rename", got)
	}
}

// TestRaceContent_Move covers the stale-row resolution: the content moves to
// the fresh row, the stale row and its children disappear, and a target that
// already has content is refused.
func TestRaceContent_Move(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()
	src := "测试源-搬运"

	if _, err := st.ReplaceRaceCalendarYear(ctx, src, "2039", []RaceCalendarEvent{
		{Name: "旧名马拉松", RaceDate: "2039-01-05", Country: "CHN"},
	}); err != nil {
		t.Fatalf("seed source: %v", err)
	}
	var source RaceCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND name = ?", src, "旧名马拉松").First(&source).Error; err != nil {
		t.Fatalf("read source: %v", err)
	}
	source.Climate = &RaceClimate{Summary: "温润多雨"}
	if err := st.UpdateRaceCalendarEvent(ctx, &source); err != nil {
		t.Fatalf("seed content: %v", err)
	}
	if err := st.CreateRaceCalendarItem(ctx, &RaceCalendarItem{
		RaceEventID: source.ID, Name: "全程马拉松", Type: "Marathon",
		Origin: RaceOriginSync, DistanceKm: floatPtr(42.195),
	}); err != nil {
		t.Fatalf("seed item content: %v", err)
	}

	targetID := seedRaceEvent(t, st, src, "新名马拉松", "2039-01-04")
	if err := st.MoveRaceContent(ctx, source.ID, targetID); err != nil {
		t.Fatalf("move: %v", err)
	}

	var target RaceCalendarEvent
	if err := st.db.WithContext(ctx).First(&target, targetID).Error; err != nil {
		t.Fatalf("read target: %v", err)
	}
	if target.Climate == nil || target.Climate.Summary != "温润多雨" || target.ContentStale {
		t.Fatalf("target = %+v, want the content moved and the flag clear", target)
	}
	items, err := st.ListRaceCalendarItems(ctx, targetID)
	if err != nil || len(items) != 1 {
		t.Fatalf("target items = (%+v, %v), want the source item carried over", items, err)
	}
	if items[0].Name != "全程马拉松" || items[0].DistanceKm == nil || *items[0].DistanceKm != 42.195 {
		t.Fatalf("target item = %+v, want the content moved", items[0])
	}
	var sourceEventCount, sourceItemCount int64
	st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("id = ?", source.ID).Count(&sourceEventCount)
	st.db.WithContext(ctx).Model(&RaceCalendarItem{}).Where("race_event_id = ?", source.ID).Count(&sourceItemCount)
	if sourceEventCount != 0 || sourceItemCount != 0 {
		t.Fatalf("source = (%d events, %d items), want gone", sourceEventCount, sourceItemCount)
	}

	// A target that already carries content is refused with the sentinel.
	otherID := seedRaceEvent(t, st, src, "第三场马拉松", "2039-03-01")
	if err := st.MoveRaceContent(ctx, targetID, otherID); err != nil {
		t.Fatalf("move to empty target: %v", err)
	}
	if err := st.MoveRaceContent(ctx, otherID, targetID); err == nil {
		t.Fatalf("move onto occupied target: want conflict")
	}
	if err := st.MoveRaceContent(ctx, otherID, 99999); err == nil {
		t.Fatalf("move to unknown target: want not-found")
	}
	if err := st.MoveRaceContent(ctx, 99999, otherID); err == nil {
		t.Fatalf("move from unknown source: want not-found")
	}
}

// TestRaceContent_LegacyTablesDropped pins the startup reconciliation: the
// retired split content tables are dropped unconditionally. Production is not
// live yet and they carried no data worth preserving.
func TestRaceContent_LegacyTablesDropped(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()

	// Recreate legacy-shaped tables to simulate an upgrade from the old release,
	// then let AutoMigrateRaceContent reconcile them away.
	retired := []string{"race_content", "race_item_content"}
	for _, table := range retired {
		if err := st.db.WithContext(ctx).Exec(
			"CREATE TABLE IF NOT EXISTS " + table + " (id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT, status VARCHAR(16))",
		).Error; err != nil {
			t.Fatalf("seed legacy table %s: %v", table, err)
		}
	}
	if err := st.AutoMigrateRaceContent(ctx); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	for _, table := range retired {
		if st.db.WithContext(ctx).Migrator().HasTable(table) {
			t.Fatalf("%s still exists, want dropped", table)
		}
	}
}
