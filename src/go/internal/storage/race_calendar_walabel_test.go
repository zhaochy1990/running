package storage

import (
	"context"
	"testing"
)

// TestApplyRaceCalendarWALabels_Guards covers the two guards the label step
// relies on but cannot enforce itself: a manual row must not be relabelled (it
// has no upstream listing to match) and an administrator's corrected tier must
// survive. Both are silent if they break — a wrong tier is durable and looks
// exactly like a right one — which is why they live in SQL the store owns.
func TestApplyRaceCalendarWALabels_Guards(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()

	seed := func(name string, origin string, overrides []byte, waLabel *string) uint64 {
		t.Helper()
		row := RaceCalendarEvent{
			Source: RaceSourceChinaAth, Name: name, RaceDate: "2026-11-01",
			Country: "CHN", Month: 11, DayOfMonth: 1, City: strPtr("杭州市"),
			Origin: origin, AdminOverrides: []string{}, WALabel: waLabel,
		}
		if err := st.db.Create(&row).Error; err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
		if overrides != nil {
			if err := st.db.Model(&RaceCalendarEvent{}).Where("id = ?", row.ID).
				Update("admin_overrides", overrides).Error; err != nil {
				t.Fatalf("seed overrides for %s: %v", name, err)
			}
		}
		return row.ID
	}

	syncRow := seed("同步行", RaceOriginSync, nil, nil)
	manualRow := seed("人工行", RaceOriginManual, nil, nil)
	overriddenRow := seed("已接管行", RaceOriginSync, []byte(`["wa_label"]`), strPtr("Elite"))

	applied, err := st.ApplyRaceCalendarWALabels(ctx, []RaceCalendarWALabel{
		{ID: syncRow, WALabel: strPtr("Gold")},
		{ID: manualRow, WALabel: strPtr("Gold")},
		{ID: overriddenRow, WALabel: strPtr("Gold")},
	})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if applied != 1 {
		t.Fatalf("applied = %d, want 1 (only the sync row without an override)", applied)
	}

	read := func(id uint64) *string {
		t.Helper()
		var row RaceCalendarEvent
		if err := st.db.WithContext(ctx).First(&row, id).Error; err != nil {
			t.Fatalf("read %d: %v", id, err)
		}
		return row.WALabel
	}
	if got := read(syncRow); got == nil || *got != "Gold" {
		t.Errorf("sync row wa_label = %v, want Gold", got)
	}
	if got := read(manualRow); got != nil {
		t.Errorf("manual row wa_label = %v, want untouched (nil)", *got)
	}
	if got := read(overriddenRow); got == nil || *got != "Elite" {
		t.Errorf("overridden row wa_label = %v, want the administrator's Elite kept", got)
	}

	// Clearing goes through the same guards, so an override survives a clear too.
	if _, err := st.ApplyRaceCalendarWALabels(ctx, []RaceCalendarWALabel{{ID: overriddenRow, WALabel: nil}}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if got := read(overriddenRow); got == nil || *got != "Elite" {
		t.Errorf("after clear, overridden row = %v, want Elite kept", got)
	}
}

// TestLoadRaceCalendarLabelScope pins the query's scoping: both calendars, one
// year, and the World Athletics side limited to China — a foreign WA race has no
// 中国田协 row to label and must not enter the match set.
func TestLoadRaceCalendarLabelScope(t *testing.T) {
	st := openTestStore(t)
	migrateRaceContent(t, st)
	ctx := context.Background()

	rows := []RaceCalendarEvent{
		{Source: RaceSourceChinaAth, Name: "杭马", RaceDate: "2026-11-01", Country: "CHN", Month: 11, DayOfMonth: 1, City: strPtr("杭州市"), Origin: RaceOriginSync},
		{Source: RaceSourceChinaAth, Name: "杭马2027", RaceDate: "2027-11-01", Country: "CHN", Month: 11, DayOfMonth: 1, City: strPtr("杭州市"), Origin: RaceOriginSync},
		{Source: RaceSourceWorldAth, Name: "Hangzhou Marathon", RaceDate: "2026-11-01", Country: "CHN", Month: 11, DayOfMonth: 1, City: strPtr("杭州市"), Origin: RaceOriginSync},
		{Source: RaceSourceWorldAth, Name: "Valencia Marathon", RaceDate: "2026-12-06", Country: "ESP", Month: 12, DayOfMonth: 6, City: strPtr("Valencia"), Origin: RaceOriginSync},
	}
	for i := range rows {
		if err := st.db.Create(&rows[i]).Error; err != nil {
			t.Fatalf("seed %s: %v", rows[i].Name, err)
		}
	}

	scope, err := st.LoadRaceCalendarLabelScope(ctx, "2026")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(scope.ChinaAth) != 1 || scope.ChinaAth[0].Name != "杭马" {
		t.Errorf("ChinaAth = %+v, want only the 2026 row", scope.ChinaAth)
	}
	if len(scope.WorldAth) != 1 || scope.WorldAth[0].Name != "Hangzhou Marathon" {
		t.Errorf("WorldAth = %+v, want only the Chinese 2026 row", scope.WorldAth)
	}
}
