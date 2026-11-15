package calibration

import "math"

// OfflineRacePrediction is a read-only algebraic projection of an already fitted
// snapshot. It never fits against the requested race's outcome.
type OfflineRacePrediction struct {
	State     string   `json:"state"`
	Reason    string   `json:"reason,omitempty"`
	DurationS *float64 `json:"duration_s"`
	Model     string   `json:"model"`
}

func PredictOfflineRaceTime(snapshot Snapshot, distanceM float64) OfflineRacePrediction {
	out := OfflineRacePrediction{Model: "snapshot_v60_k_power_law_180_7200_v1"}
	switch {
	case !finiteScalar(distanceM) || distanceM <= 0:
		out.State, out.Reason = "failed", "invalid_distance"
	case snapshot.ThresholdSpeedMps == nil || snapshot.RiegelK == nil:
		out.State, out.Reason = "missing", "snapshot_v60_or_identified_k_missing"
	case !candidateFinite(snapshot.ThresholdSpeedMps) || *snapshot.ThresholdSpeedMps <= 0 || !candidateFinite(snapshot.RiegelK) || *snapshot.RiegelK < riegelKMin || *snapshot.RiegelK > riegelKMax:
		out.State, out.Reason = "failed", "invalid_snapshot_v60_or_k"
	default:
		seconds := 3600 * math.Exp(math.Log(distanceM/(3600**snapshot.ThresholdSpeedMps))/(1-*snapshot.RiegelK))
		switch {
		case !finiteScalar(seconds):
			out.State, out.Reason = "failed", "nonfinite_prediction"
		// Compare the distance bounds, avoiding inverse roundoff at exact endpoints.
		case distanceM < 3600**snapshot.ThresholdSpeedMps*math.Pow(180.0/3600, 1-*snapshot.RiegelK) || distanceM > 3600**snapshot.ThresholdSpeedMps*math.Pow(2, 1-*snapshot.RiegelK):
			out.State, out.Reason = "unsupported", "predicted_duration_outside_180_7200s"
		default:
			out.State = "available"
			out.DurationS = &seconds
		}
	}
	return out
}

func finiteScalar(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
