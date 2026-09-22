package storage

import (
	"context"
	"testing"
)

// migrateRaceContent ensures the race-content tables exist for the integration
// test and empties them (children first) so each test starts isolated. The
// race_calendar tables are cleared too: the content tests seed their own events.
func migrateRaceContent(t *testing.T, st *Store) {
	t.Helper()
	ctx := context.Background()
	if err := st.AutoMigrateRaceCalendar(ctx); err != nil {
		t.Fatalf("automigrate race_calendar: %v", err)
	}
	if err := st.AutoMigrateRaceContent(ctx); err != nil {
		t.Fatalf("automigrate race content: %v", err)
	}
	for _, table := range []string{"race_content_item", "race_content", "race_city_content", "race_calendar_item", "race_calendar"} {
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

func TestRaceContent_UpsertAndReplace(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()
	eventID := seedRaceEvent(t, st, "中国田协", "厦门马拉松", "2031-01-05")
	event := &RaceCalendarEvent{ID: eventID, Source: "中国田协", Name: "厦门马拉松", RaceDate: "2031-01-05"}

	// Create with one item.
	in := &RaceContent{SignupChannels: []RaceSignupChannel{{Name: "官网", Type: "官网", URL: "https://example.com"}}}
	items := []RaceContentItem{{ItemName: "全程马拉松", Quota: intPtr(30000)}}
	got, gotItems, err := st.UpsertRaceContent(ctx, event, in, items)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got.Year != 2031 || got.RaceEventID == nil || *got.RaceEventID != eventID {
		t.Fatalf("created = %+v, want content attached to the event", got)
	}
	if len(gotItems) != 1 || gotItems[0].Quota == nil || *gotItems[0].Quota != 30000 {
		t.Fatalf("items = %+v, want one quota-30000 item", gotItems)
	}

	// Full replace: items are swapped by name.
	items = []RaceContentItem{
		{ItemName: "全程马拉松", EntryFee: intPtr(200)},
		{ItemName: "半程马拉松", Quota: intPtr(20000)},
	}
	if _, gotItems, err = st.UpsertRaceContent(ctx, event, in, items); err != nil {
		t.Fatalf("replace: %v", err)
	}
	if len(gotItems) != 2 {
		t.Fatalf("items = %+v, want 2 after replace", gotItems)
	}

	// A later edit lands on the same row (no draft copy, no version minted).
	in.PartitionRule = &RacePartitionRule{Mode: "by_item", Description: "分项出发"}
	got, gotItems, err = st.UpsertRaceContent(ctx, event, in, items)
	if err != nil {
		t.Fatalf("edit: %v", err)
	}
	if got.PartitionRule == nil || got.PartitionRule.Mode != "by_item" || len(gotItems) != 2 {
		t.Fatalf("edited = %+v items %+v, want the partition rule and both items", got, gotItems)
	}
}

// TestRaceContent_SurvivesUpstreamRenameAndReschedule is THE invariant test
// (user story 31 / issue #318): the upstream sync's delete+insert must never
// touch admin-maintained content, and broken links must be re-attachable.
func TestRaceContent_SurvivesUpstreamRenameAndReschedule(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()
	src := "中国田协"

	// Seed the event through the real sync write, then attach content.
	year := "2031"
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, []RaceCalendarEvent{{
		Name: "旧名马拉松", RaceDate: "2031-01-05", Country: "CHN",
	}}); err != nil {
		t.Fatalf("seed sync: %v", err)
	}
	var event RaceCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND name = ?", src, "旧名马拉松").First(&event).Error; err != nil {
		t.Fatalf("read event: %v", err)
	}
	in := &RaceContent{PacketPickup: []RacePacketPickup{{Time: "1月3日 9:00-18:00", Location: "会展中心"}}}
	items := []RaceContentItem{{ItemName: "全程马拉松"}}
	got, _, err := st.UpsertRaceContent(ctx, &event, in, items)
	if err != nil {
		t.Fatalf("create content: %v", err)
	}

	// The sync rewrites the whole year: the race is renamed AND rescheduled.
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, []RaceCalendarEvent{{
		Name: "新名马拉松", RaceDate: "2031-01-04", Country: "CHN",
	}}); err != nil {
		t.Fatalf("re-sync: %v", err)
	}

	// The content row survived untouched...
	orphans, err := st.ListOrphanRaceContent(ctx)
	if err != nil {
		t.Fatalf("list orphans: %v", err)
	}
	if len(orphans) != 1 || orphans[0].ID != got.ID || orphans[0].RaceName != "旧名马拉松" || len(orphans[0].PacketPickup) != 1 {
		t.Fatalf("orphans = %+v, want the surviving content row", orphans)
	}

	// ...and is re-attachable to the new event.
	var newEvent RaceCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND name = ?", src, "新名马拉松").First(&newEvent).Error; err != nil {
		t.Fatalf("read new event: %v", err)
	}
	attached, attachedItems, err := st.AttachRaceContent(ctx, got.ID, newEvent.ID)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if attached.RaceEventID == nil || *attached.RaceEventID != newEvent.ID || attached.RaceName != "新名马拉松" || attached.RaceDate != "2031-01-04" || attached.Year != 2031 {
		t.Fatalf("attached = %+v, want a link to the new event with a refreshed key", attached)
	}
	if len(attachedItems) != 1 || attachedItems[0].ItemName != "全程马拉松" {
		t.Fatalf("attached items = %+v, want the original item", attachedItems)
	}

	// After re-attachment the event resolves its content again...
	byEvent, byEventItems, err := st.GetRaceContentByEvent(ctx, newEvent.ID)
	if err != nil || byEvent == nil || byEvent.ID != got.ID || len(byEventItems) != 1 {
		t.Fatalf("by event = (%+v, %+v, %v), want the re-attached content", byEvent, byEventItems, err)
	}
	// ...the orphan list is empty, and the old event id resolves nothing.
	if orphans, _ := st.ListOrphanRaceContent(ctx); len(orphans) != 0 {
		t.Fatalf("orphans = %+v, want none after attach", orphans)
	}
	if byEvent, _, err := st.GetRaceContentByEvent(ctx, event.ID); err == nil || byEvent != nil {
		t.Fatalf("deleted event = (%v, %v), want not-found", byEvent, err)
	}
}

// TestRaceContent_ReattachByBusinessKey covers the automatic half of sync
// survival: an upstream delete+insert with an UNCHANGED identity re-links the
// content on the next read (the live event-id link is gone, the business-key
// snapshot still matches).
func TestRaceContent_ReattachByBusinessKey(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()
	src, year := "中国田协", "2031"
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, []RaceCalendarEvent{{
		Name: "重排马拉松", RaceDate: "2031-01-05", Country: "CHN",
	}}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var event RaceCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND name = ?", src, "重排马拉松").First(&event).Error; err != nil {
		t.Fatalf("read: %v", err)
	}
	if _, _, err := st.UpsertRaceContent(ctx, &event, &RaceContent{}, []RaceContentItem{{ItemName: "全程马拉松"}}); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Simulate the sync's delete+insert of the same identity: the event row is
	// replaced wholesale (new surrogate id), the content is never touched.
	if err := st.db.WithContext(ctx).Where("id = ?", event.ID).Delete(&RaceCalendarEvent{}).Error; err != nil {
		t.Fatalf("delete event: %v", err)
	}
	newID := seedRaceEvent(t, st, src, "重排马拉松", "2031-01-05")

	got, items, err := st.GetRaceContentByEvent(ctx, newID)
	if err != nil || got == nil || got.RaceEventID == nil || *got.RaceEventID != event.ID {
		t.Fatalf("got = (%+v, %v), want the content found via the business key", got, err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %+v, want one", items)
	}

	// Editing through the new event id re-links the live pointer while keeping
	// the content (the upsert path's re-attach branch).
	event.ID = newID
	updated, _, err := st.UpsertRaceContent(ctx, &event, &RaceContent{SignupTimeline: &RaceSignupTimeline{StartAt: "2030-12-01", Deadline: "2030-12-31"}}, nil)
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if updated.RaceEventID == nil || *updated.RaceEventID != newID || updated.SignupTimeline == nil {
		t.Fatalf("updated = %+v, want re-link + new timeline", updated)
	}
}

// TestRaceContent_AttachConflicts covers the attach edge cases: unknown event,
// unknown content, and a race that already has content.
func TestRaceContent_AttachConflicts(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()
	eventID := seedRaceEvent(t, st, "中国田协", "冲突马拉松", "2031-01-05")
	event := &RaceCalendarEvent{ID: eventID, Source: "中国田协", Name: "冲突马拉松", RaceDate: "2031-01-05"}

	content, _, err := st.UpsertRaceContent(ctx, event, &RaceContent{}, nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	otherEventID := seedRaceEvent(t, st, "中国田协", "另一场马拉松", "2031-03-01")

	if _, _, err := st.AttachRaceContent(ctx, content.ID, otherEventID); err != nil {
		t.Fatalf("attach to free event: %v", err)
	}
	// The source event is now free; a second content row can take it.
	if _, _, err := st.UpsertRaceContent(ctx, event, &RaceContent{}, nil); err != nil {
		t.Fatalf("recreate: %v", err)
	}
	// Attaching the recreated content to a race that already has content must
	// fail with the conflict sentinel, not a raw duplicate-key error.
	freeEventID := seedRaceEvent(t, st, "中国田协", "第三场马拉松", "2031-04-01")
	third, _, err := st.UpsertRaceContent(ctx, &RaceCalendarEvent{ID: freeEventID, Source: "中国田协", Name: "第三场马拉松", RaceDate: "2031-04-01"}, &RaceContent{}, nil)
	if err != nil {
		t.Fatalf("create third: %v", err)
	}
	if _, _, err := st.AttachRaceContent(ctx, third.ID, eventID); err == nil {
		t.Fatalf("attach to occupied event: want conflict")
	}
	if _, _, err := st.AttachRaceContent(ctx, 99999, otherEventID); err == nil {
		t.Fatalf("attach unknown content: want not-found")
	}
	if _, _, err := st.AttachRaceContent(ctx, third.ID, 99999); err == nil {
		t.Fatalf("attach unknown event: want not-found")
	}
}

// TestRaceContent_ClimateRoundTrip covers the race-level climate sections
// (moved from city level): a full-replace write keeps summary + windows and an
// absent section clears them.
func TestRaceContent_ClimateRoundTrip(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()
	eventID := seedRaceEvent(t, st, "中国田协", "气候马拉松", "2031-01-05")
	event := &RaceCalendarEvent{ID: eventID, Source: "中国田协", Name: "气候马拉松", RaceDate: "2031-01-05"}

	avg, high, low := 2.5, 9.0, -3.0
	rain, humidity := 20, 45
	wind := "东北风3级"
	in := &RaceContent{
		Climate: &RaceClimate{Summary: "干冷晴朗，昼夜温差大"},
		WeatherWindows: []RaceWeatherWindow{{
			WindowStart: "12-25", WindowEnd: "01-10",
			AvgTempC: &avg, TempHighC: &high, TempLowC: &low,
			RainProbabilityPct: &rain, HumidityPct: &humidity, Wind: &wind,
		}},
	}
	if _, _, err := st.UpsertRaceContent(ctx, event, in, []RaceContentItem{{ItemName: "全程马拉松"}}); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, gotItems, err := st.GetRaceContentByEvent(ctx, eventID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Climate == nil || got.Climate.Summary != "干冷晴朗，昼夜温差大" || len(got.WeatherWindows) != 1 {
		t.Fatalf("got = %+v, want climate + one window round-tripped", got)
	}
	w := got.WeatherWindows[0]
	if w.AvgTempC == nil || *w.AvgTempC != 2.5 || w.TempLowC == nil || *w.TempLowC != -3 ||
		w.RainProbabilityPct == nil || *w.RainProbabilityPct != 20 || w.Wind == nil || *w.Wind != wind {
		t.Fatalf("window = %+v, want the numeric fields preserved", w)
	}
	if len(gotItems) != 1 {
		t.Fatalf("items = %+v, want one", gotItems)
	}

	// The next write clears the absent climate sections (full replace).
	if _, _, err := st.UpsertRaceContent(ctx, event, &RaceContent{}, nil); err != nil {
		t.Fatalf("clear edit: %v", err)
	}
	cleared, _, err := st.GetRaceContentByEvent(ctx, eventID)
	if err != nil {
		t.Fatalf("get cleared: %v", err)
	}
	if cleared.Climate != nil || len(cleared.WeatherWindows) != 0 {
		t.Fatalf("cleared = %+v, want climate sections emptied", cleared)
	}
}

// TestRaceContent_AIDraft covers the race AI-draft upsert: a never-maintained
// race gets a fresh row with only climate + weather windows, and an existing
// row merges without touching other sections or items.
func TestRaceContent_AIDraft(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()
	eventID := seedRaceEvent(t, st, "中国田协", "新赛马拉松", "2031-04-11")
	event := &RaceCalendarEvent{ID: eventID, Source: "中国田协", Name: "新赛马拉松", RaceDate: "2031-04-11"}

	// Never-maintained race → a new row with the event's business key and only
	// the AI sections populated.
	got, gotItems, err := st.UpsertRaceContentAIDraft(ctx, event, &RaceContent{
		Climate:        &RaceClimate{Summary: "温润多雨"},
		WeatherWindows: []RaceWeatherWindow{{WindowStart: "04-01", WindowEnd: "04-20"}},
	})
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}
	if got.ID == 0 || got.Year != 2031 ||
		got.RaceEventID == nil || *got.RaceEventID != eventID ||
		got.Source != "中国田协" || got.RaceName != "新赛马拉松" || got.RaceDate != "2031-04-11" {
		t.Fatalf("created = %+v, want a row keyed to the event", got)
	}
	if got.Climate == nil || got.Climate.Summary != "温润多雨" || len(got.WeatherWindows) != 1 {
		t.Fatalf("created = %+v, want the AI sections filled", got)
	}
	if got.PartitionRule != nil || got.SignupTimeline != nil || got.SignupChannels != nil || got.PacketPickup != nil || len(gotItems) != 0 {
		t.Fatalf("created = %+v items %+v, want everything else empty", got, gotItems)
	}

	// An existing row merges only climate + weather windows: the admin's
	// sections and items survive untouched.
	if _, _, err := st.UpsertRaceContent(ctx, event, &RaceContent{
		PartitionRule: &RacePartitionRule{Mode: "mixed"},
	}, []RaceContentItem{{ItemName: "全程马拉松", Quota: intPtr(30000)}}); err != nil {
		t.Fatalf("seed sections: %v", err)
	}
	got, gotItems, err = st.UpsertRaceContentAIDraft(ctx, event, &RaceContent{
		Climate:        &RaceClimate{Summary: "更新气候"},
		WeatherWindows: []RaceWeatherWindow{{WindowStart: "03-25", WindowEnd: "04-15"}, {WindowStart: "04-05", WindowEnd: "04-18"}},
	})
	if err != nil {
		t.Fatalf("merge draft: %v", err)
	}
	if got.PartitionRule == nil || got.PartitionRule.Mode != "mixed" {
		t.Fatalf("merged = %+v, want other sections preserved", got)
	}
	if got.Climate == nil || got.Climate.Summary != "更新气候" || len(got.WeatherWindows) != 2 {
		t.Fatalf("merged = %+v, want the AI sections overwritten", got)
	}
	if len(gotItems) != 1 || gotItems[0].ItemName != "全程马拉松" || gotItems[0].Quota == nil || *gotItems[0].Quota != 30000 {
		t.Fatalf("merged items = %+v, want the seeded item untouched", gotItems)
	}
}
