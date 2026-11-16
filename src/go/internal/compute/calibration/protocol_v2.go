package calibration

import (
	_ "embed"
	"fmt"
	"time"

	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

//go:embed evaluation-protocol-v2.md
var evaluationProtocolV2 []byte

// EvaluationProtocolV2SHA256 identifies the frozen v2 evaluation protocol
// (#995). The v1 protocol hash in Replay reports is unchanged; v2 scoring
// tooling (T7) must embed this hash instead. A golden copy is locked in
// testdata/evaluation-protocol-v2.sha256.
func EvaluationProtocolV2SHA256() string { return hashBytes(evaluationProtocolV2) }

// replaySplitV2KnownRegression is the extra v2 split bucket for samples the
// v4 v1 phase already used for analysis/tuning/delivery: known regression
// only, never an independent final holdout.
const replaySplitV2KnownRegression = "known_regression"

// ValidateReplayManifestV2 enforces the protocol v2 manifest rules on the v1
// manifest structure with schema_version=2. It deliberately does NOT execute
// the v1 Replay engine: v1 reports stay byte-identical, and v2 scoring is
// owned by the frozen-protocol backtest tooling (#1001).
func ValidateReplayManifestV2(m ReplayManifest) error {
	if ReplayContentHash(m) == "" {
		return fmt.Errorf("manifest contains invalid nonfinite values")
	}
	if m.SchemaVersion != 2 {
		return fmt.Errorf("protocol v2 manifest requires schema_version=2")
	}
	if m.AsOf.IsZero() || m.SourceVersion == "" || len(m.Cases) == 0 {
		return fmt.Errorf("manifest requires as_of, source_version and cases")
	}
	ids := map[string]bool{}
	sourceRoots := map[string]string{}
	rootSplits := map[string]string{}
	bounds := map[string]map[string][2]time.Time{}
	for _, a := range m.Activities {
		if a.ID == "" || a.User == "" || a.RootActivityID == "" || a.EventTime.IsZero() || a.Activity.ActivityDate.IsZero() || a.Activity.LabelID == "" {
			return fmt.Errorf("activity requires id/user/root/event_time/domain date/label")
		}
		if ids[a.ID] {
			return fmt.Errorf("duplicate activity id %s", a.ID)
		}
		ids[a.ID] = true
		switch a.Split {
		case "train", "validation", "final_holdout", replaySplitV2KnownRegression:
		default:
			return fmt.Errorf("unknown v2 split %q", a.Split)
		}
		sourceKey := a.User + "/" + a.Activity.LabelID
		if root, ok := sourceRoots[sourceKey]; ok && root != a.RootActivityID {
			return fmt.Errorf("source activity %s changes root across split", a.ID)
		}
		if _, ok := sourceRoots[sourceKey]; ok {
			return fmt.Errorf("duplicate source activity %s", a.ID)
		}
		sourceRoots[sourceKey] = a.RootActivityID
		key := a.User + "/" + a.RootActivityID
		if split, ok := rootSplits[key]; ok && split != a.Split {
			return fmt.Errorf("activity root %s crosses split", key)
		}
		rootSplits[key] = a.Split
		if ReplayContentHash(a.Activity) != a.ContentSHA256 {
			return fmt.Errorf("activity %s content hash mismatch", a.ID)
		}
		if timefmt.ShanghaiDay(a.EventTime) != a.Activity.ActivityDate {
			return fmt.Errorf("activity %s event/domain civil date mismatch", a.ID)
		}
		if a.AvailableAt != nil && a.AvailableAt.Before(a.EventTime) {
			return fmt.Errorf("activity %s available before event", a.ID)
		}
		if a.Split != replaySplitV2KnownRegression {
			if bounds[a.User] == nil {
				bounds[a.User] = map[string][2]time.Time{}
			}
			b, ok := bounds[a.User][a.Split]
			if !ok {
				b = [2]time.Time{a.EventTime, a.EventTime}
			}
			if a.EventTime.Before(b[0]) {
				b[0] = a.EventTime
			}
			if a.EventTime.After(b[1]) {
				b[1] = a.EventTime
			}
			bounds[a.User][a.Split] = b
		}
	}
	// known_regression must be exactly the v4-v1-used sample set: it never
	// overlaps the prospective splits and is reported separately.
	for user, b := range bounds {
		previous := time.Time{}
		for _, split := range []string{"train", "validation", "final_holdout"} {
			if times, ok := b[split]; ok {
				if !previous.IsZero() && !times[0].After(previous) {
					return fmt.Errorf("user %s split chronology overlaps", user)
				}
				previous = times[1]
			}
		}
	}
	ids = map[string]bool{}
	for _, h := range m.Health {
		if h.ID == "" || h.User == "" || h.EventTime.IsZero() || h.Row.Date.IsZero() || ids[h.ID] {
			return fmt.Errorf("health metadata missing or duplicate id")
		}
		ids[h.ID] = true
		if ReplayContentHash(h.Row) != h.ContentSHA256 {
			return fmt.Errorf("health %s content hash mismatch", h.ID)
		}
		if h.AvailableAt != nil && h.AvailableAt.Before(h.EventTime) {
			return fmt.Errorf("health %s available before event", h.ID)
		}
	}
	ids = map[string]bool{}
	for _, c := range m.Cases {
		if c.ID == "" || c.User == "" || c.PredictionAsOf.IsZero() || c.PredictionAsOf.After(m.AsOf) || ids[c.ID] {
			return fmt.Errorf("case metadata missing, duplicate or prediction after report as_of")
		}
		ids[c.ID] = true
		if c.Mode != "strict" && c.Mode != "event_date_retrospective" {
			return fmt.Errorf("unknown replay mode %q", c.Mode)
		}
		if c.TargetRootActivityID != "" {
			key := c.User + "/" + c.TargetRootActivityID
			split, ok := rootSplits[key]
			if !ok {
				return fmt.Errorf("case %s target missing", c.ID)
			}
			if split != "final_holdout" {
				return fmt.Errorf("case %s target must be final_holdout, got %s", c.ID, split)
			}
		}
	}
	return nil
}
