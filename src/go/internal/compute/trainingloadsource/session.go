package trainingloadsource

import (
	"strings"

	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/storage"
)

// sportFromRow mirrors training_load/adapter._sport_from_row (distinct from the
// calibration connector: 104 -> run_treadmill, strength types 800/402).
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

// legacyTrainTypeMap mirrors normalize._LEGACY_TRAIN_TYPE_MAP (uppercased keys ->
// TrainKind value strings).
var legacyTrainTypeMap = map[string]string{
	"BASE": "base", "AEROBIC_BASE": "base", "AEROBIC": "aerobic",
	"AEROBIC_ENDURANCE": "aerobic", "TEMPO": "tempo", "THRESHOLD": "threshold",
	"LACTATE_THRESHOLD": "threshold", "INTERVAL": "interval", "VO2MAX": "vo2max",
	"VO2_MAX": "vo2max", "ANAEROBIC": "anaerobic", "ANAEROBIC_CAPACITY": "anaerobic",
	"SPRINT": "sprint", "RECOVERY": "recovery", "LONG_RUN": "long_run", "RACE": "race",
}

func kindFromLegacyTrainType(raw *string) string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return ""
	}
	key := strings.ReplaceAll(strings.ToUpper(strings.TrimSpace(*raw)), " ", "_")
	return legacyTrainTypeMap[key]
}

// SessionClass mirrors training_load/adapter._session_class_from_row: prefer the
// train_kind label, else the legacy train_type mapping, else a sport fallback.
func SessionClass(a storage.Activity) trainingload.SessionClass {
	sport := sportFromRow(a.Sport, a.SportType)
	var key string
	if a.TrainKind != nil {
		key = strings.ToLower(strings.TrimSpace(*a.TrainKind))
	} else if k := kindFromLegacyTrainType(a.TrainType); k != "" {
		key = strings.ToLower(k)
	}
	switch key {
	case "base", "aerobic", "recovery":
		return trainingload.SessionEasy
	case "long_run":
		return trainingload.SessionLong
	case "threshold", "tempo":
		return trainingload.SessionTempo
	case "interval", "vo2max", "anaerobic", "sprint":
		return trainingload.SessionInterval
	case "race":
		return trainingload.SessionRace
	case "strength":
		return trainingload.SessionStrength
	case "mobility", "yoga":
		return trainingload.SessionMobility
	}
	if sport == "strength" {
		return trainingload.SessionStrength
	}
	if strings.HasPrefix(sport, "run") {
		return trainingload.SessionEasy
	}
	return trainingload.SessionUnknown
}
