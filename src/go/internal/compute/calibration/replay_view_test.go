package calibration_test

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"testing"
	"time"
)

func TestFrozenRaceViewPreservesOriginalUnknownInputsAndProbableSupport(t *testing.T) {
	base := replayFixture(t)
	base.Cases[0].Mode = "event_date_retrospective"
	base.Cases[0].PredictionAsOf = time.Date(2026, 11, 10, 15, 59, 59, 0, time.UTC)
	uid, label := "synthetic-storage-user", "synthetic-target-label"
	rootDigest := sha256.Sum256([]byte(uid + "/" + label))
	root := hex.EncodeToString(rootDigest[:])
	trainDigest := sha256.Sum256([]byte(uid + "/" + base.Activities[0].Activity.LabelID))
	base.Activities[0].RootActivityID = hex.EncodeToString(trainDigest[:])
	base.Activities[0].ID = base.Activities[0].RootActivityID
	base.Cases[0].TargetRootActivityID = root
	base.Activities[0].AvailableAt = nil
	base.Activities[0].AvailabilityEvidence = ""
	original := calibration.ReplayContentHash(base)
	event := base.Cases[0].PredictionAsOf.Add(time.Hour)
	observed := event.Add(time.Hour)
	target := calibration.FrozenRaceReplayTarget{CaseID: base.Cases[0].ID, User: base.Cases[0].User, RootActivityID: root, StorageUserID: uid, StorageLabelID: label, EventAt: event, DistanceM: 10000, DurationS: 2400, EffortSupport: "probable_maximal"}
	view, err := calibration.FrozenRaceReplayView(base, target, base.AsOf, observed, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	if calibration.ReplayContentHash(base) != original || view.BaseManifestSHA256 != original || view.Activities[0].AvailableAt != nil || view.Cases[0].Mode != "event_date_retrospective" {
		t.Fatal("base or historical proof changed")
	}
	ref := view.Activities[1].Reference
	if ref.EffortSupport != "probable_maximal" || ref.Kind != "race_prediction" || ref.MeasurementQuality != "not_recorded" || ref.AvailableAt == nil || !ref.AvailableAt.Equal(observed) {
		t.Fatal("frozen label upgraded or unknown historical availability fabricated")
	}
	report, err := calibration.Replay(view, "fixed-code")
	if err != nil {
		t.Fatal(err)
	}
	if report.BaseManifestSHA256 != original || report.ManifestSHA256 == original || report.Evaluation.EligibleActivities != 0 {
		t.Fatal("base/view/mode provenance lost")
	}
	poisoned := base
	poisoned.Activities = append([]calibration.ReplayActivity(nil), base.Activities...)
	poisoned.Activities[0].RootActivityID = "wrong-root"
	if _, err := calibration.FrozenRaceReplayView(poisoned, target, base.AsOf, observed, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"); err == nil {
		t.Fatal("forged source root accepted")
	}
	wrongCutoff := base
	wrongCutoff.Cases = append([]calibration.ReplayCase(nil), base.Cases...)
	wrongCutoff.Cases[0].PredictionAsOf = base.Cases[0].PredictionAsOf.Add(-time.Hour)
	if _, err := calibration.FrozenRaceReplayView(wrongCutoff, target, base.AsOf, observed, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"); err == nil {
		t.Fatal("nonfrozen prior-Shanghai-day cutoff accepted")
	}
	target.RootActivityID = "train"
	if _, err := calibration.FrozenRaceReplayView(base, target, base.AsOf, observed, "hash"); err == nil {
		t.Fatal("target mismatch accepted")
	}
}
