package storage

import (
	"context"
	"testing"
	"time"
)

// migrateRaceCatalog ensures the tables the user-facing catalog reads exist and
// are empty (race_calendar via the shared migrateRaceCalendar, race_favorite
// here) so each test starts isolated.
func migrateRaceCatalog(t *testing.T, st *Store) {
	t.Helper()
	migrateRaceCalendar(t, st)
	ctx := context.Background()
	if err := st.AutoMigrateRaceFavorites(ctx); err != nil {
		t.Fatalf("automigrate race_favorite: %v", err)
	}
	if err := st.db.WithContext(ctx).Exec("DELETE FROM race_favorite").Error; err != nil {
		t.Fatalf("clear race_favorite: %v", err)
	}
}

// TestPublishedList covers ListPublishedRaceCalendarEvents against real MySQL:
// the published-only invariant, the year window, the 即将开跑 date floor, the
// item-type join, the city match, ordering, and pagination.
func TestPublishedList(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCatalog(t, st)
	ctx := context.Background()

	seed := func(row RaceCalendarEvent) RaceCalendarEvent {
		t.Helper()
		if err := st.CreateRaceCalendarEvent(ctx, &row); err != nil {
			t.Fatalf("seed %s: %v", row.Name, err)
		}
		return row
	}
	const src = "测试源-用户目录"
	// Year 2031 fixture: three published races (one before the floor, two
	// after), one unpublished, one published in the neighbouring year.
	p1 := seed(RaceCalendarEvent{Source: src, Name: "Early Race", RaceDate: "2031-03-10", Country: "CHN", City: strPtr("厦门市"), Published: true})
	seed(RaceCalendarEvent{Source: src, Name: "Draft Race", RaceDate: "2031-04-01", Country: "CHN", City: strPtr("厦门市"), Published: false})
	p3 := seed(RaceCalendarEvent{Source: src, Name: "Hangzhou Race", RaceDate: "2031-06-10", Country: "CHN", City: strPtr("杭州市"), Published: true})
	p2 := seed(RaceCalendarEvent{Source: src, Name: "Late Race", RaceDate: "2031-06-20", Country: "CHN", City: strPtr("厦门市"), Published: true})
	seed(RaceCalendarEvent{Source: src, Name: "Other Year Race", RaceDate: "2030-12-31", Country: "CHN", City: strPtr("厦门市"), Published: true})

	if err := st.CreateRaceCalendarItem(ctx, &RaceCalendarItem{RaceEventID: p1.ID, Name: "马拉松", Type: "Marathon"}); err != nil {
		t.Fatalf("seed item p1: %v", err)
	}
	if err := st.CreateRaceCalendarItem(ctx, &RaceCalendarItem{RaceEventID: p2.ID, Name: "半程马拉松", Type: "HalfMarathon"}); err != nil {
		t.Fatalf("seed item p2: %v", err)
	}
	// p3 deliberately has no items (a World Athletics row shape).

	ids := func(rows []RaceCalendarEvent) []uint64 {
		out := make([]uint64, len(rows))
		for i, row := range rows {
			out[i] = row.ID
		}
		return out
	}

	// Whole year: published only, ordered by race_date (the unpublished row
	// and the other-year row never surface — the exact-order assertion below
	// pins the full membership).
	rows, total, err := st.ListPublishedRaceCalendarEvents(ctx, PublishedRaceFilter{Year: "2031"})
	if err != nil {
		t.Fatalf("list year: %v", err)
	}
	if total != 3 || len(rows) != 3 {
		t.Fatalf("year list = %v (total %d), want 3 published 2031 rows", ids(rows), total)
	}
	want := []uint64{p1.ID, p3.ID, p2.ID}
	for i := range want {
		if rows[i].ID != want[i] {
			t.Fatalf("order = %v, want %v", ids(rows), want)
		}
	}

	// 即将开跑 floor: only races on/after the date.
	rows, total, err = st.ListPublishedRaceCalendarEvents(ctx, PublishedRaceFilter{Year: "2031", FromDate: "2031-06-01"})
	if err != nil {
		t.Fatalf("list upcoming: %v", err)
	}
	if total != 2 || len(rows) != 2 || rows[0].ID != p3.ID || rows[1].ID != p2.ID {
		t.Fatalf("upcoming list = %v (total %d), want [%d %d]", ids(rows), total, p3.ID, p2.ID)
	}

	// Type join: Marathon matches p1's item; p3 has no items so it never
	// matches; the unpublished row's own item does not save it.
	rows, total, err = st.ListPublishedRaceCalendarEvents(ctx, PublishedRaceFilter{Year: "2031", Type: "Marathon"})
	if err != nil {
		t.Fatalf("list by type: %v", err)
	}
	if total != 1 || len(rows) != 1 || rows[0].ID != p1.ID {
		t.Fatalf("type=Marathon = %v (total %d), want [%d]", ids(rows), total, p1.ID)
	}

	// City match on the event's own spelling.
	rows, total, err = st.ListPublishedRaceCalendarEvents(ctx, PublishedRaceFilter{Year: "2031", City: "杭州市"})
	if err != nil {
		t.Fatalf("list by city: %v", err)
	}
	if total != 1 || len(rows) != 1 || rows[0].ID != p3.ID {
		t.Fatalf("city=杭州市 = %v (total %d), want [%d]", ids(rows), total, p3.ID)
	}

	// Pagination: page 2 of 2 keeps the ordering and reports the full total.
	rows, total, err = st.ListPublishedRaceCalendarEvents(ctx, PublishedRaceFilter{Year: "2031", PerPage: 2, Page: 2})
	if err != nil {
		t.Fatalf("list page 2: %v", err)
	}
	if total != 3 || len(rows) != 1 || rows[0].ID != p2.ID {
		t.Fatalf("page 2 = %v (total %d), want [%d]", ids(rows), total, p2.ID)
	}

}

// TestFavoritedRaceEventIDs covers the star-state lookup, including the empty
// batch short-circuit and the UNIQUE(user, event) constraint.
func TestFavoritedRaceEventIDs(t *testing.T) {
	st := openTestStore(t)
	migrateRaceCatalog(t, st)
	ctx := context.Background()

	const user = "11111111-1111-4111-8111-111111111111"
	ev := RaceCalendarEvent{Source: "测试源-收藏", Name: "Fav Race", RaceDate: "2031-05-01", Country: "CHN", Published: true}
	if err := st.CreateRaceCalendarEvent(ctx, &ev); err != nil {
		t.Fatalf("seed event: %v", err)
	}
	other := RaceCalendarEvent{Source: "测试源-收藏", Name: "Other Race", RaceDate: "2031-05-02", Country: "CHN", Published: true}
	if err := st.CreateRaceCalendarEvent(ctx, &other); err != nil {
		t.Fatalf("seed other: %v", err)
	}

	now := time.Now().UTC().Truncate(time.Second)
	for _, id := range []uint64{ev.ID, other.ID} {
		if err := st.db.WithContext(ctx).Create(&RaceFavorite{UserID: user, RaceEventID: id, CreatedAt: now}).Error; err != nil {
			t.Fatalf("seed favorite %d: %v", id, err)
		}
	}

	got, err := st.FavoritedRaceEventIDs(ctx, user, []uint64{ev.ID, other.ID + 999})
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if len(got) != 1 || !got[ev.ID] {
		t.Fatalf("lookup = %v, want {%d}", got, ev.ID)
	}

	// A different user starts with no favorites.
	got, err = st.FavoritedRaceEventIDs(ctx, "22222222-2222-4222-8222-222222222222", []uint64{ev.ID})
	if err != nil {
		t.Fatalf("other user lookup: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("other user lookup = %v, want empty", got)
	}

	// Empty batch: no query, empty set.
	got, err = st.FavoritedRaceEventIDs(ctx, user, nil)
	if err != nil {
		t.Fatalf("empty lookup: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("empty lookup = %v, want empty", got)
	}

	// The UNIQUE(user, event) index rejects a second star of the same race.
	if err := st.db.WithContext(ctx).Create(&RaceFavorite{UserID: user, RaceEventID: ev.ID, CreatedAt: now}).Error; err == nil {
		t.Fatal("duplicate favorite insert should fail on the unique index")
	}
}
