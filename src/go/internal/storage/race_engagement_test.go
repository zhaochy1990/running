package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// migrateRaceEngagement ensures the two engagement tables exist for the
// integration test and empties them (plus the calendar they reference, via
// migrateRaceCalendar) so each test starts isolated.
func migrateRaceEngagement(t *testing.T, st *Store) {
	t.Helper()
	ctx := context.Background()
	migrateRaceCalendar(t, st)
	if err := st.AutoMigrateRaceFavorites(ctx); err != nil {
		t.Fatalf("automigrate race_favorite: %v", err)
	}
	if err := st.AutoMigrateRacePlans(ctx); err != nil {
		t.Fatalf("automigrate race_plan: %v", err)
	}
	for _, table := range []string{"race_favorite", "race_plan"} {
		if err := st.db.WithContext(ctx).Exec("DELETE FROM " + table).Error; err != nil {
			t.Fatalf("clear %s: %v", table, err)
		}
	}
}

// seedEngagementRace inserts one calendar row and returns its id.
func seedEngagementRace(t *testing.T, st *Store, name, date string, published bool) uint64 {
	t.Helper()
	row := RaceCalendarEvent{
		Source: RaceSourceManual, Origin: RaceOriginManual,
		Name: name, RaceDate: date, Country: "CHN", Published: published,
	}
	if err := st.CreateRaceCalendarEvent(context.Background(), &row); err != nil {
		t.Fatalf("seed race %s: %v", name, err)
	}
	return row.ID
}

func TestRaceFavorite_ToggleRoundTripAndGuards(t *testing.T) {
	st := openTestStore(t)
	migrateRaceEngagement(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	pub := seedEngagementRace(t, st, "收藏赛", "2032-04-10", true)
	unpub := seedEngagementRace(t, st, "未发布赛", "2032-04-11", false)

	// Toggle is create-then-delete; the returned state follows each call.
	favorited, err := st.ToggleRaceFavorite(ctx, uid, pub)
	if err != nil || !favorited {
		t.Fatalf("first toggle: favorited=%v err=%v", favorited, err)
	}
	again, err := st.ToggleRaceFavorite(ctx, uid, pub)
	if err != nil || again {
		t.Fatalf("second toggle: favorited=%v err=%v", again, err)
	}

	// A nonexistent or unpublished race is not favoritable: 404 sentinel.
	if _, err := st.ToggleRaceFavorite(ctx, uid, unpub); err != ErrRaceCalendarNotFound {
		t.Fatalf("toggle unpublished race: err=%v want ErrRaceCalendarNotFound", err)
	}
	if _, err := st.ToggleRaceFavorite(ctx, uid, 999999); err != ErrRaceCalendarNotFound {
		t.Fatalf("toggle missing race: err=%v want ErrRaceCalendarNotFound", err)
	}
}

func TestRaceFavorite_UniqueConstraint(t *testing.T) {
	st := openTestStore(t)
	migrateRaceEngagement(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	raceID := seedEngagementRace(t, st, "唯一约束赛", "2032-05-01", true)

	first := &RaceFavorite{UserID: uid, RaceEventID: raceID, CreatedAt: time.Now().UTC()}
	if err := st.db.WithContext(ctx).Create(first).Error; err != nil {
		t.Fatalf("seed favorite: %v", err)
	}
	dup := &RaceFavorite{UserID: uid, RaceEventID: raceID, CreatedAt: time.Now().UTC()}
	if err := st.db.WithContext(ctx).Create(dup).Error; !isDuplicateKey(err) {
		t.Fatalf("duplicate favorite: err=%v want duplicate-key", err)
	}
}

func TestRaceFavorite_ListFiltersUnpublished(t *testing.T) {
	st := openTestStore(t)
	migrateRaceEngagement(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	kept1 := seedEngagementRace(t, st, "收藏列表甲", "2032-06-01", true)
	dropped := seedEngagementRace(t, st, "收藏列表乙", "2032-06-02", true)
	kept2 := seedEngagementRace(t, st, "收藏列表丙", "2032-06-03", true)

	// Favorite in reverse id order so created_at DESC is observable, then
	// offboard one race: its favorite must drop out of the collection silently.
	for _, id := range []uint64{dropped, kept2, kept1} {
		if _, err := st.ToggleRaceFavorite(ctx, uid, id); err != nil {
			t.Fatalf("toggle %d: %v", id, err)
		}
	}
	if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
		Where("id IN ?", []uint64{dropped, kept2}).Update("published", false).Error; err != nil {
		t.Fatalf("unpublish: %v", err)
	}

	ids, err := st.ListRaceFavoriteIDs(ctx, uid)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(ids) != 1 || ids[0] != kept1 {
		t.Fatalf("ids = %v, want [%d]", ids, kept1)
	}

	// Another user's favorites stay invisible, as an empty (never null) slice.
	other, err := st.ListRaceFavoriteIDs(ctx, uuid.NewString())
	if err != nil {
		t.Fatalf("list other: %v", err)
	}
	if other == nil || len(other) != 0 {
		t.Fatalf("other user ids = %v, want empty non-nil slice", other)
	}
}

func TestRacePlan_FourStateRoundTrip(t *testing.T) {
	st := openTestStore(t)
	migrateRaceEngagement(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	raceID := seedEngagementRace(t, st, "状态机赛", "2032-07-01", true)

	hotel, transit := true, true
	plan, err := st.UpsertRacePlan(ctx, RacePlanUpsert{
		UserID: uid, RaceEventID: raceID,
		ItemType: "Marathon", State: RacePlanStateRegistered,
		Hotel: &hotel, Transit: &transit,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if plan.State != RacePlanStateRegistered || !plan.Hotel || !plan.Transit {
		t.Fatalf("created plan wrong: %+v", plan)
	}
	if plan.CreatedAt.IsZero() || plan.UpdatedAt.IsZero() {
		t.Fatalf("timestamps not stamped: %+v", plan)
	}
	firstUpdated := plan.UpdatedAt

	firstCreated := plan.CreatedAt

	// registered -> won: the whole four-state machine is driven by upserts; the
	// travel booleans ride along and absent keys preserve the stored values.
	for _, state := range []string{RacePlanStateWon, RacePlanStateLost, RacePlanStateConfirmed} {
		plan, err = st.UpsertRacePlan(ctx, RacePlanUpsert{
			UserID: uid, RaceEventID: raceID,
			ItemType: "HalfMarathon", State: state,
		})
		if err != nil {
			t.Fatalf("transition to %s: %v", state, err)
		}
		if plan.State != state || plan.ItemType != "HalfMarathon" {
			t.Fatalf("transition to %s wrong: %+v", state, plan)
		}
		if !plan.Hotel || !plan.Transit {
			t.Fatalf("absent hotel/transit not preserved at %s: %+v", state, plan)
		}
	}
	if plan.UpdatedAt.Truncate(time.Millisecond).Before(firstUpdated.Truncate(time.Millisecond)) {
		t.Fatalf("updated_at not moved: %v -> %v", firstUpdated, plan.UpdatedAt)
	}

	// Explicit false clears a checkbox without touching its sibling.
	off := false
	plan, err = st.UpsertRacePlan(ctx, RacePlanUpsert{
		UserID: uid, RaceEventID: raceID,
		ItemType: "HalfMarathon", State: RacePlanStateConfirmed, Hotel: &off,
	})
	if err != nil {
		t.Fatalf("clear hotel: %v", err)
	}
	if plan.Hotel || !plan.Transit {
		t.Fatalf("explicit false semantics wrong: %+v", plan)
	}

	// MySQL DATETIME(3) truncates microseconds, so the timestamp assertions
	// compare at millisecond granularity.
	if plan.CreatedAt.IsZero() || plan.CreatedAt.Truncate(time.Millisecond).Before(firstCreated.Truncate(time.Millisecond)) {
		t.Fatalf("created_at must survive upserts: %v", plan.CreatedAt)
	}

	// Unpublished / missing races are not plannable: 404 sentinel.
	unpub := seedEngagementRace(t, st, "不可计划赛", "2032-07-02", false)
	if _, err := st.UpsertRacePlan(ctx, RacePlanUpsert{
		UserID: uid, RaceEventID: unpub, ItemType: "Marathon", State: RacePlanStateRegistered,
	}); err != ErrRaceCalendarNotFound {
		t.Fatalf("upsert unpublished race: err=%v want ErrRaceCalendarNotFound", err)
	}
}

func TestRacePlan_UniqueConstraintAndDelete(t *testing.T) {
	st := openTestStore(t)
	migrateRaceEngagement(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	raceID := seedEngagementRace(t, st, "唯一计划赛", "2032-08-01", true)

	first := &RacePlan{UserID: uid, RaceEventID: raceID, ItemType: "Marathon", State: RacePlanStateRegistered}
	if err := st.db.WithContext(ctx).Create(first).Error; err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	dup := &RacePlan{UserID: uid, RaceEventID: raceID, ItemType: "Marathon", State: RacePlanStateWon}
	if err := st.db.WithContext(ctx).Create(dup).Error; !isDuplicateKey(err) {
		t.Fatalf("duplicate plan: err=%v want duplicate-key", err)
	}

	if err := st.DeleteRacePlan(ctx, uid, raceID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := st.DeleteRacePlan(ctx, uid, raceID); err != ErrRacePlanNotFound {
		t.Fatalf("second delete: err=%v want ErrRacePlanNotFound", err)
	}
}

// TestRacePlan_ListOffboardingLayering pins the 失效分层 contract: lost plans on
// unpublished/deleted races vanish, every other state survives with
// Offboarded=true, and published plans stay normal (Offboarded=false).
func TestRacePlan_ListOffboardingLayering(t *testing.T) {
	st := openTestStore(t)
	migrateRaceEngagement(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	later := seedEngagementRace(t, st, "分层后程赛", "2032-10-01", true)
	soon := seedEngagementRace(t, st, "分层近程赛", "2032-09-01", true)
	offboardedLost := seedEngagementRace(t, st, "分层未中签赛", "2032-09-15", true)
	offboardedRegistered := seedEngagementRace(t, st, "分层已报名赛", "2032-09-20", true)

	seed := func(raceID uint64, state string) {
		t.Helper()
		if _, err := st.UpsertRacePlan(ctx, RacePlanUpsert{
			UserID: uid, RaceEventID: raceID, ItemType: "Marathon", State: state,
		}); err != nil {
			t.Fatalf("seed plan race=%d state=%s: %v", raceID, state, err)
		}
	}
	// The upsert refuses unpublished races by design, so seed the offboarded
	// pair while published, then flip published off.
	seed(offboardedLost, RacePlanStateLost)
	seed(offboardedRegistered, RacePlanStateRegistered)
	seed(soon, RacePlanStateWon)
	seed(later, RacePlanStateConfirmed)
	for _, id := range []uint64{offboardedLost, offboardedRegistered} {
		if err := st.db.WithContext(ctx).Model(&RaceCalendarEvent{}).
			Where("id = ?", id).Update("published", false).Error; err != nil {
			t.Fatalf("unpublish %d: %v", id, err)
		}
	}

	rows, err := st.ListRacePlans(ctx, uid)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var got []uint64
	offboardedByID := map[uint64]bool{}
	for _, row := range rows {
		got = append(got, row.Plan.RaceEventID)
		offboardedByID[row.Plan.RaceEventID] = row.Offboarded()
	}
	// lost-on-unpublished is silently dropped; the other three survive, ordered
	// by race date ascending.
	want := []uint64{soon, offboardedRegistered, later}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order: got %v want %v", got, want)
		}
	}
	if !offboardedByID[offboardedRegistered] {
		t.Fatalf("registered plan on unpublished race must be offboarded")
	}
	if offboardedByID[soon] || offboardedByID[later] {
		t.Fatalf("published plans must not be offboarded: %v", offboardedByID)
	}

	// A plan whose race row was deleted outright renders the same placeholder:
	// kept, offboarded, race projection nil.
	if err := st.db.WithContext(ctx).
		Where("id = ?", later).Delete(&RaceCalendarEvent{}).Error; err != nil {
		t.Fatalf("delete race: %v", err)
	}
	rows, err = st.ListRacePlans(ctx, uid)
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	for _, row := range rows {
		if row.Plan.RaceEventID == later {
			if row.Race != nil || !row.Offboarded() {
				t.Fatalf("deleted race must read as offboarded with nil race: %+v", row)
			}
		}
	}
}
