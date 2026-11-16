package compute

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

func TestCanonicalReadinessRestSourceMySQL(t *testing.T) {
	ctx, st := openCalibrationReviewMySQL(t)
	uid := uuid.NewString()
	defer func() {
		if err := st.DeleteUserData(ctx, uid); err != nil {
			t.Error(err)
		}
	}()
	today := timefmt.ShanghaiToday()
	past := today.AddDate(0, 0, -1)
	for i := 21; i >= 0; i-- {
		rhr := 40
		if i <= 1 {
			rhr = 55
		}
		if err := st.UpsertDailyHealth(ctx, &storage.DailyHealth{UserID: uid, Provider: "coros", Date: today.AddDate(0, 0, -i).Format("20060102"), RHR: &rhr}); err != nil {
			t.Fatal(err)
		}
	}
	for _, day := range []time.Time{past, today} {
		baseline := 50.
		if day.Equal(past) {
			baseline = 49
		}
		if _, err := st.PublishRunningCalibration(ctx, &storage.RunningCalibrationSnapshot{UserID: uid, AsOfDate: day.Format("2006-01-02"), AlgorithmVersion: 3, RHRBaseline: &baseline}, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	prior := storage.DailyTrainingLoad{UserID: uid, Date: past.AddDate(0, 0, -1).Format("2006-01-02"), AlgorithmVersion: 2, CoverageStatus: "complete", AcuteLoad: 70, ChronicLoad: 50}
	if err := storage.FreezeCalibrationProvenance(&prior, nil, nil); err != nil {
		t.Fatal(err)
	}
	seed, _ := storage.ReadCalibrationProvenance(prior)
	if err := st.ReplaceDailyTrainingLoad(ctx, uid, []storage.DailyTrainingLoad{prior}); err != nil {
		t.Fatal(err)
	}
	if _, err := NewCompute(st)(ctx, testCalibrationJob(uid, `{"mode":"incremental","health_dates":["`+past.Format("20060102")+`"]}`), testCalibrationHeartbeat); err != nil {
		t.Fatal(err)
	}
	rows, err := st.DailyTrainingLoadSeries(ctx, uid, 2)
	if err != nil || len(rows) != 2 {
		t.Fatal("missing rest rows", err)
	}
	for _, r := range rows {
		p, state := storage.ReadCalibrationProvenance(r)
		if state != "available" || len(p.Inputs) != 1 || r.ReadinessGate == nil || *r.ReadinessGate != "yellow" {
			t.Fatalf("rest source/gate mismatch %+v %s", r, state)
		}
		b, e := st.ReadEffectiveRunningCalibration(ctx, uid, r.Date, storage.CalibrationActive)
		if e != nil || b.Fingerprint != p.Inputs[0].Fingerprint || p.Inputs[0].AsOfDate != r.Date || p.Inputs[0].ValuesUsed.RHRBaseline == nil {
			t.Fatal("wrong as-of RHR source", e)
		}
		if r.Date == past.Format("2006-01-02") && (p.Seed == nil || p.Seed.ProvenanceDigest != seed.OutputDigest || p.Seed.AcuteLoad != 70) {
			t.Fatalf("wrong actual seed: got %+v expected digest %s", p.Seed, seed.OutputDigest)
		}
		if r.Date == today.Format("2006-01-02") && (p.Seed == nil || p.Seed.Date != past.Format("2006-01-02") || p.Seed.State != "frozen_seed") {
			t.Fatal("daily seed chain lost")
		}
	}
	// Rewriting today's mutable snapshot cannot change the frozen rest baseline.
	if _, err := st.PublishRunningCalibration(ctx, &storage.RunningCalibrationSnapshot{UserID: uid, AsOfDate: today.Format("2006-01-02"), AlgorithmVersion: 3, RHRBaseline: floatPtr(20)}, nil, nil); err != nil {
		t.Fatal(err)
	}
	again, err := st.DailyTrainingLoadSeries(ctx, uid, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range again {
		p, state := storage.ReadCalibrationProvenance(r)
		if state != "available" || *p.Inputs[0].ValuesUsed.RHRBaseline < 49 {
			t.Fatal("mutable snapshot changed actual readiness source")
		}
	}
	// An old writer that retains an unknown provenance column cannot certify a
	// changed readiness output with the old digest.
	changed := again[0]
	for _, row := range again {
		if row.Date == today.Format("2006-01-02") {
			changed = row
		}
	}
	green := "green"
	changed.ReadinessGate = &green
	if err := st.ReplaceDailyTrainingLoad(ctx, uid, []storage.DailyTrainingLoad{changed}); err != nil {
		t.Fatal(err)
	}
	after, err := st.DailyTrainingLoadSeries(ctx, uid, 1)
	if err != nil || len(after) != 1 {
		t.Fatal(err)
	}
	if _, state := storage.ReadCalibrationProvenance(after[0]); state != "legacy_or_stale_provenance" {
		t.Fatal("old writer falsely kept source", state)
	}
	t.Log("canonical day RHR beats local health P10 on two rest days; actual seed and same-ID frozen source verified; old writer detected")
}

func TestStaleHRProducerPersistsRejectedReasonAndDateMySQL(t *testing.T) {
	ctx, st := openCalibrationReviewMySQL(t)
	uid := uuid.NewString()
	defer func() {
		if err := st.DeleteUserData(ctx, uid); err != nil {
			t.Error(err)
		}
	}()
	today := timefmt.ShanghaiToday()
	old := today.AddDate(0, 0, -61)
	dur, dist := 1800., 7200.
	a := calibration.Activity{LabelID: "synthetic-old-protocol", ActivityDate: old, Sport: "run", DurationS: &dur, DistanceM: &dist}
	for i := 0; i <= 1800; i += 5 {
		sec, d := float64(i), float64(i)*4
		a.Samples = append(a.Samples, calibration.Sample{ElapsedS: &sec, DistanceM: &d, SpeedMps: floatPtr(4), HeartRateBpm: floatPtr(165)})
	}
	m := calibration.CandidateMetadata{ActivityID: a.LabelID, SourceVersion: "SYNTHETIC-protocol-v1", EvidenceRef: "SYNTHETIC-not-accuracy", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: 1800, StartS: floatPtr(0), EndS: floatPtr(1800), HR: &calibration.CandidateHRMetadata{Protocol: "field_30min_last20_v1", Verified: true, Sensor: "chest_strap"}}
	result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, today, nil, []calibration.CandidateMetadata{m})
	if err != nil {
		t.Fatal(err)
	}
	source := calibration.SummarizeSource(result)
	raw, _ := json.Marshal(source)
	text := string(raw)
	row := toStorageSnapshot(uid, result.Snapshot)
	row.SourceJSON = &text
	if _, err := st.PublishRunningCalibration(ctx, row, nil, nil); err != nil {
		t.Fatal(err)
	}
	b, err := st.ReadEffectiveRunningCalibration(ctx, uid, today.Format("2006-01-02"), storage.CalibrationCandidate)
	if err != nil || b.Snapshot == nil || b.Snapshot.ThresholdHR != nil || b.Source.HR.Support != "none" || b.Source.HR.EvidenceCount != 0 || b.Source.HR.EvidenceDate != "" || b.Source.HR.LatestRejectedEvidenceDate != old.Format("2006-01-02") || !strings.Contains(strings.Join(b.Source.HR.RejectedReasons, ","), "stale_HR_support") {
		t.Fatalf("persisted stale protocol revived/lost %+v %v", b.Source.HR, err)
	}
	// A recent quality rejection must not overwrite the older stale date.
	recent := a
	recent.LabelID = "synthetic-recent-quality-rejection"
	recent.ActivityDate = today.AddDate(0, 0, -1)
	recent.Samples = append([]calibration.Sample(nil), a.Samples...)
	for i := range recent.Samples {
		if *recent.Samples[i].ElapsedS == 900 {
			recent.Samples[i].HeartRateBpm = floatPtr(220)
		}
	}
	recentMetadata := m
	recentMetadata.ActivityID = recent.LabelID
	mixed, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a, recent}, today, nil, []calibration.CandidateMetadata{m, recentMetadata})
	if err != nil {
		t.Fatal(err)
	}
	mixedSource := calibration.SummarizeSource(mixed)
	raw, _ = json.Marshal(mixedSource)
	text = string(raw)
	row = toStorageSnapshot(uid, mixed.Snapshot)
	row.SourceJSON = &text
	if _, err := st.PublishRunningCalibration(ctx, row, nil, nil); err != nil {
		t.Fatal(err)
	}
	b, err = st.ReadEffectiveRunningCalibration(ctx, uid, today.Format("2006-01-02"), storage.CalibrationCandidate)
	if err != nil || b.Snapshot == nil || b.Source.HR == nil || b.Snapshot.ThresholdHR != nil || b.Source.HR.Support != "none" || b.Source.HR.EvidenceCount != 0 || b.Source.HR.EvidenceDate != "" || b.Source.HR.LatestStaleEvidenceDate != old.Format("2006-01-02") || b.Source.HR.LatestRejectedEvidenceDate != recent.ActivityDate.Format("2006-01-02") || !strings.Contains(strings.Join(b.Source.HR.RejectedReasons, ","), "HR_abrupt_spike_or_recovery") {
		t.Fatalf("mixed persisted rejection date conflated: %+v %v", b.Source.HR, err)
	}
	t.Log("actual synthetic producer -> Publish -> real MySQL active-policy candidate reader retains stale reason/rejected date, without HR center/support")
}

func testCalibrationJob(user, input string) *job.Job { return &job.Job{UserID: user, InputJSON: input} }
func testCalibrationHeartbeat(string, int) error     { return nil }

func TestCurrentHRAndRejectedProtocolSourcesPersistSeparatelyMySQL(t *testing.T) {
	ctx, st := openCalibrationReviewMySQL(t)
	uid := uuid.NewString()
	defer func() {
		if err := st.DeleteUserData(ctx, uid); err != nil {
			t.Error(err)
		}
	}()
	day := timefmt.ShanghaiToday()
	for _, kind := range []string{"stale", "quality"} {
		var acts []calibration.Activity
		var metadata []calibration.CandidateMetadata
		for i := 0; i < 2; i++ {
			id := "synthetic-valid-current"
			date := day.AddDate(0, 0, -1)
			if i == 1 {
				id = "synthetic-rejected"
				date = day.AddDate(0, 0, -61)
				if kind == "quality" {
					date = day
				}
			}
			duration := 1800.
			a := calibration.Activity{LabelID: id, ActivityDate: date, Sport: "run", DurationS: &duration}
			for sec := 0; sec <= 1800; sec += 5 {
				clock := float64(sec)
				hr := 170.
				if i == 1 && kind == "quality" && sec == 900 {
					hr = 220
				}
				a.Samples = append(a.Samples, calibration.Sample{ElapsedS: &clock, HeartRateBpm: &hr})
			}
			acts = append(acts, a)
			metadata = append(metadata, calibration.CandidateMetadata{ActivityID: id, RootActivityID: id, SourceVersion: "SYNTHETIC-current-rejection-v1", EvidenceRef: "SYNTHETIC-not-accuracy", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: 1800, StartS: floatPtr(0), EndS: floatPtr(1800), HR: &calibration.CandidateHRMetadata{Protocol: "field_30min_last20_v1", Verified: true, Sensor: "chest_strap"}})
		}
		result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, acts, day, nil, metadata)
		if err != nil {
			t.Fatal(err)
		}
		source := calibration.SummarizeSource(result)
		raw, _ := json.Marshal(source)
		text := string(raw)
		row := toStorageSnapshot(uid, result.Snapshot)
		row.SourceJSON = &text
		if _, err := st.PublishRunningCalibration(ctx, row, nil, nil); err != nil {
			t.Fatal(err)
		}
		b, err := st.ReadEffectiveRunningCalibration(ctx, uid, day.Format("2006-01-02"), storage.CalibrationCandidate)
		if err != nil || b.Snapshot == nil || b.Snapshot.ThresholdHR == nil || *b.Snapshot.ThresholdHR != 170 || b.Source.HR == nil || b.Source.HR.Support != "low" || b.Source.HR.EvidenceDate != day.AddDate(0, 0, -1).Format("2006-01-02") || b.Source.HR.EvidenceCount != 1 {
			t.Fatalf("current HR source changed: %+v %v", b.Source.HR, err)
		}
		code := "stale_HR_support"
		if kind == "quality" {
			code = "HR_abrupt_spike_or_recovery"
		}
		if strings.Contains(strings.Join(b.Source.HR.Reasons, ","), code) || !strings.Contains(strings.Join(b.Source.HR.RejectedReasons, ","), code) {
			t.Fatalf("rejection scope contaminated current: %+v", b.Source.HR)
		}
	}
	t.Log("current170/low/selected date preserved; old stale and quality rejection persist only as rejected_reasons")
}
