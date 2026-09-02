package storage

import (
	"context"
	"errors"
	"testing"

	"gorm.io/gorm"
)

func TestValidateBodyCompositionScan(t *testing.T) {
	valid := &BodyCompositionScanRecord{
		ScanDate: "2026-08-15", WeightKg: 70.5, BodyFatPct: 21.0,
		SmmKg: 31.5, FatMassKg: 14.8, VisceralFatLevel: 8,
	}
	if err := validateBodyCompositionScan(valid); err != nil {
		t.Fatalf("valid scan rejected: %v", err)
	}

	invalid := []struct {
		name string
		mut  func(*BodyCompositionScanRecord)
	}{
		{"bad date", func(s *BodyCompositionScanRecord) { s.ScanDate = "08/15/2026" }},
		{"weight too low", func(s *BodyCompositionScanRecord) { s.WeightKg = 25 }},
		{"weight too high", func(s *BodyCompositionScanRecord) { s.WeightKg = 160 }},
		{"bf too low", func(s *BodyCompositionScanRecord) { s.BodyFatPct = 2 }},
		{"bf too high", func(s *BodyCompositionScanRecord) { s.BodyFatPct = 60 }},
		{"smm too low", func(s *BodyCompositionScanRecord) { s.SmmKg = 5 }},
		{"smm too high", func(s *BodyCompositionScanRecord) { s.SmmKg = 80 }},
		{"fat negative", func(s *BodyCompositionScanRecord) { s.FatMassKg = -1 }},
		{"visceral 0", func(s *BodyCompositionScanRecord) { s.VisceralFatLevel = 0 }},
		{"visceral 21", func(s *BodyCompositionScanRecord) { s.VisceralFatLevel = 21 }},
	}
	for _, tc := range invalid {
		t.Run(tc.name, func(t *testing.T) {
			s := *valid
			tc.mut(&s)
			err := validateBodyCompositionScan(&s)
			if err == nil {
				t.Fatal("validation unexpectedly succeeded")
			}
			var vErr *BodyCompositionValidationError
			if !errors.As(err, &vErr) {
				t.Fatalf("error type = %T, want *BodyCompositionValidationError", err)
			}
		})
	}
}

func TestValidateBodyCompositionSegments(t *testing.T) {
	valid := []BodyCompositionSegmentRecord{
		{Segment: SegLeftArm, LeanMassKg: 2.5, FatMassKg: 1.2},
		{Segment: SegRightArm, LeanMassKg: 2.6, FatMassKg: 1.3},
		{Segment: SegTrunk, LeanMassKg: 18.0, FatMassKg: 8.0},
		{Segment: SegLeftLeg, LeanMassKg: 8.0, FatMassKg: 3.5},
		{Segment: SegRightLeg, LeanMassKg: 8.1, FatMassKg: 3.6},
	}
	if err := validateBodyCompositionSegments(valid); err != nil {
		t.Fatalf("valid segments rejected: %v", err)
	}

	t.Run("empty ok", func(t *testing.T) {
		if err := validateBodyCompositionSegments(nil); err != nil {
			t.Fatalf("nil rejected: %v", err)
		}
		if err := validateBodyCompositionSegments([]BodyCompositionSegmentRecord{}); err != nil {
			t.Fatalf("empty rejected: %v", err)
		}
	})

	t.Run("wrong count", func(t *testing.T) {
		if err := validateBodyCompositionSegments(valid[:3]); err == nil {
			t.Fatal("3 segments unexpectedly accepted")
		}
	})

	t.Run("bad segment name", func(t *testing.T) {
		bad := append([]BodyCompositionSegmentRecord(nil), valid...)
		bad[0].Segment = "head"
		if err := validateBodyCompositionSegments(bad); err == nil {
			t.Fatal("bad segment name unexpectedly accepted")
		}
	})

	t.Run("duplicate segment", func(t *testing.T) {
		bad := append([]BodyCompositionSegmentRecord(nil), valid...)
		bad[1].Segment = SegLeftArm
		if err := validateBodyCompositionSegments(bad); err == nil {
			t.Fatal("duplicate segment unexpectedly accepted")
		}
	})

	t.Run("lean out of range", func(t *testing.T) {
		bad := append([]BodyCompositionSegmentRecord(nil), valid...)
		bad[0].LeanMassKg = 50
		if err := validateBodyCompositionSegments(bad); err == nil {
			t.Fatal("lean out of range unexpectedly accepted")
		}
	})
}

func TestBodyCompositionUpsertAndRead(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	userID := "11111111-1111-4111-8111-111111111111"

	// Clean up any test rows from previous runs
	t.Cleanup(func() {
		_ = st.db.Where("user_id = ?", userID).Delete(&BodyCompositionScanRecord{}).Error
	})

	// Create scan with segments
	scan := &BodyCompositionScanRecord{
		ScanDate: "2026-08-15", WeightKg: 70.5, BodyFatPct: 21.0,
		SmmKg: 31.5, FatMassKg: 14.8, VisceralFatLevel: 8,
		BmrKcal: intPtr(1600), InbodyScore: intPtr(75),
		Segments: []BodyCompositionSegmentRecord{
			{Segment: SegLeftArm, LeanMassKg: 2.5, FatMassKg: 1.2},
			{Segment: SegRightArm, LeanMassKg: 2.6, FatMassKg: 1.3},
			{Segment: SegTrunk, LeanMassKg: 18.0, FatMassKg: 8.0},
			{Segment: SegLeftLeg, LeanMassKg: 8.0, FatMassKg: 3.5},
			{Segment: SegRightLeg, LeanMassKg: 8.1, FatMassKg: 3.6},
		},
	}

	created, err := st.UpsertBodyCompositionScan(ctx, userID, scan)
	if err != nil {
		t.Fatalf("upsert create: %v", err)
	}
	if created.ID == "" {
		t.Fatal("id not generated")
	}
	if len(created.Segments) != 5 {
		t.Fatalf("segments count = %d, want 5", len(created.Segments))
	}

	// Idempotent: upsert same date again = update
	scan.WeightKg = 69.5
	updated, err := st.UpsertBodyCompositionScan(ctx, userID, scan)
	if err != nil {
		t.Fatalf("upsert update: %v", err)
	}
	if updated.ID != created.ID {
		t.Fatalf("id changed on upsert: %s vs %s", updated.ID, created.ID)
	}
	if updated.WeightKg != 69.5 {
		t.Fatalf("weight not updated: %v", updated.WeightKg)
	}

	// Get by date
	got, err := st.GetBodyCompositionScan(ctx, userID, "2026-08-15")
	if err != nil {
		t.Fatalf("get by date: %v", err)
	}
	if got.WeightKg != 69.5 {
		t.Fatalf("weight = %v, want 69.5", got.WeightKg)
	}
	if len(got.Segments) != 5 {
		t.Fatalf("segments count = %d", len(got.Segments))
	}

	// Get not found
	_, err = st.GetBodyCompositionScan(ctx, userID, "2020-01-01")
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("not found err = %v, want ErrRecordNotFound", err)
	}

	// Latest
	latest, err := st.LatestBodyCompositionScan(ctx, userID)
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	if latest.ScanDate != "2026-08-15" {
		t.Fatalf("latest date = %s", latest.ScanDate)
	}

	// Add a second (older) scan
	older := &BodyCompositionScanRecord{
		ScanDate: "2026-08-01", WeightKg: 71.0, BodyFatPct: 21.5,
		SmmKg: 31.2, FatMassKg: 15.3, VisceralFatLevel: 9,
	}
	if _, err := st.UpsertBodyCompositionScan(ctx, userID, older); err != nil {
		t.Fatalf("upsert older: %v", err)
	}

	// List (newest first)
	scans, err := st.ListBodyCompositionScans(ctx, userID, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(scans) != 2 {
		t.Fatalf("list count = %d, want 2", len(scans))
	}
	if scans[0].ScanDate != "2026-08-15" || scans[1].ScanDate != "2026-08-01" {
		t.Fatalf("list order wrong: %s, %s", scans[0].ScanDate, scans[1].ScanDate)
	}

	// Previous scan
	prev, err := st.PreviousBodyCompositionScan(ctx, userID, "2026-08-15")
	if err != nil {
		t.Fatalf("previous: %v", err)
	}
	if prev.ScanDate != "2026-08-01" {
		t.Fatalf("previous date = %s, want 2026-08-01", prev.ScanDate)
	}

	// HasBodyComposition
	has, err := st.HasBodyComposition(ctx, userID)
	if err != nil {
		t.Fatalf("has: %v", err)
	}
	if !has {
		t.Fatal("HasBodyComposition = false, want true")
	}
	has2, err := st.HasBodyComposition(ctx, "00000000-0000-4000-8000-000000000000")
	if err != nil {
		t.Fatalf("has empty: %v", err)
	}
	if has2 {
		t.Fatal("HasBodyComposition for empty user = true, want false")
	}
}

func intPtr(v int) *int { return &v }
