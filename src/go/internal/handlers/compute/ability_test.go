package compute

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/ability"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

// fakeAbilityStore records what the ability handler writes so tests can assert
// per-activity L1 persistence without a database.
type fakeAbilityStore struct {
	acts      []storage.Activity
	snap      *storage.RunningCalibrationSnapshot
	pbs       []storage.PersonalBest
	upserts   map[string]storage.ActivityAbility
	snapRows  []storage.AbilitySnapshot
	snapCalls int
	vo2Writes int
}

func newFakeAbilityStore(t *testing.T) *fakeAbilityStore {
	t.Helper()
	return &fakeAbilityStore{upserts: map[string]storage.ActivityAbility{}}
}

func (f *fakeAbilityStore) ActivitiesInWindow(_ context.Context, _, _ string, _, _ time.Time) ([]storage.Activity, error) {
	return f.acts, nil
}

func (f *fakeAbilityStore) ActivityTimeseries(_ context.Context, _, _ string) ([]storage.TimeseriesPoint, error) {
	return nil, nil
}

func (f *fakeAbilityStore) ActivityLaps(_ context.Context, _, _ string) ([]storage.Lap, error) {
	return nil, nil
}

func (f *fakeAbilityStore) AllDailyHealth(_ context.Context, _ string) ([]storage.DailyHealth, error) {
	return nil, nil
}

func (f *fakeAbilityStore) DashboardSnapshot(_ context.Context, _ string) (*storage.Dashboard, error) {
	return nil, nil
}

func (f *fakeAbilityStore) BestVo2MaxPBs(_ context.Context, _ string) ([]storage.Vo2MaxPB, error) {
	return nil, nil
}

func (f *fakeAbilityStore) LatestRunningCalibrationSnapshot(_ context.Context, _ string) (*storage.RunningCalibrationSnapshot, error) {
	return f.snap, nil
}

func (f *fakeAbilityStore) PersonalBests(_ context.Context, _ string) ([]storage.PersonalBest, error) {
	return f.pbs, nil
}

func (f *fakeAbilityStore) ReplaceAbilitySnapshot(_ context.Context, _ string, rows []storage.AbilitySnapshot) error {
	f.snapCalls++
	f.snapRows = rows
	return nil
}

func (f *fakeAbilityStore) UpsertActivityAbility(_ context.Context, _ string, row *storage.ActivityAbility) error {
	f.upserts[row.LabelID] = *row
	return nil
}

func (f *fakeAbilityStore) UpsertVo2MaxPB(_ context.Context, _ string, _ *storage.Vo2MaxPB) error {
	f.vo2Writes++
	return nil
}

func (f *fakeAbilityStore) AllRunningActivities(_ context.Context, _ string) ([]storage.Activity, error) {
	return f.acts, nil
}

func (f *fakeAbilityStore) ActivityAbilityLabelIDs(_ context.Context, _ string) (map[string]bool, error) {
	out := make(map[string]bool, len(f.upserts))
	for id := range f.upserts {
		out[id] = true
	}
	return out, nil
}

// abilityFixtures builds one athlete's 2026-10-20 sync: two real runs on the
// same day (10:36 warm-up + 10:47 workout), one ultra-short stroll, and one run
// from the previous day — mirroring the production gap in stride-devops#678.
func abilityFixtures(user, refDate string) ([]storage.Activity, string) {
	day, err := time.Parse("2006-01-02", refDate)
	if err != nil {
		panic(err)
	}
	run := func(label string, at time.Time, distM, durS float64) storage.Activity {
		return storage.Activity{
			UserID: user, LabelID: label, SportType: 100,
			Date: at, DistanceM: &distM, DurationS: &durS,
		}
	}
	acts := []storage.Activity{
		run("newest", day.Add(10*time.Hour+47*time.Minute), 11420, 4002),
		run("warmup", day.Add(10*time.Hour+36*time.Minute), 2000, 780),
		run("short", day.Add(9*time.Hour), 310, 120),
		run("otherday", day.Add(-15*time.Hour), 5000, 1800),
	}
	return acts, refDate
}

const abilityTestUser = "11111111-1111-1111-1111-111111111111"

func runAbilityJob(t *testing.T, store *fakeAbilityStore, input string) abilityResult {
	t.Helper()
	h := NewAbility(store)
	out, err := h(context.Background(), &job.Job{UserID: abilityTestUser, InputJSON: input}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("ability handler: %v", err)
	}
	var res abilityResult
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("result not JSON: %v (%s)", err, out)
	}
	return res
}

func hrMaxSnapshot() *storage.RunningCalibrationSnapshot {
	hr := 184.0
	return &storage.RunningCalibrationSnapshot{HRMaxEstimate: &hr}
}

// The same sync batch's two runs must BOTH get an activity_ability row — the
// pre-fix behaviour persisted only the newest one.
func TestAbility_PersistsL1ForEachBatchActivity(t *testing.T) {
	store := newFakeAbilityStore(t)
	store.snap = hrMaxSnapshot()
	acts, refDate := abilityFixtures(abilityTestUser, "2026-10-20")
	store.acts = acts

	res := runAbilityJob(t, store, `{"mode":"full","ref_date":"`+refDate+`","label_ids":["newest","warmup"]}`)

	if res.L1Written != 2 || res.L1Skipped != 0 {
		t.Fatalf("result = %+v, want l1_written=2 l1_skipped=0", res)
	}
	for _, label := range []string{"newest", "warmup"} {
		row, ok := store.upserts[label]
		if !ok {
			t.Fatalf("label %s has no activity_ability row; got %v", label, keys(store.upserts))
		}
		if row.L1Quality == nil {
			t.Fatalf("label %s row has no L1 quality", label)
		}
	}
	if _, ok := store.upserts["otherday"]; ok {
		t.Fatal("out-of-batch activity must not get a row")
	}
}

// Ultra-short activities (under 1.5 km AND 10 min) get no row, and the skip is
// counted in the result.
func TestAbility_SkipsUltraShortActivities(t *testing.T) {
	store := newFakeAbilityStore(t)
	store.snap = hrMaxSnapshot()
	acts, refDate := abilityFixtures(abilityTestUser, "2026-10-20")
	store.acts = acts

	res := runAbilityJob(t, store, `{"mode":"full","ref_date":"`+refDate+`","label_ids":["newest","short"]}`)

	if res.L1Written != 1 || res.L1Skipped != 1 {
		t.Fatalf("result = %+v, want l1_written=1 l1_skipped=1", res)
	}
	if _, ok := store.upserts["short"]; ok {
		t.Fatal("ultra-short activity must not get a row")
	}
	if _, ok := store.upserts["newest"]; !ok {
		t.Fatal("normal activity must still get a row")
	}
}

// Without label_ids the batch falls back to the anchor day's activities.
func TestAbility_FallsBackToAnchorDay(t *testing.T) {
	store := newFakeAbilityStore(t)
	store.snap = hrMaxSnapshot()
	acts, refDate := abilityFixtures(abilityTestUser, "2026-10-20")
	store.acts = acts

	res := runAbilityJob(t, store, `{"mode":"full","ref_date":"`+refDate+`"}`)

	// Anchor day: newest + warmup written, short skipped; otherday is not on the
	// anchor day so it is neither written nor counted.
	if res.L1Written != 2 || res.L1Skipped != 1 {
		t.Fatalf("result = %+v, want l1_written=2 l1_skipped=1", res)
	}
	if _, ok := store.upserts["otherday"]; ok {
		t.Fatal("previous-day activity must not be written by the anchor-day fallback")
	}
}

// The snapshot math must be untouched: L3 six dimensions + L4 composite rows
// are still persisted alongside the per-activity L1 rows.
func TestAbility_SnapshotRowsUnchanged(t *testing.T) {
	store := newFakeAbilityStore(t)
	store.snap = hrMaxSnapshot()
	acts, refDate := abilityFixtures(abilityTestUser, "2026-10-20")
	store.acts = acts

	runAbilityJob(t, store, `{"mode":"full","ref_date":"`+refDate+`"}`)

	dims := map[string]bool{}
	hasL4, hasMeta := false, false
	for _, r := range store.snapRows {
		switch r.Level {
		case "L3":
			dims[r.Dimension] = true
		case "L4":
			if r.Dimension == "composite" {
				hasL4 = true
			}
		case "meta":
			if r.Dimension == "model_version" {
				hasMeta = true
			}
		}
	}
	for _, want := range []string{"aerobic", "lt", "vo2max", "endurance", "economy", "recovery"} {
		if !dims[want] {
			t.Fatalf("missing L3 dimension %s in %+v", want, store.snapRows)
		}
	}
	if !hasL4 || !hasMeta {
		t.Fatalf("missing L4 composite (%v) or meta model_version (%v)", hasL4, hasMeta)
	}
}

// backfill_l1 fills missing rows over the whole history, skips activities that
// already have one and ultra-short ones, and does not touch the snapshot.
func TestAbility_BackfillL1FillsMissingRows(t *testing.T) {
	store := newFakeAbilityStore(t)
	store.snap = hrMaxSnapshot()
	acts, _ := abilityFixtures(abilityTestUser, "2026-10-20")
	store.acts = acts
	// newest already has its row from a prior run.
	hr := 90.0
	store.upserts["newest"] = storage.ActivityAbility{LabelID: "newest", L1Quality: &hr}

	res := runAbilityJob(t, store, `{"mode":"backfill_l1"}`)

	if res.L1Written != 2 || res.L1Skipped != 1 {
		t.Fatalf("result = %+v, want l1_written=2 l1_skipped=1", res)
	}
	for _, label := range []string{"warmup", "otherday"} {
		if _, ok := store.upserts[label]; !ok {
			t.Fatalf("label %s should have been backfilled; got %v", label, keys(store.upserts))
		}
	}
	if _, ok := store.upserts["short"]; ok {
		t.Fatal("ultra-short activity must stay without a row")
	}
	if store.snapCalls != 0 {
		t.Fatalf("backfill_l1 must not rewrite snapshots, got %d calls", store.snapCalls)
	}
}

func keys(m map[string]storage.ActivityAbility) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// The gate itself: AND semantics over the reference samples from the issue.
func TestIsUltraShort(t *testing.T) {
	cases := []struct {
		distM, durS float64
		want        bool
	}{
		{310, 120, true},   // 0.31 km / 2 min — skip
		{940, 360, true},   // 0.94 km / 6 min — skip
		{1030, 360, true},  // 1.03 km / 6 min — skip
		{2000, 780, false}, // 2 km / 13 min warm-up — keep
		{1500, 100, false}, // long enough distance — keep
		{100, 900, false},  // long enough duration — keep
	}
	for _, c := range cases {
		if got := ability.IsUltraShort(c.distM, c.durS); got != c.want {
			t.Fatalf("IsUltraShort(%v, %v) = %v, want %v", c.distM, c.durS, got, c.want)
		}
	}
}
