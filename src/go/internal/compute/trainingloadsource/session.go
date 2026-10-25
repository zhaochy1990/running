package trainingloadsource

import (
	"context"
	"strings"

	"github.com/zhaochy1990/stride/internal/compute/sessionclass"
	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/storage"
)

// SessionClass keeps the legacy enum contract while delegating running
// classification to the evidence-based sessionclass pipeline (devops #743).
// Without calibration/laps/race evidence (nil) the classifier degrades to the
// name + TE + vendor-label rules; production callers pass evidence via Load.
func SessionClass(a storage.Activity) trainingload.SessionClass {
	return SessionClassWithEvidence(context.Background(), nil, a)
}

// SessionClassWithEvidence classifies one row with the evidence bundle Load
// prepared for the window (zones, threshold HR, races, laps).
func SessionClassWithEvidence(ctx context.Context, ev *evidence, a storage.Activity) trainingload.SessionClass {
	sport := sportFromRow(a.Sport, a.SportType)
	if !isRunningSport(sport) {
		return legacyNonRunClass(a)
	}
	return sessionClassFromResult(classifyActivity(ctx, ev, a))
}

func classifyActivity(ctx context.Context, ev *evidence, a storage.Activity) sessionclass.Result {
	var zones *sessionclass.Zones
	var thrHr, hrmax *float64
	var laps []storage.Lap
	raceLinked := false
	if ev != nil {
		zones = ev.zones
		thrHr, hrmax = ev.thresholdHR, ev.hrmaxEstimate
		raceLinked = ev.races[a.LabelID]
		laps = ev.lapsFor(ctx, a.LabelID)
	}
	return sessionclass.Classify(sessionclass.FromStorage(a, laps, zones, thrHr, hrmax, raceLinked))
}

// sessionClassFromResult stores the classifier's own class verbatim (devops
// #745 enum upgrade): quality subtypes no longer split into tempo/interval —
// subtype never lands in storage, and TS consumers normalise the legacy
// values that pre-upgrade rows still carry.
func sessionClassFromResult(r sessionclass.Result) trainingload.SessionClass {
	switch r.Class {
	case sessionclass.ClassRace:
		return trainingload.SessionRace
	case sessionclass.ClassLongEasy:
		return trainingload.SessionLongEasy
	case sessionclass.ClassEasy:
		return trainingload.SessionEasy
	case sessionclass.ClassQuality:
		return trainingload.SessionQuality
	case sessionclass.ClassLongQuality:
		return trainingload.SessionLongQuality
	case sessionclass.ClassStrides:
		return trainingload.SessionStrides
	}
	return trainingload.SessionUnknown
}

// legacyNonRunClass preserves the pre-#743 behaviour for non-running rows.
func legacyNonRunClass(a storage.Activity) trainingload.SessionClass {
	kind := ""
	if a.TrainKind != nil {
		kind = strings.ToLower(strings.TrimSpace(*a.TrainKind))
	} else if a.TrainType != nil {
		key := strings.ReplaceAll(strings.ToUpper(strings.TrimSpace(*a.TrainType)), " ", "_")
		switch key {
		case "BASE", "AEROBIC_BASE", "AEROBIC", "AEROBIC_ENDURANCE":
			kind = "base"
		case "TEMPO":
			kind = "tempo"
		case "THRESHOLD", "LACTATE_THRESHOLD":
			kind = "threshold"
		case "INTERVAL":
			kind = "interval"
		case "VO2MAX", "VO2_MAX":
			kind = "vo2max"
		case "ANAEROBIC", "ANAEROBIC_CAPACITY":
			kind = "anaerobic"
		case "SPRINT":
			kind = "sprint"
		case "RECOVERY":
			kind = "recovery"
		case "LONG_RUN":
			kind = "long_run"
		case "RACE":
			kind = "race"
		}
	}
	switch kind {
	case "strength":
		return trainingload.SessionStrength
	case "mobility", "yoga":
		return trainingload.SessionMobility
	}
	if sportFromRow(a.Sport, a.SportType) == "strength" {
		return trainingload.SessionStrength
	}
	return trainingload.SessionUnknown
}

func isRunningSport(sport string) bool {
	return strings.HasPrefix(sport, "run")
}
func sportFromRow(sport *string, sportType int) string {
	if sport != nil {
		if s := strings.TrimSpace(*sport); s != "" {
			return s
		}
	}
	switch sportType {
	case 100, 8001:
		return "run_outdoor"
	case 101, 8002, 8003:
		return "run_indoor"
	case 102, 8005:
		return "run_trail"
	case 103, 8004:
		return "run_track"
	case 104:
		return "run_treadmill"
	case 800, 402:
		return "strength"
	}
	return "unknown"
}
