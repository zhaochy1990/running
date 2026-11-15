package calibration

import (
	"encoding/hex"
	"fmt"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
	"time"
)

// FrozenRaceReplayTarget contains only an independently frozen race outcome.
// It carries no fitting metadata or HR estimate; support is copied unchanged
// from the hash-bound serialized outcome by the collection loader.
type FrozenRaceReplayTarget struct {
	CaseID         string    `json:"case_id"`
	StorageUserID  string    `json:"user_id"`
	StorageLabelID string    `json:"label_id"`
	User           string    `json:"user"`
	RootActivityID string    `json:"root_activity_id"`
	EventAt        time.Time `json:"event_at"`
	DistanceM      float64   `json:"distance_m"`
	DurationS      float64   `json:"duration_s"`
	EffortSupport  string    `json:"effort_support"`
}

// FrozenRaceReplayView builds a new versioned evaluation view, preserving the
// immutable base artifact. observedAt proves only that the independent outcome
// was observed before this report, never historical first availability.
func FrozenRaceReplayView(base ReplayManifest, target FrozenRaceReplayTarget, reportAsOf, observedAt time.Time, outcomeSHA256 string) (ReplayManifest, error) {
	rawHash, hashErr := hex.DecodeString(outcomeSHA256)
	if hashErr != nil || len(rawHash) != 32 || len(base.Cases) != 1 || target.CaseID == "" || target.RootActivityID == "" || target.EventAt.IsZero() || reportAsOf.IsZero() || observedAt.IsZero() || observedAt.After(reportAsOf) || observedAt.Before(target.EventAt) || !target.EventAt.After(base.Cases[0].PredictionAsOf) || !finiteScalar(target.DistanceM) || target.DistanceM <= 0 || !finiteScalar(target.DurationS) || target.DurationS <= 0 {
		return ReplayManifest{}, fmt.Errorf("invalid frozen race view identity, time or outcome")
	}
	day := timefmt.ShanghaiDay(target.EventAt)
	expectedCutoff := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, timefmt.Shanghai).Add(-time.Second)
	if !base.Cases[0].PredictionAsOf.Equal(expectedCutoff) {
		return ReplayManifest{}, fmt.Errorf("frozen race cutoff must be preceding Shanghai day 23:59:59")
	}
	if target.StorageUserID == "" || target.StorageLabelID == "" || target.RootActivityID != hashBytes([]byte(target.StorageUserID+"/"+target.StorageLabelID)) {
		return ReplayManifest{}, fmt.Errorf("frozen target canonical source identity mismatch")
	}
	c := base.Cases[0]
	if c.ID != target.CaseID || c.User != target.User || c.TargetRootActivityID != target.RootActivityID || c.Mode != "event_date_retrospective" || target.EffortSupport != "probable_maximal" && target.EffortSupport != "confirmed_maximal" {
		return ReplayManifest{}, fmt.Errorf("frozen outcome does not match base target/mode/support")
	}
	for _, a := range base.Activities {
		if a.User != target.User || a.Split != "train" || a.Reference != nil || a.RootActivityID == target.RootActivityID || a.Activity.LabelID == target.StorageLabelID || a.RootActivityID != hashBytes([]byte(target.StorageUserID+"/"+a.Activity.LabelID)) {
			return ReplayManifest{}, fmt.Errorf("base replay must contain only this user's outcome-free train inputs")
		}
	}
	view := base
	view.BaseManifestSHA256 = ReplayContentHash(base)
	view.OutcomeSHA256 = outcomeSHA256
	view.AsOf = reportAsOf
	view.SourceVersion = base.SourceVersion + ";evaluation-view=independent-race-v1"
	view.Activities = append([]ReplayActivity(nil), base.Activities...)
	distance, duration := target.DistanceM, target.DurationS
	activity := Activity{LabelID: target.StorageLabelID, ActivityDate: timefmt.ShanghaiDay(target.EventAt), Sport: "run", DurationS: &duration, DistanceM: &distance}
	outcome := ReplayActivity{ID: "outcome:" + target.CaseID, User: target.User, RootActivityID: target.RootActivityID, Split: "final_holdout", EventTime: target.EventAt, AvailableAt: &observedAt, AvailabilityEvidence: "observed_in_frozen_export_not_historical_first_available", Activity: activity, Reference: &ReplayReference{Kind: "race_prediction", Real: true, EffortSupport: target.EffortSupport, MeasurementQuality: "not_recorded", EvidenceRef: "sha256:" + outcomeSHA256 + "#" + target.CaseID, Protocol: "independent_race_timing_v1", AvailableAt: &observedAt, DurationS: duration, DistanceM: distance}}
	outcome.ContentSHA256 = ReplayContentHash(activity)
	view.Activities = append(view.Activities, outcome)
	if err := validateReplay(view, "frozen-view"); err != nil {
		return ReplayManifest{}, err
	}
	return view, nil
}
