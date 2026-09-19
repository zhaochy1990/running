package storage

import (
	"context"
	"testing"
)

// migrateCompetitionCalendar ensures the competition_calendar table exists for
// the integration test (the shared openTestStore only migrates jobs/pipeline_runs).
func migrateCompetitionCalendar(t *testing.T, st *Store) {
	t.Helper()
	if err := st.AutoMigrateCompetitionCalendar(context.Background()); err != nil {
		t.Fatalf("automigrate competition_calendar: %v", err)
	}
}

func strPtr(s string) *string { return &s }

func sampleCalendarEvents(season string) []CompetitionCalendarEvent {
	return []CompetitionCalendarEvent{
		{
			Source:    "world-athletics-label-road-races",
			Season:    season,
			EventID:   7236068,
			Name:      "40. OPTIMA Dreikönigslauf in Schwäbisch Hall",
			Venue:     strPtr("Schwäbisch Hall (GER)"),
			Country:   strPtr("GER"),
			StartDate: "2026-01-06",
			EndDate:   "2026-01-06",
			DateRange: "06 JAN 2026",
		},
		{
			Source:    "world-athletics-label-road-races",
			Season:    season,
			EventID:   7236100,
			Name:      "Tokyo Marathon",
			Venue:     strPtr("Tokyo (JPN)"),
			Country:   strPtr("JPN"),
			StartDate: "2026-03-01",
			EndDate:   "2026-03-01",
			DateRange: "01 MAR 2026",
		},
	}
}

func TestCompetitionCalendar_ReplaceMirrorsSeason(t *testing.T) {
	st := openTestStore(t)
	migrateCompetitionCalendar(t, st)
	ctx := context.Background()

	src := "world-athletics-label-road-races"
	season := "2026"

	// First sync seeds two events.
	res, err := st.ReplaceCompetitionCalendarSeason(ctx, src, season, sampleCalendarEvents(season))
	if err != nil {
		t.Fatalf("first replace: %v", err)
	}
	if res.Upserted != 2 || res.Deleted != 0 {
		t.Fatalf("first replace = %+v, want upserted=2 deleted=0", res)
	}

	// Second sync updates one event in place and drops the other: the row count
	// stays 2 but the stale event is deleted and the updated name persists.
	updated := sampleCalendarEvents(season)
	updated[0].Name = "OPTIMA Dreikönigslauf Schwäbisch Hall (renamed)"
	updated = updated[:1] // drop Tokyo Marathon
	res, err = st.ReplaceCompetitionCalendarSeason(ctx, src, season, updated)
	if err != nil {
		t.Fatalf("second replace: %v", err)
	}
	if res.Upserted != 1 || res.Deleted != 1 {
		t.Fatalf("second replace = %+v, want upserted=1 deleted=1", res)
	}

	var rows []CompetitionCalendarEvent
	if err := st.db.WithContext(ctx).Where("source = ? AND season = ?", src, season).Order("event_id").Find(&rows).Error; err != nil {
		t.Fatalf("list rows: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if rows[0].EventID != 7236068 || rows[0].Name != "OPTIMA Dreikönigslauf Schwäbisch Hall (renamed)" {
		t.Fatalf("row = %+v, want renamed event 7236068", rows[0])
	}
}

func TestCompetitionCalendar_SourcesAreIsolated(t *testing.T) {
	st := openTestStore(t)
	migrateCompetitionCalendar(t, st)
	ctx := context.Background()

	srcA := "world-athletics-label-road-races"
	srcB := "some-other-source"
	if _, err := st.ReplaceCompetitionCalendarSeason(ctx, srcA, "2026", sampleCalendarEvents("2026")); err != nil {
		t.Fatalf("replace srcA: %v", err)
	}
	if _, err := st.ReplaceCompetitionCalendarSeason(ctx, srcB, "2026", sampleCalendarEvents("2026")); err != nil {
		t.Fatalf("replace srcB: %v", err)
	}

	var n int64
	if err := st.db.WithContext(ctx).Model(&CompetitionCalendarEvent{}).Where("source = ?", srcA).Count(&n).Error; err != nil {
		t.Fatalf("count srcA: %v", err)
	}
	if n != 2 {
		t.Fatalf("srcA rows = %d, want 2", n)
	}
}

func TestCompetitionCalendar_EmptySeasonIsNoOp(t *testing.T) {
	st := openTestStore(t)
	migrateCompetitionCalendar(t, st)
	ctx := context.Background()

	src := "world-athletics-label-road-races"
	if _, err := st.ReplaceCompetitionCalendarSeason(ctx, src, "2026", sampleCalendarEvents("2026")); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// A transient empty upstream response must not wipe the season.
	res, err := st.ReplaceCompetitionCalendarSeason(ctx, src, "2026", nil)
	if err != nil {
		t.Fatalf("empty replace: %v", err)
	}
	if res.Upserted != 0 || res.Deleted != 0 {
		t.Fatalf("empty replace = %+v, want zeros", res)
	}

	var n int64
	if err := st.db.WithContext(ctx).Model(&CompetitionCalendarEvent{}).Where("source = ? AND season = ?", src, "2026").Count(&n).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 2 {
		t.Fatalf("rows after empty replace = %d, want 2 (not wiped)", n)
	}
}
