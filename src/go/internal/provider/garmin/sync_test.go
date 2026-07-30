package garmin

import (
	"context"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

func TestSyncUser_Activities(t *testing.T) {
	p, fw := newTestProvider(t, garminMux(), loggedInCreds())

	res, err := p.SyncUser(context.Background(), testUID, provider.SyncOptions{
		Mode: provider.SyncIncremental, Content: provider.ContentActivities,
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Activities != 2 {
		t.Errorf("activities = %d, want 2", res.Activities)
	}
	if res.Health != 0 {
		t.Errorf("health = %d, want 0 (activities-only)", res.Health)
	}
	if len(fw.activities) != 2 {
		t.Errorf("stored activities = %d, want 2", len(fw.activities))
	}
	a := fw.activities["1001"]
	if a == nil {
		t.Fatal("activity 1001 not stored")
	}
	if a.Provider != "garmin" || a.SportType != 8001 {
		t.Errorf("activity meta = provider %q sportType %d", a.Provider, a.SportType)
	}
	if fw.meta["last_label_id"] == "" {
		t.Errorf("sync cursor not set")
	}
}

func TestSyncUser_IncrementalStop(t *testing.T) {
	p, fw := newTestProvider(t, garminMux(), loggedInCreds())
	// Seed the newest activity as already-synced → incremental scan stops at once.
	fw.activities["1001"] = &storage.Activity{LabelID: "1001"}

	res, err := p.SyncUser(context.Background(), testUID, provider.SyncOptions{
		Mode: provider.SyncIncremental, Content: provider.ContentActivities,
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Activities != 0 {
		t.Errorf("activities = %d, want 0 (stop at known 1001)", res.Activities)
	}
}

func TestSyncUser_Health(t *testing.T) {
	p, fw := newTestProvider(t, garminMux(), loggedInCreds())

	res, err := p.SyncUser(context.Background(), testUID, provider.SyncOptions{
		Mode: provider.SyncIncremental, Content: provider.ContentHealth,
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	// 28 daily_health + 28 daily_hrv + 1 dashboard.
	if res.Health != healthWindowDays*2+1 {
		t.Errorf("health writes = %d, want %d", res.Health, healthWindowDays*2+1)
	}
	if len(fw.health) != healthWindowDays {
		t.Errorf("daily_health rows = %d, want %d", len(fw.health), healthWindowDays)
	}
	if len(fw.hrv) != healthWindowDays {
		t.Errorf("daily_hrv rows = %d, want %d", len(fw.hrv), healthWindowDays)
	}
	if fw.dashboards != 1 {
		t.Errorf("dashboards = %d, want 1", fw.dashboards)
	}
	if fw.races != 2 {
		t.Errorf("race predictions = %d, want 2 (5K,10K)", fw.races)
	}
	// spot-check a stored daily_health row is garmin-tagged with garmin signals
	for _, h := range fw.health {
		if h.Provider != "garmin" {
			t.Errorf("health provider = %q, want garmin", h.Provider)
		}
		if h.BodyBatteryHigh == nil || *h.BodyBatteryHigh != 90 {
			t.Errorf("body battery = %v, want 90", h.BodyBatteryHigh)
		}
		break
	}
}

func TestSyncUser_HealthFullWindow(t *testing.T) {
	p, fw := newTestProvider(t, garminMux(), loggedInCreds())

	// Full mode is the DEPTH axis for health too: it walks the deep 365-day
	// window instead of the 28-day incremental window. The mock returns signal
	// for every date, so the consecutive-empty cutoff never trips.
	res, err := p.SyncUser(context.Background(), testUID, provider.SyncOptions{
		Mode: provider.SyncFull, Content: provider.ContentHealth,
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(fw.health) != healthWindowDaysFull {
		t.Errorf("daily_health rows = %d, want %d (full window)", len(fw.health), healthWindowDaysFull)
	}
	if len(fw.hrv) != healthWindowDaysFull {
		t.Errorf("daily_hrv rows = %d, want %d (full window)", len(fw.hrv), healthWindowDaysFull)
	}
	// healthWindowDaysFull daily_health + healthWindowDaysFull daily_hrv + 1 dashboard.
	if res.Health != healthWindowDaysFull*2+1 {
		t.Errorf("health writes = %d, want %d", res.Health, healthWindowDaysFull*2+1)
	}
}

func TestInfoCapabilities(t *testing.T) {
	p, _ := newTestProvider(t, garminMux(), loggedInCreds())
	info := p.Info()
	if info.Name != "garmin" {
		t.Errorf("name = %q", info.Name)
	}
	for _, cap := range []provider.Capability{provider.CapSyncHRVDetail, provider.CapSyncSleep, provider.CapSyncBodyBattery} {
		if !info.Capabilities.Has(cap) {
			t.Errorf("missing capability %q", cap)
		}
	}
}

func TestSyncUser_EmitsProgress(t *testing.T) {
	p, _ := newTestProvider(t, garminMux(), loggedInCreds())

	var events []provider.SyncProgress
	_, err := p.SyncUser(context.Background(), testUID, provider.SyncOptions{
		Mode: provider.SyncFull, Content: provider.ContentActivities,
		Progress: func(pr provider.SyncProgress) { events = append(events, pr) },
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	sawFinal := false
	maxPct := -1
	for _, e := range events {
		if e["phase"] == "activities" && e["current"] == 2 && e["total"] == 2 {
			sawFinal = true
		}
		if pct, ok := e["percent"].(int); ok && pct > maxPct {
			maxPct = pct
		}
	}
	if !sawFinal {
		t.Errorf("missing activities current=2/total=2 event; got %v", events)
	}
	if maxPct < 80 {
		t.Errorf("max percent = %d, want >= 80", maxPct)
	}
}
