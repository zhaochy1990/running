package storage

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/racetypes"
)

// migrateUserCustomRace ensures the table exists and is emptied, so each test
// starts isolated (mirrors migrateRaceEngagement).
func migrateUserCustomRace(t *testing.T, st *Store) {
	t.Helper()
	if err := st.AutoMigrateUserCustomRaces(context.Background()); err != nil {
		t.Fatalf("automigrate user_custom_race: %v", err)
	}
	if err := st.db.Exec("DELETE FROM user_custom_race").Error; err != nil {
		t.Fatalf("clear user_custom_race: %v", err)
	}
}

// TestUserCustomRace_CRUDIsolationAndOrder pins the store contract against
// real MySQL: date-ascending list, full-update replacement, and the strict
// ownership scoping (a foreign id is the same not-found as a missing one).
func TestUserCustomRace_CRUDIsolationAndOrder(t *testing.T) {
	st := openTestStore(t)
	migrateUserCustomRace(t, st)
	ctx := context.Background()
	u1, u2 := uuid.NewString(), uuid.NewString()

	km := 50.0
	ascent := uint32(2000)
	rows := []UserCustomRace{
		{UserID: u1, Name: "莫干山越野", RaceDate: "2032-06-01", ItemType: racetypes.Trail, State: CustomRaceStateWant},
		{UserID: u1, Name: "江南100", RaceDate: "2032-03-15", ItemType: racetypes.Ultra, State: CustomRaceStateRegistered,
			DistanceKm: &km, AscentM: &ascent, City: "湖州", Website: "https://example.com", Note: "备注"},
		{UserID: u2, Name: "别人的赛", RaceDate: "2032-01-01", ItemType: racetypes.Trail, State: CustomRaceStateWant},
	}
	for i := range rows {
		if err := st.CreateUserCustomRace(ctx, &rows[i]); err != nil {
			t.Fatalf("create %s: %v", rows[i].Name, err)
		}
		if rows[i].ID == 0 {
			t.Fatalf("create %s: id not populated", rows[i].Name)
		}
	}
	if rows[0].CreatedAt.IsZero() || rows[0].UpdatedAt.IsZero() {
		t.Error("create did not set timestamps")
	}

	// List is date-ascending, scoped to the one user.
	got, err := st.ListUserCustomRaces(ctx, u1)
	if err != nil {
		t.Fatalf("list u1: %v", err)
	}
	if len(got) != 2 || got[0].Name != "江南100" || got[1].Name != "莫干山越野" {
		t.Fatalf("list u1 = [%s %s], want [江南100 莫干山越野] (date asc)",
			got[0].Name, got[1].Name)
	}

	// Full update: another user's id is not-found; the owner's update replaces
	// every field including clearing optionals.
	foreign := &UserCustomRace{ID: rows[0].ID, Name: "抢走", RaceDate: "2032-02-02",
		ItemType: racetypes.Trail, State: CustomRaceStateWant}
	if _, err := st.UpdateUserCustomRace(ctx, u2, foreign); !errors.Is(err, ErrUserCustomRaceNotFound) {
		t.Errorf("foreign update err = %v, want ErrUserCustomRaceNotFound", err)
	}
	if _, err := st.UpdateUserCustomRace(ctx, u1, &UserCustomRace{ID: 999999,
		Name: "x", RaceDate: "2032-02-02", ItemType: racetypes.Trail, State: CustomRaceStateWant},
	); !errors.Is(err, ErrUserCustomRaceNotFound) {
		t.Errorf("missing-id update err = %v, want ErrUserCustomRaceNotFound", err)
	}
	km2 := 21.0
	updated, err := st.UpdateUserCustomRace(ctx, u1, &UserCustomRace{ID: rows[1].ID,
		Name: "江南改半马", RaceDate: "2032-03-20", ItemType: racetypes.HalfMarathon,
		DistanceKm: &km2, State: CustomRaceStateRegistered,
	})
	if err != nil {
		t.Fatalf("owner update: %v", err)
	}
	if updated.Name != "江南改半马" || updated.RaceDate != "2032-03-20" || updated.ItemType != racetypes.HalfMarathon {
		t.Errorf("updated fields not replaced: %+v", updated)
	}
	if updated.DistanceKm == nil || *updated.DistanceKm != 21 {
		t.Errorf("updated distance = %v, want 21", updated.DistanceKm)
	}
	if updated.AscentM != nil || updated.City != "" || updated.Note != "" || updated.Website != "" {
		t.Errorf("absent optionals not cleared: ascent=%v city=%q note=%q website=%q",
			updated.AscentM, updated.City, updated.Note, updated.Website)
	}
	if !updated.UpdatedAt.After(time.Now().UTC().Add(-time.Minute)) {
		t.Errorf("updated_at not refreshed: %v", updated.UpdatedAt)
	}
	// Compare at second precision: the datetime column rounds sub-second
	// digits on the round-trip.
	if updated.CreatedAt.Unix() != rows[1].CreatedAt.Unix() {
		t.Errorf("created_at changed on update: %v -> %v", rows[1].CreatedAt, updated.CreatedAt)
	}

	// Delete: foreign id not-found, owner ok, second try not-found.
	if err := st.DeleteUserCustomRace(ctx, u2, rows[0].ID); !errors.Is(err, ErrUserCustomRaceNotFound) {
		t.Errorf("foreign delete err = %v, want ErrUserCustomRaceNotFound", err)
	}
	if err := st.DeleteUserCustomRace(ctx, u1, rows[0].ID); err != nil {
		t.Fatalf("owner delete: %v", err)
	}
	if err := st.DeleteUserCustomRace(ctx, u1, rows[0].ID); !errors.Is(err, ErrUserCustomRaceNotFound) {
		t.Errorf("second delete err = %v, want ErrUserCustomRaceNotFound", err)
	}
	if got, _ := st.ListUserCustomRaces(ctx, u1); len(got) != 1 {
		t.Errorf("u1 rows after delete = %d, want 1", len(got))
	}
}

// TestUserCustomRace_NullableOptionals pins NULL round-trip: optionals left
// unset stay NULL on read, not zero.
func TestUserCustomRace_NullableOptionals(t *testing.T) {
	st := openTestStore(t)
	migrateUserCustomRace(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	row := UserCustomRace{UserID: uid, Name: "纯类型赛", RaceDate: "2033-01-01",
		ItemType: racetypes.Trail, State: CustomRaceStateWant}
	if err := st.CreateUserCustomRace(ctx, &row); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := st.ListUserCustomRaces(ctx, uid)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("rows = %d, want 1", len(got))
	}
	if got[0].DistanceKm != nil || got[0].AscentM != nil {
		t.Errorf("optionals not NULL: distance=%v ascent=%v", got[0].DistanceKm, got[0].AscentM)
	}
	if got[0].City != "" || got[0].Website != "" || got[0].Note != "" {
		t.Errorf("defaults not empty strings: %q %q %q", got[0].City, got[0].Website, got[0].Note)
	}
}

// TestIsCustomRaceState pins the two-state vocabulary check.
func TestIsCustomRaceState(t *testing.T) {
	for _, v := range []string{CustomRaceStateWant, CustomRaceStateRegistered} {
		if !IsCustomRaceState(v) {
			t.Errorf("IsCustomRaceState(%q) = false, want true", v)
		}
	}
	for _, v := range []string{"", "won", "lost", "confirmed", "finished", "Want"} {
		if IsCustomRaceState(v) {
			t.Errorf("IsCustomRaceState(%q) = true, want false", v)
		}
	}
}
