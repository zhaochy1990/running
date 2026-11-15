package compute

import (
	"context"
	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/storage"
	"testing"
	"time"
)

func TestDailyPMCSeedLineageUsesOriginalRead(t *testing.T) {
	ctx := context.Background()
	original := &storage.DailyTrainingLoad{UserID: testUser, Date: "2026-11-01", AcuteLoad: 10, ChronicLoad: 20}
	f := &fakeStore{prior: original}
	start, _ := time.Parse("2006-01-02", "2026-11-03")
	prior, err := priorLoadState(ctx, f, testUser, start)
	if err != nil {
		t.Fatal(err)
	}
	// Another compute publishes a different preceding row while computeDaily runs.
	newer := &storage.DailyTrainingLoad{UserID: testUser, Date: "2026-11-02", AcuteLoad: 100, ChronicLoad: 200}
	if err := storage.FreezeCalibrationProvenance(newer, nil, nil); err != nil {
		t.Fatal(err)
	}
	f.prior = newer
	daily := []trainingload.DailyLoadResult{{Date: start, AcuteLoad: 9, ChronicLoad: 19}}
	if err := persistDailyLoad(ctx, f, testUser, nil, daily, start, prior); err != nil {
		t.Fatal(err)
	}
	p, state := storage.ReadCalibrationProvenance(f.dailyRows[0])
	if state != "available" {
		t.Fatal(state)
	}
	if f.priorReads != 1 {
		t.Fatalf("seed was re-read %d times", f.priorReads)
	}
	if p.Seed.Date != original.Date || p.Seed.State != "legacy_seed_lineage_unavailable" || p.Seed.AcuteLoad != 10 || p.Seed.ChronicLoad != 20 {
		t.Fatalf("actual seed was date=%s acute=10 chronic=20 legacy; frozen seed = %+v", original.Date, p.Seed)
	}
}

func TestDailyPMCSeedSnapshotDoesNotAliasMutableHistory(t *testing.T) {
	ctx := context.Background()
	original := &storage.DailyTrainingLoad{UserID: testUser, Date: "2026-11-01", AcuteLoad: 10, ChronicLoad: 20}
	if err := storage.FreezeCalibrationProvenance(original, nil, nil); err != nil {
		t.Fatal(err)
	}
	originalProvenance, state := storage.ReadCalibrationProvenance(*original)
	if state != "available" {
		t.Fatal(state)
	}
	f := &fakeStore{prior: original}
	start, _ := time.Parse("2006-01-02", "2026-11-03")
	prior, err := priorLoadState(ctx, f, testUser, start)
	if err != nil {
		t.Fatal(err)
	}
	expectedSeed := prior.seed
	// Simulate another publisher mutating the original object and its lineage.
	original.Date = "2026-11-02"
	original.AcuteLoad = 100
	original.ChronicLoad = 200
	if err := storage.FreezeCalibrationProvenance(original, nil, nil); err != nil {
		t.Fatal(err)
	}
	daily := []trainingload.DailyLoadResult{{Date: start, AcuteLoad: 9, ChronicLoad: 19}, {Date: start.AddDate(0, 0, 1), AcuteLoad: 8, ChronicLoad: 18}}
	if err := persistDailyLoad(ctx, f, testUser, nil, daily, start, prior); err != nil {
		t.Fatal(err)
	}
	p, state := storage.ReadCalibrationProvenance(f.dailyRows[0])
	if state != "available" {
		t.Fatal(state)
	}
	if f.priorReads != 1 || p.Seed.Date != "2026-11-01" || p.Seed.AcuteLoad != 10 || p.Seed.ChronicLoad != 20 || p.Seed.ProvenanceDigest != originalProvenance.OutputDigest || p.Seed.State != "frozen_seed" {
		t.Fatalf("mutable prior source leaked into lineage %+v", p.Seed)
	}
	if prior.seed != expectedSeed || prior.values().AcuteLoad != 10 || prior.values().ChronicLoad != 20 {
		t.Fatal("writing the daily chain mutated the original frozen seed")
	}
	second, state := storage.ReadCalibrationProvenance(f.dailyRows[1])
	if state != "available" || second.Seed.Date != "2026-11-03" || second.Seed.AcuteLoad != 9 || second.Seed.ChronicLoad != 19 || second.Seed.ProvenanceDigest != p.OutputDigest {
		t.Fatalf("subsequent day did not chain actual previous output %+v", second.Seed)
	}
}
