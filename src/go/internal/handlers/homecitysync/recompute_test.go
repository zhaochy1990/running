// recompute_test.go exercises the homecity_recompute loop against a fake
// store: the per-user skip-on-failure semantics, the persisted/unknown counts,
// and the city-change count fed by the storage layer's change reasons.
package homecitysync

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/homecity"
	"github.com/zhaochy1990/stride/internal/storage"
)

type fakeStore struct {
	users   []string
	signals map[string][]storage.ActivityStartSignal
	putErr  map[string]error

	putCalls map[string]int
	lastPut  map[string]homecity.Result
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		signals:  map[string][]storage.ActivityStartSignal{},
		putErr:   map[string]error{},
		putCalls: map[string]int{},
		lastPut:  map[string]homecity.Result{},
	}
}

func (f *fakeStore) ListActivityUserIDs(_ context.Context) ([]string, error) {
	return f.users, nil
}

func (f *fakeStore) ListActivityStartSignals(_ context.Context, userID string) ([]storage.ActivityStartSignal, error) {
	if signals, ok := f.signals[userID]; ok {
		return signals, nil
	}
	return nil, errors.New("load failed")
}

func (f *fakeStore) PutUserHomeCity(_ context.Context, userID string, res homecity.Result, _ time.Time) (storage.HomeCityChangeReason, error) {
	f.putCalls[userID]++
	f.lastPut[userID] = res
	if err := f.putErr[userID]; err != nil {
		return "", err
	}
	if res.City != "" {
		// First write for a user with a city reads as a change ("new"); the
		// real storage layer derives this from the prior row.
		if f.putCalls[userID] == 1 {
			return storage.HomeCityChangeNew, nil
		}
		return "", nil
	}
	return "", nil
}

func TestRecomputeAll_PersistsPerUserAndCounts(t *testing.T) {
	store := newFakeStore()
	name := "上海市 跑步"
	lat, lon := 31.15, 121.12
	store.users = []string{"user-sh", "user-empty", "user-load-fails"}
	store.signals["user-sh"] = []storage.ActivityStartSignal{
		{Name: &name, StartGPSLat: &lat, StartGPSLon: &lon, Date: time.Now().UTC().Add(-48 * time.Hour)},
		{Name: &name, StartGPSLat: &lat, StartGPSLon: &lon, Date: time.Now().UTC().Add(-72 * time.Hour)},
		{Name: &name, StartGPSLat: &lat, StartGPSLon: &lon, Date: time.Now().UTC().Add(-96 * time.Hour)},
	}
	store.signals["user-empty"] = nil

	summary, err := RecomputeAll(context.Background(), store, nil)
	if err != nil {
		t.Fatalf("recompute: %v", err)
	}
	if summary.Users != 3 || summary.Persisted != 2 || summary.Skipped != 1 {
		t.Fatalf("summary = %+v, want users=3 persisted=2 skipped=1", summary)
	}
	// user-sh: first detection with a city -> one change; user-empty: first
	// detection without a city -> unknown, no change row.
	if summary.CityChanges != 1 || summary.Unknown != 1 {
		t.Fatalf("summary = %+v, want city_changes=1 unknown=1", summary)
	}
	if store.lastPut["user-sh"].City != "上海市" {
		t.Fatalf("persisted city = %q, want 上海市", store.lastPut["user-sh"].City)
	}
	if store.lastPut["user-empty"].City != "" {
		t.Fatalf("empty user should persist an unknown result, got %+v", store.lastPut["user-empty"])
	}
}

func TestRecomputeAll_PutFailureSkipsUser(t *testing.T) {
	store := newFakeStore()
	name := "上海市 跑步"
	store.users = []string{"user-sh"}
	store.signals["user-sh"] = []storage.ActivityStartSignal{
		{Name: &name, Date: time.Now().UTC().Add(-24 * time.Hour)},
		{Name: &name, Date: time.Now().UTC().Add(-48 * time.Hour)},
		{Name: &name, Date: time.Now().UTC().Add(-72 * time.Hour)},
	}
	store.putErr["user-sh"] = errors.New("db down")

	summary, err := RecomputeAll(context.Background(), store, nil)
	if err != nil {
		t.Fatalf("a per-user put failure must not fail the run: %v", err)
	}
	if summary.Skipped != 1 || summary.Persisted != 0 {
		t.Fatalf("summary = %+v, want skipped=1 persisted=0", summary)
	}
}

// TestRecomputeAll_ListFailureFailsRun pins the one fatal path: without a user
// list there is no run.
func TestRecomputeAll_ListFailureFailsRun(t *testing.T) {
	_, err := RecomputeAll(context.Background(), &brokenListStore{}, nil)
	if err == nil || !strings.Contains(err.Error(), "list users") {
		t.Fatalf("expected list-users failure to fail the run, got %v", err)
	}
}

type brokenListStore struct{}

func (brokenListStore) ListActivityUserIDs(_ context.Context) ([]string, error) {
	return nil, errors.New("boom")
}
func (b brokenListStore) ListActivityStartSignals(_ context.Context, _ string) ([]storage.ActivityStartSignal, error) {
	return nil, nil
}
func (b brokenListStore) PutUserHomeCity(_ context.Context, _ string, _ homecity.Result, _ time.Time) (storage.HomeCityChangeReason, error) {
	return "", nil
}
