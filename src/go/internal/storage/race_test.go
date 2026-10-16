package storage

import (
	"context"
	"encoding/json"
	"fmt"
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
	if got := reflect.TypeOf(Race{}).NumField(); got != 6 {
		t.Fatalf("Race has %d fields, want user_id, label_id, race_calendar_item_id, display_name, evidence, created_at", got)
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

	// A user-rejected match (user_cleared) is invisible to both rematch paths:
	// LinkRaceToCalendarItem refuses to re-chain it and the rematch projection
	// no longer lists the row.
	if err := st.db.WithContext(ctx).Model(&Race{}).
		Where("user_id = ? AND label_id = ?", uid, "plain").
		Update("evidence", racedetection.RaceEvidenceUserCleared).Error; err != nil {
		t.Fatalf("stamp user_cleared: %v", err)
	}
	linked, err = st.LinkRaceToCalendarItem(ctx, uid, "plain", 42)
	if err != nil || linked {
		t.Fatalf("relink after user_cleared must be refused: linked=%v err=%v", linked, err)
	}
	var cleared Race
	if err := st.db.WithContext(ctx).Where("user_id = ? AND label_id = ?", uid, "plain").First(&cleared).Error; err != nil {
		t.Fatalf("read cleared race: %v", err)
	}
	if cleared.RaceCalendarItemID != nil || cleared.Evidence != racedetection.RaceEvidenceUserCleared {
		t.Fatalf("cleared race = %+v, want still unlinked with user_cleared", cleared)
	}
	unlinked, err = st.RacesWithoutCalendarLink(ctx, uid)
	if err != nil {
		t.Fatalf("races without calendar link: %v", err)
	}
	if len(unlinked) != 0 {
		t.Fatalf("unlinked races = %+v, want user_cleared row excluded", unlinked)
	}
}

func TestUserRacesJoinsCalendarIdentity(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	if err := st.AutoMigrateRaceCalendar(ctx); err != nil {
		t.Fatalf("automigrate race calendar: %v", err)
	}
	uid := uuid.NewString()
	calItems := []RaceCalendarItem{{Name: "无锡马拉松 半马", Type: "half_marathon"}}
	event, cleanup := seedCalendarEventWithItems(t, st, "无锡马拉松TestUserRaces", calItems)
	defer cleanup()
	defer func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Race{})
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	}()
	// The seed helper does not set the curated Chinese name; fill it so the
	// name_cn-preferred branch is exercised.
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("id = ?", event.ID).
		Updates(map[string]any{"name_cn": "无锡马拉松", "label": "A", "wa_label": "Label"}).Error; err != nil {
		t.Fatalf("curate event: %v", err)
	}

	activities := []Activity{
		{UserID: uid, LabelID: "cal-hm", Name: strptr("2026-03-29 晨跑"), SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(21_200), Date: time.Date(2026, 3, 29, 1, 0, 0, 0, time.UTC), Provider: "test", SyncedAt: time.Now().UTC()},
		{UserID: uid, LabelID: "plain", Name: strptr("Plain HM"), SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(21_400), Date: time.Date(2026, 3, 29, 2, 0, 0, 0, time.UTC), Provider: "test", SyncedAt: time.Now().UTC()},
	}
	for i := range activities {
		if err := st.UpsertActivity(ctx, &activities[i], nil, nil, nil); err != nil {
			t.Fatalf("upsert %s: %v", activities[i].LabelID, err)
		}
	}
	if _, err := st.InsertRace(ctx, &Race{UserID: uid, LabelID: "cal-hm", RaceCalendarItemID: int64ptr(int64(calItems[0].ID)), Evidence: racedetection.RaceEvidenceCalendarMatch}); err != nil {
		t.Fatalf("insert linked race: %v", err)
	}
	if _, err := st.InsertRace(ctx, &Race{UserID: uid, LabelID: "plain"}); err != nil {
		t.Fatalf("insert plain race: %v", err)
	}

	rows, err := st.UserRaces(ctx, uid)
	if err != nil {
		t.Fatalf("user races: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %+v, want 2", rows)
	}
	byLabel := map[string]UserRaceRow{}
	for _, row := range rows {
		byLabel[row.LabelID] = row
	}
	linked, plain := byLabel["cal-hm"], byLabel["plain"]
	// Linked row carries the calendar identity chain: race_name prefers
	// name_cn, label/wa_label pass through; the activity name stays verbatim.
	if linked.RaceName == nil || *linked.RaceName != "无锡马拉松" {
		t.Fatalf("linked race_name = %v, want 无锡马拉松", linked.RaceName)
	}
	if linked.Label == nil || *linked.Label != "A" || linked.WALabel == nil || *linked.WALabel != "Label" {
		t.Fatalf("linked tiers = %v/%v, want A/Label", linked.Label, linked.WALabel)
	}
	if linked.DisplayName != nil || linked.Name == nil || *linked.Name != "2026-03-29 晨跑" {
		t.Fatalf("linked display/name = %v/%v, want nil + activity name", linked.DisplayName, linked.Name)
	}
	// Unlinked row: no calendar identity at all.
	if plain.RaceName != nil || plain.Label != nil || plain.WALabel != nil || plain.DisplayName != nil {
		t.Fatalf("plain identity = %v/%v/%v/%v, want all nil", plain.RaceName, plain.Label, plain.WALabel, plain.DisplayName)
	}

	// Empty-string name_cn falls back to the event name.
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("id = ?", event.ID).Update("name_cn", "").Error; err != nil {
		t.Fatalf("blank name_cn: %v", err)
	}
	rows, err = st.UserRaces(ctx, uid)
	if err != nil {
		t.Fatalf("user races after blank name_cn: %v", err)
	}
	for _, row := range rows {
		if row.LabelID == "cal-hm" && (row.RaceName == nil || *row.RaceName != event.Name) {
			t.Fatalf("race_name = %v, want event-name fallback %q", row.RaceName, event.Name)
		}
	}

	// Manual naming: set, read back, clear. rows are newest first; plain
	// started an hour after cal-hm, so it sits at index 0.
	name := "我的首马"
	if ok, err := st.SetRaceDisplayName(ctx, uid, "plain", &name); err != nil || !ok {
		t.Fatalf("set display name: ok=%v err=%v", ok, err)
	}
	rows, _ = st.UserRaces(ctx, uid)
	if rows[0].LabelID != "plain" || rows[0].DisplayName == nil || *rows[0].DisplayName != name {
		t.Fatalf("plain display_name = %+v, want %q", rows[0].DisplayName, name)
	}
	if ok, err := st.SetRaceDisplayName(ctx, uid, "plain", nil); err != nil || !ok {
		t.Fatalf("clear display name: ok=%v err=%v", ok, err)
	}
	rows, _ = st.UserRaces(ctx, uid)
	if rows[0].DisplayName != nil {
		t.Fatalf("cleared display_name = %+v, want nil", rows[0].DisplayName)
	}
	if ok, err := st.SetRaceDisplayName(ctx, uid, "missing", &name); err != nil || ok {
		t.Fatalf("unknown race must report false, got ok=%v err=%v", ok, err)
	}

	// Clearing the calendar link: evidence goes user_cleared, identity nils
	// out; a second call is a no-op that leaves evidence; unknown is false.
	if ok, err := st.ClearRaceCalendarLink(ctx, uid, "cal-hm"); err != nil || !ok {
		t.Fatalf("clear link: ok=%v err=%v", ok, err)
	}
	var severed Race
	if err := st.db.WithContext(ctx).Where("user_id = ? AND label_id = ?", uid, "cal-hm").First(&severed).Error; err != nil {
		t.Fatalf("read severed race: %v", err)
	}
	if severed.RaceCalendarItemID != nil || severed.Evidence != racedetection.RaceEvidenceUserCleared {
		t.Fatalf("severed race = %+v, want unlinked with user_cleared", severed)
	}
	rows, _ = st.UserRaces(ctx, uid)
	for _, row := range rows {
		if row.LabelID == "cal-hm" && (row.RaceName != nil || row.Label != nil || row.WALabel != nil) {
			t.Fatalf("severed identity = %v/%v/%v, want all nil", row.RaceName, row.Label, row.WALabel)
		}
	}
	if ok, err := st.ClearRaceCalendarLink(ctx, uid, "cal-hm"); err != nil || !ok {
		t.Fatalf("second clear (no-op) must report true, got ok=%v err=%v", ok, err)
	}
	var noop Race
	if err := st.db.WithContext(ctx).Where("user_id = ? AND label_id = ?", uid, "cal-hm").First(&noop).Error; err != nil {
		t.Fatalf("read no-op race: %v", err)
	}
	if noop.Evidence != racedetection.RaceEvidenceUserCleared {
		t.Fatalf("no-op changed evidence to %q, want user_cleared kept", noop.Evidence)
	}
	if ok, err := st.ClearRaceCalendarLink(ctx, uid, "missing"); err != nil || ok {
		t.Fatalf("unknown race must report false, got ok=%v err=%v", ok, err)
	}
}

func seedCalendarEventWithItems(t *testing.T, st *Store, name string, items []RaceCalendarItem) (*RaceCalendarEvent, func()) {
	t.Helper()
	ctx := context.Background()
	event := &RaceCalendarEvent{Source: "中国田协", Name: name, RaceDate: "2099-03-29", Month: 3, DayOfMonth: 29, Country: "CHN", City: strptr("盐城市")}
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
	// A fixture date the shared local database never holds: real mirrored
	// calendars have items on live 2026 dates (devops#563).
	_, cleanup := seedCalendarEventWithItems(t, st, "Test Marathon 2099", []RaceCalendarItem{
		{Name: "全程", Type: "Marathon", StartTime: strptr("07:30"), StartPoint: &RacePoint{Name: "盐城奥体", Lat: &lat, Lng: &lng}},
		{Name: "半程", Type: "HalfMarathon", DistanceKm: fptr(21.0975), StartPoint: &RacePoint{Name: "未定位"}},
	})
	defer cleanup()

	got, err := st.RaceCalendarItemsForDates(ctx, []string{"2099-03-29"})
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

	other, err := st.RaceCalendarItemsForDates(ctx, []string{"2099-01-01"})
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
	event, cleanup := seedCalendarEventWithItems(t, st, "Consensus Marathon 2026", []RaceCalendarItem{
		{Name: "全程", Type: "Marathon", StartPoint: &RacePoint{Name: "某广场"}},
	})
	defer cleanup()
	// Pick the item by its own event: the table is shared, and a global
	// "latest Marathon item" read would grab a real row on the local stack
	// and write test coordinates onto it (devops#563).
	var item RaceCalendarItem
	if err := st.db.WithContext(ctx).First(&item, "race_event_id = ? AND type = ?", event.ID, "Marathon").Error; err != nil {
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

func TestLongRunStartsAndCoordinateBackfill(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	uid := uuid.NewString()
	defer func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&TimeseriesPoint{})
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	}()
	zero := 0.0
	first, second := 31.127, 31.128
	activities := []Activity{
		{UserID: uid, LabelID: "no-coords", Name: strptr("HM"), SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(21_100), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
		{UserID: uid, LabelID: "cached", Name: strptr("HM"), SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(21_200), Date: time.Now().UTC().Add(time.Hour), Provider: "test", SyncedAt: time.Now().UTC(), StartGPSLat: fptr(second), StartGPSLon: fptr(121.056)},
		{UserID: uid, LabelID: "short", Name: strptr("easy"), SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(10_000), Date: time.Now().UTC().Add(2 * time.Hour), Provider: "test", SyncedAt: time.Now().UTC(), StartGPSLat: fptr(31.2), StartGPSLon: fptr(121.2)},
	}
	for i := range activities {
		if err := st.UpsertActivity(ctx, &activities[i], nil, nil, nil); err != nil {
			t.Fatalf("upsert %s: %v", activities[i].LabelID, err)
		}
	}
	// First fix for the coordinate-less HM is preceded by a zero/invalid fix.
	points := []TimeseriesPoint{
		{UserID: uid, LabelID: "no-coords", Timestamp: i64ptr(1), GPSLat: &zero, GPSLon: &zero},
		{UserID: uid, LabelID: "no-coords", Timestamp: i64ptr(2), GPSLat: fptr(first), GPSLon: fptr(121.055)},
		{UserID: uid, LabelID: "no-coords", Timestamp: i64ptr(3), GPSLat: fptr(31.13), GPSLon: fptr(121.06)},
	}
	if err := st.db.WithContext(ctx).Create(&points).Error; err != nil {
		t.Fatalf("seed timeseries: %v", err)
	}

	filled, err := st.BackfillActivityStartCoordinates(ctx, uid)
	if err != nil {
		t.Fatalf("backfill coordinates: %v", err)
	}
	if filled != 1 {
		t.Fatalf("backfilled %d rows, want 1 (cached and short rows untouched)", filled)
	}
	starts, err := st.LongRunStarts(ctx, uid)
	if err != nil {
		t.Fatalf("long run starts: %v", err)
	}
	if len(starts) != 2 {
		t.Fatalf("long run starts = %+v, want the two HM-band rows", starts)
	}
	var noCoords *LongRunStart
	for i := range starts {
		if starts[i].LabelID == "no-coords" {
			noCoords = &starts[i]
		}
	}
	if noCoords == nil || noCoords.Latitude != first || noCoords.Longitude != 121.055 {
		t.Fatalf("backfilled start = %+v, want the first VALID fix (zero skipped)", noCoords)
	}

	// Second run is a no-op.
	filled, err = st.BackfillActivityStartCoordinates(ctx, uid)
	if err != nil || filled != 0 {
		t.Fatalf("second backfill = (%d, %v), want idempotent zero", filled, err)
	}
}

func TestUserPaceBaselineWindowAndMedian(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	uid := uuid.NewString()
	defer st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	before := time.Date(2025, 1, 5, 7, 0, 0, 0, time.UTC)
	runs := []struct {
		days int
		pace float64
		dist float64
	}{
		{-1, 300, 21_000}, {-10, 294, 30_000}, {-30, 280, 25_000}, {-100, 246, 42_000}, // window
		{-200, 240, 42_000}, // outside the 180d lookback
		{-2, 200, 10_000},   // too short to count
	}
	for i, run := range runs {
		activity := Activity{UserID: uid, LabelID: fmt.Sprintf("run-%d", i), SportType: 100, Sport: strptr("run_outdoor"),
			DistanceM: fptr(run.dist), AvgPaceSKm: fptr(run.pace), Provider: "test", SyncedAt: time.Now().UTC(),
			Date: before.AddDate(0, 0, run.days)}
		if err := st.UpsertActivity(ctx, &activity, nil, nil, nil); err != nil {
			t.Fatalf("upsert %d: %v", i, err)
		}
	}

	baseline, err := st.UserPaceBaseline(ctx, uid, before, 180*24*time.Hour, 3)
	if err != nil {
		t.Fatalf("pace baseline: %v", err)
	}
	if baseline == nil {
		t.Fatal("baseline = nil, want a computed distribution")
	}
	if baseline.Count != 4 {
		t.Fatalf("sample count = %d, want 4 (window + distance filters)", baseline.Count)
	}
	if baseline.MedianPaceSKm != (280+294)/2.0 {
		t.Fatalf("median pace = %v, want 287 (even-count mean of middle two)", baseline.MedianPaceSKm)
	}
	if baseline.BestPaceSKm != 246 {
		t.Fatalf("best pace = %v, want 246", baseline.BestPaceSKm)
	}

	thin, err := st.UserPaceBaseline(ctx, uid, before, 3*24*time.Hour, 3)
	if err != nil || thin != nil {
		t.Fatalf("thin window baseline = (%+v, %v), want nil below min samples", thin, err)
	}
}
