package storage

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/racedetection"
)

func TestRaceTableStoresOnlyActivityReference(t *testing.T) {
	if got := (Race{}).TableName(); got != "races" {
		t.Fatalf("table = %q", got)
	}
	if got := reflect.TypeOf(Race{}).NumField(); got != 5 {
		t.Fatalf("Race has %d fields, want user_id, label_id, race_calendar_item_id, evidence, created_at", got)
	}
}

func TestRaceCandidatesFiltersAndSkipsConfirmed(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	uid := uuid.NewString()
	pauses := `[{"startTimestamp":171002790000,"endTimestamp":171002791234,"duration":1234}]`
	defer func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Race{})
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	}()

	activities := []Activity{
		{UserID: uid, LabelID: "hm", Name: strptr("Half effort"), SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(20_900), Pauses: &pauses, Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC(), StartGPSLat: fptr(31.2304), StartGPSLon: fptr(121.4737)},
		{UserID: uid, LabelID: "fm-track", Name: strptr("Track marathon"), SportType: 100, Sport: strptr("run_track"), DistanceM: fptr(44_000), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC(), StartGPSLat: fptr(39.9042), StartGPSLon: fptr(116.4074)},
		{UserID: uid, LabelID: "long-30k", SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(30_000), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
		{UserID: uid, LabelID: "indoor-hm", SportType: 100, Sport: strptr("run_indoor"), DistanceM: fptr(21_100), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
	}
	for i := range activities {
		if err := st.UpsertActivity(ctx, &activities[i], nil, nil, nil); err != nil {
			t.Fatalf("upsert %s: %v", activities[i].LabelID, err)
		}
	}

	starts, err := st.ActivityStartCoordinates(ctx, uid)
	if err != nil {
		t.Fatalf("activity start coordinates: %v", err)
	}
	startSet := map[[2]float64]bool{}
	for _, start := range starts {
		startSet[[2]float64{start.Latitude, start.Longitude}] = true
	}
	if len(starts) != 2 || !startSet[[2]float64{31.2304, 121.4737}] || !startSet[[2]float64{39.9042, 116.4074}] {
		t.Fatalf("activity start coordinates = %+v, want activity-level cached coordinates", starts)
	}

	all, err := st.RaceCandidates(ctx, uid, nil)
	if err != nil {
		t.Fatalf("all-history candidates: %v", err)
	}
	allIDs := map[string]bool{}
	for _, candidate := range all {
		allIDs[candidate.LabelID] = true
	}
	if len(all) != 2 || !allIDs["hm"] || !allIDs["fm-track"] {
		t.Fatalf("all-history candidates = %+v", all)
	}
	for _, candidate := range all {
		if candidate.LabelID == "hm" {
			if candidate.Pauses == nil {
				t.Fatal("HM pause data is nil, want stored activity pauses")
			}
			var gotPauses, wantPauses any
			if err := json.Unmarshal([]byte(*candidate.Pauses), &gotPauses); err != nil {
				t.Fatalf("decode HM pause data: %v", err)
			}
			if err := json.Unmarshal([]byte(pauses), &wantPauses); err != nil || !reflect.DeepEqual(gotPauses, wantPauses) {
				t.Fatalf("HM pause data = %s, want JSON-equivalent %s", *candidate.Pauses, pauses)
			}
		}
	}
	empty, err := st.RaceCandidates(ctx, uid, []string{})
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty incremental scope = (%+v, %v), want no candidates", empty, err)
	}

	inserted, err := st.InsertRace(ctx, &Race{UserID: uid, LabelID: "hm"})
	if err != nil || !inserted {
		t.Fatalf("insert confirmed race: %v", err)
	}
	inserted, err = st.InsertRace(ctx, &Race{UserID: uid, LabelID: "hm"})
	if err != nil || inserted {
		t.Fatalf("duplicate confirmed race: %v", err)
	}
	var raceCount int64
	if err := st.db.WithContext(ctx).Model(&Race{}).Where("user_id = ? AND label_id = ?", uid, "hm").Count(&raceCount).Error; err != nil {
		t.Fatalf("count confirmed race: %v", err)
	}
	if raceCount != 1 {
		t.Fatalf("confirmed race count = %d, want idempotent singleton", raceCount)
	}
	remaining, err := st.RaceCandidates(ctx, uid, []string{"hm", "fm-track", "long-30k"})
	if err != nil {
		t.Fatalf("incremental candidates: %v", err)
	}
	if len(remaining) != 1 || remaining[0].LabelID != "fm-track" {
		t.Fatalf("remaining candidates = %+v", remaining)
	}
}

func int64ptr(v int64) *int64 { return &v }

func TestRaceEvidenceAndCalendarLinkLifecycle(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	uid := uuid.NewString()
	defer func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Race{})
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	}()
	activities := []Activity{
		{UserID: uid, LabelID: "cal-hm", Name: strptr("HM"), SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(21_200), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC(), StartGPSLat: fptr(39.902), StartGPSLon: fptr(116.393)},
		{UserID: uid, LabelID: "plain", Name: strptr("Plain HM"), SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(21_400), Date: time.Now().UTC().Add(time.Hour), Provider: "test", SyncedAt: time.Now().UTC(), StartGPSLat: fptr(31.23), StartGPSLon: fptr(121.47)},
	}
	for i := range activities {
		if err := st.UpsertActivity(ctx, &activities[i], nil, nil, nil); err != nil {
			t.Fatalf("upsert %s: %v", activities[i].LabelID, err)
		}
	}

	inserted, err := st.InsertRace(ctx, &Race{UserID: uid, LabelID: "cal-hm", RaceCalendarItemID: int64ptr(77), Evidence: "calendar_match"})
	if err != nil || !inserted {
		t.Fatalf("insert calendar-matched race: %v", err)
	}
	var stored Race
	if err := st.db.WithContext(ctx).Where("user_id = ? AND label_id = ?", uid, "cal-hm").First(&stored).Error; err != nil {
		t.Fatalf("read race: %v", err)
	}
	if stored.Evidence != "calendar_match" || stored.RaceCalendarItemID == nil || *stored.RaceCalendarItemID != 77 {
		t.Fatalf("stored calendar race = %+v, want item 77 with calendar_match evidence", stored)
	}

	// Default evidence backfills the model-score path.
	if _, err := st.InsertRace(ctx, &Race{UserID: uid, LabelID: "plain"}); err != nil {
		t.Fatalf("insert plain race: %v", err)
	}
	var plain Race
	if err := st.db.WithContext(ctx).Where("user_id = ? AND label_id = ?", uid, "plain").First(&plain).Error; err != nil {
		t.Fatalf("read plain race: %v", err)
	}
	if plain.Evidence != "model_score" || plain.RaceCalendarItemID != nil {
		t.Fatalf("plain race = %+v, want model_score without item", plain)
	}

	// Linking only fills empty slots and never overwrites.
	linked, err := st.LinkRaceToCalendarItem(ctx, uid, "plain", 42)
	if err != nil || !linked {
		t.Fatalf("link plain race: %v", err)
	}
	linked, err = st.LinkRaceToCalendarItem(ctx, uid, "plain", 99)
	if err != nil || linked {
		t.Fatalf("relink must not overwrite: %v", err)
	}
	var relinked Race
	if err := st.db.WithContext(ctx).Where("user_id = ? AND label_id = ?", uid, "plain").First(&relinked).Error; err != nil {
		t.Fatalf("read relinked: %v", err)
	}
	if *relinked.RaceCalendarItemID != 42 {
		t.Fatalf("relinked item = %d, want 42", *relinked.RaceCalendarItemID)
	}

	// Rematch projection returns only unlinked confirmed races.
	unlinked, err := st.RacesWithoutCalendarLink(ctx, uid)
	if err != nil {
		t.Fatalf("races without calendar link: %v", err)
	}
	if len(unlinked) != 0 {
		t.Fatalf("unlinked races = %+v, want none", unlinked)
	}
	if err := st.db.WithContext(ctx).Model(&Race{}).Where("user_id = ? AND label_id = ?", uid, "plain").Update("race_calendar_item_id", nil).Error; err != nil {
		t.Fatalf("unlink for rematch: %v", err)
	}
	unlinked, err = st.RacesWithoutCalendarLink(ctx, uid)
	if err != nil {
		t.Fatalf("races without calendar link: %v", err)
	}
	if len(unlinked) != 1 || unlinked[0].LabelID != "plain" || unlinked[0].StartGPSLat == nil {
		t.Fatalf("unlinked races = %+v, want plain with start coords", unlinked)
	}
}

func seedCalendarEventWithItems(t *testing.T, st *Store, name string, items []RaceCalendarItem) (*RaceCalendarEvent, func()) {
	t.Helper()
	ctx := context.Background()
	event := &RaceCalendarEvent{Source: "中国田协", Name: name, RaceDate: "2026-03-29", Month: 3, DayOfMonth: 29, Country: "CHN", City: strptr("盐城市")}
	if err := st.CreateRaceCalendarEvent(ctx, event); err != nil {
		t.Fatalf("create event: %v", err)
	}
	for i := range items {
		items[i].RaceEventID = event.ID
		if err := st.CreateRaceCalendarItem(ctx, &items[i]); err != nil {
			t.Fatalf("create item: %v", err)
		}
	}
	return event, func() {
		st.db.WithContext(ctx).Where("race_event_id = ?", event.ID).Delete(&RaceCalendarItem{})
		st.db.WithContext(ctx).Where("id = ?", event.ID).Delete(&RaceCalendarEvent{})
	}
}

func TestRaceCalendarItemsForDatesProjection(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateRaceCalendar(ctx); err != nil {
		t.Fatalf("automigrate race calendar: %v", err)
	}
	lat, lng := 33.321, 120.174
	_, cleanup := seedCalendarEventWithItems(t, st, "Test Marathon 2026", []RaceCalendarItem{
		{Name: "全程", Type: "Marathon", StartTime: strptr("07:30"), StartPoint: &RacePoint{Name: "盐城奥体", Lat: &lat, Lng: &lng}},
		{Name: "半程", Type: "HalfMarathon", DistanceKm: fptr(21.0975), StartPoint: &RacePoint{Name: "未定位"}},
	})
	defer cleanup()

	got, err := st.RaceCalendarItemsForDates(ctx, []string{"2026-03-29"})
	if err != nil {
		t.Fatalf("items for dates: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("items = %+v, want 2", got)
	}
	var full, half *racedetection.CalendarItem
	for i := range got {
		switch got[i].Type {
		case "Marathon":
			full = &got[i]
		case "HalfMarathon":
			half = &got[i]
		}
	}
	if full == nil || full.GunTime == nil || *full.GunTime != "07:30" || full.StartLat == nil || *full.StartLat != lat || *full.StartLng != lng {
		t.Fatalf("marathon item = %+v, want gun time and coordinates", full)
	}
	if half == nil || half.StartLat != nil || half.DistanceKM == nil || *half.DistanceKM != 21.0975 {
		t.Fatalf("half item = %+v, want no coordinates with distance", half)
	}

	other, err := st.RaceCalendarItemsForDates(ctx, []string{"2026-01-01"})
	if err != nil || len(other) != 0 {
		t.Fatalf("items for other date = (%+v, %v), want none", other, err)
	}
}

func TestUpdateRaceCalendarItemStartFromConsensus(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	if err := st.AutoMigrateRaceCalendar(ctx); err != nil {
		t.Fatalf("automigrate race calendar: %v", err)
	}
	_, cleanup := seedCalendarEventWithItems(t, st, "Consensus Marathon 2026", []RaceCalendarItem{
		{Name: "全程", Type: "Marathon", StartPoint: &RacePoint{Name: "某广场"}},
	})
	defer cleanup()
	var item RaceCalendarItem
	if err := st.db.WithContext(ctx).Order("id DESC").First(&item, "type = ?", "Marathon").Error; err != nil {
		t.Fatalf("load seeded item: %v", err)
	}
	userIDs := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	defer st.db.WithContext(ctx).Where("user_id IN ?", userIDs).Delete(&Race{})
	defer st.db.WithContext(ctx).Where("user_id IN ?", userIDs).Delete(&Activity{})
	// Two agreeing starts are below the three-user bar.
	for i, uid := range userIDs[:2] {
		lat, lng := 39.9018+float64(i)*0.0002, 116.3930
		if err := st.UpsertActivity(ctx, &Activity{UserID: uid, LabelID: "r", SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(42_300), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC(), StartGPSLat: fptr(lat), StartGPSLon: fptr(lng)}, nil, nil, nil); err != nil {
			t.Fatalf("upsert: %v", err)
		}
		if _, err := st.InsertRace(ctx, &Race{UserID: uid, LabelID: "r", Evidence: "calendar_match", RaceCalendarItemID: int64ptr(int64(item.ID))}); err != nil {
			t.Fatalf("insert race: %v", err)
		}
	}
	if wrote, err := st.UpdateRaceCalendarItemStartFromConsensus(ctx, int64(item.ID), 3, 300); err != nil || wrote {
		t.Fatalf("two-user consensus wrote (%t, %v), want no write", wrote, err)
	}
	// A third agreeing user unlocks the write-back.
	uid := userIDs[2]
	if err := st.UpsertActivity(ctx, &Activity{UserID: uid, LabelID: "r", SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(42_100), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC(), StartGPSLat: fptr(39.9024), StartGPSLon: fptr(116.3928)}, nil, nil, nil); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if _, err := st.InsertRace(ctx, &Race{UserID: uid, LabelID: "r", Evidence: "calendar_match", RaceCalendarItemID: int64ptr(int64(item.ID))}); err != nil {
		t.Fatalf("insert race: %v", err)
	}
	if wrote, err := st.UpdateRaceCalendarItemStartFromConsensus(ctx, int64(item.ID), 3, 300); err != nil || !wrote {
		t.Fatalf("three-user consensus wrote (%t, %v), want write", wrote, err)
	}
	updated, err := st.GetRaceCalendarItem(ctx, item.ID)
	if err != nil || updated == nil {
		t.Fatalf("reload item: %v", err)
	}
	if updated.StartPoint == nil || updated.StartPoint.Name != "某广场" || updated.StartPoint.Lat == nil || *updated.StartPoint.Lat < 39.90 || *updated.StartPoint.Lat > 39.91 {
		t.Fatalf("updated start point = %+v, want preserved name with consensus coordinates", updated.StartPoint)
	}
	// A second call is a no-op: coordinates already present.
	if wrote, err := st.UpdateRaceCalendarItemStartFromConsensus(ctx, int64(item.ID), 3, 300); err != nil || wrote {
		t.Fatalf("second consensus wrote (%t, %v), want idempotent skip", wrote, err)
	}
}
