package calibration

// zones.go ports running_calibration/zones.py: training zones derived from a
// snapshot's threshold speed / HR (with an HRR fallback).

// PaceZone mirrors types.PaceZone.
type PaceZone struct {
	Name          string
	MinPaceSPerKm *float64
	MaxPaceSPerKm *float64
	MinSpeedMps   *float64
	MaxSpeedMps   *float64
	Confidence    Confidence
}

// HeartRateZone mirrors types.HeartRateZone.
type HeartRateZone struct {
	Name       string
	MinBpm     *float64
	MaxBpm     *float64
	Confidence Confidence
}

// ZoneSet mirrors types.RunningZoneSet (sans as_of/snapshot id, added at persist).
type ZoneSet struct {
	PaceZones      []PaceZone
	HeartRateZones []HeartRateZone
}

var zoneNames = []string{"recovery", "easy", "marathon", "threshold", "interval", "repetition"}

type ratio struct{ low, high *float64 }

func rp(v float64) *float64 { return &v }

var paceZoneSpeedRatios = map[string]ratio{
	"recovery":   {nil, rp(0.72)},
	"easy":       {rp(0.72), rp(0.84)},
	"marathon":   {rp(0.84), rp(0.97)},
	"threshold":  {rp(0.97), rp(1.03)},
	"interval":   {rp(1.03), rp(1.11)},
	"repetition": {rp(1.11), nil},
}

var hrZoneRatios = map[string]ratio{
	"recovery":   {nil, rp(0.80)},
	"easy":       {rp(0.80), rp(0.88)},
	"marathon":   {rp(0.88), rp(0.94)},
	"threshold":  {rp(0.94), rp(1.01)},
	"interval":   {rp(1.01), rp(1.06)},
	"repetition": {rp(1.06), nil},
}

var hrrRanges = map[string][2]float64{
	"recovery":   {0.55, 0.65},
	"easy":       {0.65, 0.75},
	"marathon":   {0.75, 0.82},
	"threshold":  {0.82, 0.88},
	"interval":   {0.88, 0.94},
	"repetition": {0.94, 1.0},
}

func paceSPerKm(speedMps *float64) *float64 {
	if speedMps == nil || *speedMps <= 0 {
		return nil
	}
	v := 1000.0 / *speedMps
	return &v
}

// ComputeTrainingZones mirrors zones.compute_training_zones.
func ComputeTrainingZones(snap Snapshot) ZoneSet {
	var pace []PaceZone
	if snap.ThresholdSpeedMps != nil && *snap.ThresholdSpeedMps > 0 {
		threshold := *snap.ThresholdSpeedMps
		for _, name := range zoneNames {
			r := paceZoneSpeedRatios[name]
			var lowSpeed, highSpeed *float64
			if r.low != nil {
				v := threshold * *r.low
				lowSpeed = &v
			}
			if r.high != nil {
				v := threshold * *r.high
				highSpeed = &v
			}
			pace = append(pace, PaceZone{
				Name:          name,
				MinPaceSPerKm: paceSPerKm(highSpeed),
				MaxPaceSPerKm: paceSPerKm(lowSpeed),
				MinSpeedMps:   lowSpeed,
				MaxSpeedMps:   highSpeed,
				Confidence:    snap.ThresholdSpeedConfidence,
			})
		}
	}

	var hr []HeartRateZone
	switch {
	case snap.ThresholdHR != nil && *snap.ThresholdHR > 0:
		thr := *snap.ThresholdHR
		for _, name := range zoneNames {
			r := hrZoneRatios[name]
			var minBpm, maxBpm *float64
			if r.low != nil {
				v := thr * *r.low
				minBpm = &v
			}
			if r.high != nil {
				v := thr * *r.high
				maxBpm = &v
			}
			hr = append(hr, HeartRateZone{Name: name, MinBpm: minBpm, MaxBpm: maxBpm, Confidence: snap.ThresholdHRConfidence})
		}
	case snap.RHRBaseline != nil && snap.HRMaxEstimate != nil:
		rhr := *snap.RHRBaseline
		hrmax := *snap.HRMaxEstimate
		if hrmax > rhr {
			for _, name := range zoneNames {
				rg := hrrRanges[name]
				minBpm := rhr + (hrmax-rhr)*rg[0]
				maxBpm := rhr + (hrmax-rhr)*rg[1]
				hr = append(hr, HeartRateZone{Name: name, MinBpm: &minBpm, MaxBpm: &maxBpm, Confidence: ConfidenceLow})
			}
		}
	}

	return ZoneSet{PaceZones: pace, HeartRateZones: hr}
}
