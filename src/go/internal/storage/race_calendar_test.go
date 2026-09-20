package storage

import (
	"context"
	"errors"
	"testing"
	"time"
)

// migrateRaceCalendar ensures the race_calendar tables exist for the
// integration test (the shared openTestStore only migrates jobs/pipeline_runs)
// and empties them so each test starts from a clean, isolated state.
func migrateRaceCalendar(t *testing.T, st *Store) {
	t.Helper()
	ctx := context.Background()
	if err := st.AutoMigrateRaceCalendar(ctx); err != nil {
		t.Fatalf("automigrate race_calendar: %v", err)
	}
	// The table is shared by every test in this package, so clear it (children
	// first) rather than relying on test ordering.
	if err := st.db.WithContext(ctx).Exec("DELETE FROM race_calendar_item").Error; err != nil {
		t.Fatalf("clear race_calendar_item: %v", err)
	}
	if err := st.db.WithContext(ctx).Exec("DELETE FROM race_calendar").Error; err != nil {
		t.Fatalf("clear race_calendar: %v", err)
	}
}

func TestRaceCalendar_MergePreservesOverriddenFields(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	src := "测试源-字段合并"
	year := "2031"
	seed := []RaceCalendarEvent{{
		Name: "Merge Race", RaceDate: "2031-05-01", Country: "CHN",
		Province: strPtr("福建省"), City: strPtr("厦门市"), Label: strPtr("A"),
		RaceTypes: strPtr(`["Marathon"]`),
	}}
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, seed); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// The administrator takes over city + label (and, implicitly for this test,
	// records it in admin_overrides).
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("source = ? AND name = ?", src, "Merge Race").
		Updates(map[string]any{
			"city":            "厦门（人工）",
			"label":           "S",
			"admin_overrides": []byte(`["city","label"]`),
		}).Error; err != nil {
		t.Fatalf("set overrides: %v", err)
	}

	// Re-sync with changed upstream values for every field.
	again := []RaceCalendarEvent{{
		Name: "Merge Race", RaceDate: "2031-05-01", Country: "CHN",
		Province: strPtr("广东省"), City: strPtr("广州"), Label: strPtr("B"),
		RaceTypes: strPtr(`["HalfMarathon"]`),
	}}
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, again); err != nil {
		t.Fatalf("re-sync: %v", err)
	}

	var got RaceCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND name = ?", src, "Merge Race").First(&got).Error; err != nil {
		t.Fatalf("read: %v", err)
	}
	// Overridden fields keep the admin value...
	if got.City == nil || *got.City != "厦门（人工）" {
		t.Errorf("city = %v, want the admin value", got.City)
	}
	if got.Label == nil || *got.Label != "S" {
		t.Errorf("label = %v, want the admin value S", got.Label)
	}
	// ...while the untouched fields take the upstream value.
	if got.Province == nil || *got.Province != "广东省" {
		t.Errorf("province = %v, want the refreshed 广东省", got.Province)
	}
	if got.RaceTypes == nil || *got.RaceTypes != `["HalfMarathon"]` {
		t.Errorf("race_types = %v, want refreshed", got.RaceTypes)
	}
	if got.Origin != RaceOriginSync {
		t.Errorf("origin = %q, want sync", got.Origin)
	}
}

func TestRaceCalendar_StaleDeleteSkipsManualAndOverridden(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	src := "测试源-陈旧删除"
	year := "2032"
	seed := []RaceCalendarEvent{
		{Name: "Dropped Pure Sync", RaceDate: "2032-01-10", Country: "CHN"},
		{Name: "Dropped Overridden", RaceDate: "2032-02-10", Country: "CHN"},
		{Name: "Dropped Manual", RaceDate: "2032-03-10", Country: "CHN"},
	}
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, seed); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("source = ? AND name = ?", src, "Dropped Overridden").
		Update("admin_overrides", []byte(`["city"]`)).Error; err != nil {
		t.Fatalf("mark override: %v", err)
	}
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("source = ? AND name = ?", src, "Dropped Manual").
		Update("origin", RaceOriginManual).Error; err != nil {
		t.Fatalf("mark manual: %v", err)
	}

	// Re-sync the year with only one surviving race: everything else is stale.
	res, err := st.ReplaceRaceCalendarYear(ctx, src, year, []RaceCalendarEvent{
		{Name: "Survivor", RaceDate: "2032-04-10", Country: "CHN"},
	})
	if err != nil {
		t.Fatalf("re-sync: %v", err)
	}
	if res.Deleted != 1 {
		t.Fatalf("deleted = %d, want 1 (only the pure-sync row)", res.Deleted)
	}

	var names []string
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("source = ?", src).
		Order("name").Pluck("name", &names).Error; err != nil {
		t.Fatalf("list: %v", err)
	}
	want := []string{"Dropped Manual", "Dropped Overridden", "Survivor"}
	if len(names) != len(want) {
		t.Fatalf("rows = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("rows = %v, want %v", names, want)
		}
	}
}

func TestRaceCalendar_ManualRowWithSameKeyIsUntouched(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	src := "测试源-脱离镜像"
	year := "2033"
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, []RaceCalendarEvent{
		{Name: "Detached", RaceDate: "2033-01-01", Country: "CHN", City: strPtr("原值")},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Simulate the key edit that upgrades the row to manual while its key still
	// matches upstream (an administrator renamed it back).
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("source = ? AND name = ?", src, "Detached").
		Update("origin", RaceOriginManual).Error; err != nil {
		t.Fatalf("upgrade: %v", err)
	}

	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, []RaceCalendarEvent{
		{Name: "Detached", RaceDate: "2033-01-01", Country: "CHN", City: strPtr("上游新值")},
	}); err != nil {
		t.Fatalf("re-sync: %v", err)
	}

	var got RaceCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND name = ?", src, "Detached").First(&got).Error; err != nil {
		t.Fatalf("read: %v", err)
	}
	if got.City == nil || *got.City != "原值" {
		t.Fatalf("city = %v, want the manual row untouched", got.City)
	}
	if got.Origin != RaceOriginManual {
		t.Fatalf("origin = %q, want manual", got.Origin)
	}
}

func TestRaceCalendar_ReplaceItemsRegeneratesSyncAndKeepsManual(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	src := "测试源-项目"
	year := "2034"
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, []RaceCalendarEvent{
		{Name: "Item Race", RaceDate: "2034-06-01", Country: "CHN"},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var event RaceCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND name = ?", src, "Item Race").First(&event).Error; err != nil {
		t.Fatalf("read event: %v", err)
	}

	// Seed one sync item and one manual item (the manual one shares a name with
	// an upstream item that is about to arrive).
	fee := 12000
	if err := st.CreateRaceCalendarItem(ctx, &RaceCalendarItem{
		RaceEventID: event.ID, Name: "全程", Type: "Marathon", Origin: RaceOriginSync,
	}); err != nil {
		t.Fatalf("seed sync item: %v", err)
	}
	if err := st.CreateRaceCalendarItem(ctx, &RaceCalendarItem{
		RaceEventID: event.ID, Name: "半程", Type: "HalfMarathon", EntryFee: &fee, Origin: RaceOriginManual,
	}); err != nil {
		t.Fatalf("seed manual item: %v", err)
	}

	res, err := st.ReplaceRaceCalendarItems(ctx, src, []RaceCalendarItemBatch{{
		Name: "Item Race", RaceDate: "2034-06-01",
		Items: []RaceCalendarItem{
			{Name: "全程", Type: "Marathon"},
			{Name: "半程", Type: "HalfMarathon"}, // collides with the manual item → skipped
			{Name: "10公里", Type: "10Km"},
		},
	}})
	if err != nil {
		t.Fatalf("replace items: %v", err)
	}
	// The old sync item is deleted, then 全程 + 10公里 are inserted; the manual
	// 半程 is skipped.
	if res.Deleted != 1 || res.Upserted != 2 {
		t.Fatalf("result = %+v, want deleted=1 upserted=2", res)
	}

	items, err := st.ListRaceCalendarItems(ctx, event.ID)
	if err != nil {
		t.Fatalf("list items: %v", err)
	}
	byName := map[string]RaceCalendarItem{}
	for _, it := range items {
		byName[it.Name] = it
	}
	if got, ok := byName["半程"]; !ok || got.Origin != RaceOriginManual || got.EntryFee == nil || *got.EntryFee != fee {
		t.Errorf("manual 半程 = %+v, want preserved manual item with fee", got)
	}
	if got, ok := byName["10公里"]; !ok || got.Origin != RaceOriginSync || got.Type != "10Km" {
		t.Errorf("10公里 = %+v, want new sync item", got)
	}
	if len(items) != 3 {
		t.Errorf("items = %d, want 3 (半程 manual + 全程 + 10公里)", len(items))
	}

	// Once the event is detached (origin=manual), the item sync must skip it
	// entirely rather than regenerate its sync items.
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("id = ?", event.ID).Update("origin", RaceOriginManual).Error; err != nil {
		t.Fatalf("detach event: %v", err)
	}
	if _, err := st.ReplaceRaceCalendarItems(ctx, src, []RaceCalendarItemBatch{{
		Name: "Item Race", RaceDate: "2034-06-01",
		Items: []RaceCalendarItem{{Name: "42公里", Type: "Marathon"}},
	}}); err != nil {
		t.Fatalf("replace items on manual event: %v", err)
	}
	items, err = st.ListRaceCalendarItems(ctx, event.ID)
	if err != nil {
		t.Fatalf("list items after detach: %v", err)
	}
	if len(items) != 3 {
		t.Errorf("items after detach = %d, want 3 (manual event untouched)", len(items))
	}
}

func TestRaceCalendar_DeleteCascadesItems(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	row := RaceCalendarEvent{Source: RaceSourceManual, Name: "删除赛事", RaceDate: "2035-01-01", Country: "CHN", Origin: RaceOriginManual}
	if err := st.CreateRaceCalendarEvent(ctx, &row); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := st.CreateRaceCalendarItem(ctx, &RaceCalendarItem{RaceEventID: row.ID, Name: "全程", Type: "Marathon", Origin: RaceOriginManual}); err != nil {
		t.Fatalf("create item: %v", err)
	}
	if err := st.DeleteRaceCalendarEvent(ctx, row.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	var n int64
	if err := st.db.WithContext(ctx).Model(&RaceCalendarItem{}).Where("race_event_id = ?", row.ID).Count(&n).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("items after delete = %d, want 0", n)
	}
	if err := st.DeleteRaceCalendarEvent(ctx, row.ID); !errors.Is(err, ErrRaceCalendarNotFound) {
		t.Fatalf("second delete = %v, want ErrRaceCalendarNotFound", err)
	}
}

func strPtr(s string) *string { return &s }

func sampleRaces() []RaceCalendarEvent {
	return []RaceCalendarEvent{
		{
			Name:     "40. OPTIMA Dreikönigslauf in Schwäbisch Hall",
			RaceDate: "2026-01-06",
			Country:  "GER",
			City:     strPtr("Schwäbisch Hall"),
			Label:    strPtr("Label"),
		},
		{
			Name:     "Tokyo Marathon",
			RaceDate: "2026-03-01",
			Country:  "JPN",
			City:     strPtr("Tokyo"),
			Label:    strPtr("Platinum"),
		},
	}
}

func TestRaceCalendar_ReplaceMirrorsYearAndDerivesMonthDay(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	src := "国际田联"
	year := "2026"

	// First sync seeds two races. month/dayofmonth derive from race_date.
	res, err := st.ReplaceRaceCalendarYear(ctx, src, year, sampleRaces())
	if err != nil {
		t.Fatalf("first replace: %v", err)
	}
	if res.Upserted != 2 || res.Deleted != 0 {
		t.Fatalf("first replace = %+v, want upserted=2 deleted=0", res)
	}

	var rows []RaceCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND race_date LIKE ?", src, year+"-%").Order("name").Find(&rows).Error; err != nil {
		t.Fatalf("list rows: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	byName := map[string]RaceCalendarEvent{}
	for _, r := range rows {
		byName[r.Name] = r
	}
	if got := byName["Tokyo Marathon"]; got.Month != 3 || got.DayOfMonth != 1 {
		t.Fatalf("Tokyo month/day = %d/%d, want 3/1", got.Month, got.DayOfMonth)
	}
	if got := byName["40. OPTIMA Dreikönigslauf in Schwäbisch Hall"]; got.Month != 1 || got.DayOfMonth != 6 {
		t.Fatalf("OPTIMA month/day = %d/%d, want 1/6", got.Month, got.DayOfMonth)
	}

	// Second sync renames one race (delete+insert, no stable id) and drops the
	// other: upserted=1 (the renamed race), deleted=2 (old OPTIMA + Tokyo).
	updated := sampleRaces()
	updated[0].Name = "OPTIMA Dreikönigslauf Schwäbisch Hall (renamed)"
	updated = updated[:1]
	res, err = st.ReplaceRaceCalendarYear(ctx, src, year, updated)
	if err != nil {
		t.Fatalf("second replace: %v", err)
	}
	if res.Upserted != 1 || res.Deleted != 2 {
		t.Fatalf("second replace = %+v, want upserted=1 deleted=2", res)
	}

	var n int64
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("source = ? AND race_date LIKE ?", src, year+"-%").Count(&n).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("rows after second replace = %d, want 1", n)
	}
}

func TestRaceCalendar_NameCNIsNotOverwritten(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	src := "国际田联"
	year := "2026"

	// Seed with a curated Chinese name on the first race.
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, sampleRaces()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cn := "施瓦本哈尔快乐奔跑"
	if err := st.db.WithContext(ctx).
		Model(&RaceCalendarEvent{}).
		Where("source = ? AND race_date LIKE ? AND name = ?", src, year+"-%", "40. OPTIMA Dreikönigslauf in Schwäbisch Hall").
		Update("name_cn", cn).Error; err != nil {
		t.Fatalf("set name_cn: %v", err)
	}

	// A re-sync (same name, changed address/label) must not wipe name_cn.
	again := sampleRaces()
	again[0].City = strPtr("Somewhere Else")
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, again); err != nil {
		t.Fatalf("re-sync: %v", err)
	}

	var got string
	if err := st.db.WithContext(ctx).
		Model(&RaceCalendarEvent{}).
		Where("source = ? AND race_date LIKE ? AND name = ?", src, year+"-%", "40. OPTIMA Dreikönigslauf in Schwäbisch Hall").
		Pluck("name_cn", &got).Error; err != nil {
		t.Fatalf("read name_cn: %v", err)
	}
	if got != cn {
		t.Fatalf("name_cn = %q, want %q (sync must not overwrite it)", got, cn)
	}
}

func TestRaceCalendar_RaceTypesUpsertAndRefresh(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	src := "国际田联"
	year := "2026"
	races := sampleRaces()
	races[1].RaceTypes = strPtr(`["Marathon"]`)
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, races); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var got *string
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("source = ? AND name = ?", src, "Tokyo Marathon").
		Pluck("race_types", &got).Error; err != nil {
		t.Fatalf("read race_types: %v", err)
	}
	if got == nil || *got != `["Marathon"]` {
		t.Fatalf("race_types = %v, want [\"Marathon\"]", got)
	}

	// The column is part of the upsert refresh set: a re-sync with a changed
	// value must overwrite it (the second race keeps its NULL).
	again := sampleRaces()
	again[1].RaceTypes = strPtr(`["Marathon","HalfMarathon"]`)
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, again); err != nil {
		t.Fatalf("re-sync: %v", err)
	}
	var rows []RaceCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND race_date LIKE ?", src, year+"-%").Order("name").Find(&rows).Error; err != nil {
		t.Fatalf("list rows: %v", err)
	}
	byName := map[string]*string{}
	for _, r := range rows {
		byName[r.Name] = r.RaceTypes
	}
	if got := byName["Tokyo Marathon"]; got == nil || *got != `["Marathon","HalfMarathon"]` {
		t.Fatalf("Tokyo race_types = %v, want refreshed [\"Marathon\",\"HalfMarathon\"]", got)
	}
	if got := byName["40. OPTIMA Dreikönigslauf in Schwäbisch Hall"]; got != nil {
		t.Fatalf("OPTIMA race_types = %v, want nil (upstream has no marker)", got)
	}
}

func TestRaceCalendar_SourcesAreIsolated(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	if _, err := st.ReplaceRaceCalendarYear(ctx, "国际田联", "2026", sampleRaces()); err != nil {
		t.Fatalf("replace 国际田联: %v", err)
	}
	if _, err := st.ReplaceRaceCalendarYear(ctx, "中国田协", "2026", sampleRaces()); err != nil {
		t.Fatalf("replace 中国田协: %v", err)
	}

	var n int64
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("source = ?", "国际田联").Count(&n).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 2 {
		t.Fatalf("国际田联 rows = %d, want 2", n)
	}
}

func TestRaceCalendar_EmptyYearIsNoOp(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	src := "国际田联"
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, "2026", sampleRaces()); err != nil {
		t.Fatalf("seed: %v", err)
	}

	res, err := st.ReplaceRaceCalendarYear(ctx, src, "2026", nil)
	if err != nil {
		t.Fatalf("empty replace: %v", err)
	}
	if res.Upserted != 0 || res.Deleted != 0 {
		t.Fatalf("empty replace = %+v, want zeros", res)
	}

	var n int64
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("source = ? AND race_date LIKE ?", src, "2026-%").Count(&n).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 2 {
		t.Fatalf("rows after empty replace = %d, want 2 (not wiped)", n)
	}
}

func TestRaceCalendar_SameNameDifferentDateAreSeparate(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	// The real-world case that motivated race_date in the key: two genuinely
	// different races share a name in one year (two "Medio Maraton Sevilla").
	races := []RaceCalendarEvent{
		{Name: "Medio Maraton Sevilla", RaceDate: "2026-01-25", Country: "ESP", City: strPtr("Sevilla")},
		{Name: "Medio Maraton Sevilla", RaceDate: "2026-11-29", Country: "ESP", City: strPtr("Sevilla")},
	}
	if _, err := st.ReplaceRaceCalendarYear(ctx, "国际田联", "2026", races); err != nil {
		t.Fatalf("replace: %v", err)
	}
	var n int64
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("source = ? AND name = ?", "国际田联", "Medio Maraton Sevilla").Count(&n).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 2 {
		t.Fatalf("rows for same-named races = %d, want 2 (distinct dates)", n)
	}

	// A re-sync with only the January race must delete only the November one.
	if _, err := st.ReplaceRaceCalendarYear(ctx, "国际田联", "2026", races[:1]); err != nil {
		t.Fatalf("re-sync: %v", err)
	}
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("source = ? AND name = ?", "国际田联", "Medio Maraton Sevilla").Count(&n).Error; err != nil {
		t.Fatalf("count after re-sync: %v", err)
	}
	if n != 1 {
		t.Fatalf("rows after re-sync = %d, want 1", n)
	}
}

func TestRaceCalendar_StaleDeleteKeepsOtherYears(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	// Seed 2025 and 2026.
	races25 := []RaceCalendarEvent{{Name: "Tokyo Marathon", RaceDate: "2025-03-02", Country: "JPN"}}
	races26 := []RaceCalendarEvent{{Name: "Tokyo Marathon", RaceDate: "2026-03-01", Country: "JPN"}}
	if _, err := st.ReplaceRaceCalendarYear(ctx, "国际田联", "2025", races25); err != nil {
		t.Fatalf("seed 2025: %v", err)
	}
	if _, err := st.ReplaceRaceCalendarYear(ctx, "国际田联", "2026", races26); err != nil {
		t.Fatalf("seed 2026: %v", err)
	}

	// Re-sync 2026 with a different race so the stale-delete actually runs: the
	// stale 2026 Tokyo row is deleted (bounded to 2026 by the BETWEEN year
	// range), while the 2025 row survives untouched.
	races26b := []RaceCalendarEvent{{Name: "Osaka Marathon", RaceDate: "2026-02-22", Country: "JPN"}}
	res, err := st.ReplaceRaceCalendarYear(ctx, "国际田联", "2026", races26b)
	if err != nil {
		t.Fatalf("re-sync 2026: %v", err)
	}
	if res.Deleted != 1 {
		t.Fatalf("2026 stale-delete deleted = %d, want 1", res.Deleted)
	}

	var n int64
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("source = ? AND race_date LIKE ?", "国际田联", "2025-%").Count(&n).Error; err != nil {
		t.Fatalf("count 2025: %v", err)
	}
	if n != 1 {
		t.Fatalf("2025 rows = %d, want 1 (stale-delete must not touch other years)", n)
	}
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).Where("source = ? AND race_date LIKE ?", "国际田联", "2026-%").Count(&n).Error; err != nil {
		t.Fatalf("count 2026: %v", err)
	}
	if n != 1 || n == 0 {
		t.Fatalf("2026 rows = %d, want 1 (the new Osaka race)", n)
	}
}

func TestRaceCalendar_CreatedAtPreservedOnResync(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCalendar(t, st)
	ctx := context.Background()

	src := "国际田联"
	year := "2026"
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, sampleRaces()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var firstCreated time.Time
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("source = ? AND name = ?", src, "Tokyo Marathon").
		Pluck("created_at", &firstCreated).Error; err != nil {
		t.Fatalf("read created_at: %v", err)
	}

	// A re-sync with the same races (different city so a column is refreshed)
	// must keep created_at and bump updated_at.
	again := sampleRaces()
	again[1].City = strPtr("Tokyo")
	if _, err := st.ReplaceRaceCalendarYear(ctx, src, year, again); err != nil {
		t.Fatalf("re-sync: %v", err)
	}
	var secondCreated, secondUpdated time.Time
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("source = ? AND name = ?", src, "Tokyo Marathon").
		Pluck("created_at", &secondCreated).Error; err != nil {
		t.Fatalf("read created_at after: %v", err)
	}
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("source = ? AND name = ?", src, "Tokyo Marathon").
		Pluck("updated_at", &secondUpdated).Error; err != nil {
		t.Fatalf("read updated_at after: %v", err)
	}
	if !secondCreated.Equal(firstCreated) {
		t.Fatalf("created_at changed on re-sync: %v -> %v", firstCreated, secondCreated)
	}
	if secondUpdated.Before(firstCreated) {
		t.Fatalf("updated_at did not advance: %v", secondUpdated)
	}
}

func TestMonthDayOf(t *testing.T) {
	if m, d := monthDayOf("2026-03-01"); m != 3 || d != 1 {
		t.Fatalf("monthDayOf(2026-03-01) = %d/%d, want 3/1", m, d)
	}
	// A malformed date degrades to (0,0) instead of failing the sync.
	if m, d := monthDayOf("not-a-date"); m != 0 || d != 0 {
		t.Fatalf("monthDayOf(bad) = %d/%d, want 0/0", m, d)
	}
}
