// Package zones ports stride_core/activity_zones.py: per-activity time-in-zone
// computed from STRIDE calibration zone boundaries (the same zones the Training
// Status page shows). We classify each timeseries sample into a STRIDE pace zone
// and HR zone and accumulate the dwell time, so the activity page's zones match
// the Training Status page's zones and never depend on a provider's (churning)
// zone encoding.
//
// Pure compute: no DB access. The post-sync compute job loads samples and the
// calibration snapshot, then persists the rows (ADR 0019: calibrated zones live
// separately from activity_watch_zones).
package zones

import (
	"math"
	"sort"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

// zoneIndex mirrors activity_zones.ZONE_INDEX: physiological order → 1-based
// index, matching the watch's zone numbering and the fixed Z1..Z6 labels the
// frontend renders by position.
var zoneIndex = map[string]int{
	"recovery":   1,
	"easy":       2,
	"marathon":   3,
	"threshold":  4,
	"interval":   5,
	"repetition": 6,
}

// Sample is one timeseries point reduced to what zone classification needs,
// mirroring activity_zones.ZoneSample.
type Sample struct {
	DwellS   float64
	SpeedMps *float64
	HRBpm    *float64
}

// Zone is one `zones`-table row (without the user/label stamp, which the
// persisting caller adds). Mirrors stride_core.models.Zone.
type Zone struct {
	ZoneType  string // "pace" | "heartRate"
	ZoneIndex int
	RangeMin  *float64
	RangeMax  *float64
	RangeUnit *string // "pace" | "bpm"
	DurationS *int
	Percent   *float64
}

// DwellSeconds mirrors activity_zones.dwell_seconds: per-sample dwell from
// elapsed seconds, aligned 1:1 to the input. Each sample's dwell is the gap to
// the next sample. The returned slice always has the same length as elapsed so
// callers can zip it straight back onto the samples — samples with a missing
// timestamp or a non-increasing gap get the median cadence rather than being
// dropped or mispaired. Gaps far larger than the typical cadence (device paused
// / signal dropout) are clamped to the median so a stop doesn't dump minutes
// into whatever zone preceded it; the final sample inherits the median.
func DwellSeconds(elapsed []*float64) []float64 {
	n := len(elapsed)
	if n == 0 {
		return nil
	}
	deltas := make([]float64, 0, n-1)
	for i := 0; i+1 < n; i++ {
		a, b := elapsed[i], elapsed[i+1]
		if a != nil && b != nil && *b > *a {
			deltas = append(deltas, *b-*a)
		}
	}
	if len(deltas) == 0 {
		out := make([]float64, n)
		for i := range out {
			out[i] = 1.0
		}
		return out
	}
	sort.Float64s(deltas)
	median := deltas[len(deltas)/2]
	if median <= 0 {
		median = 1.0
	}
	cap := median * 5
	out := make([]float64, n)
	for i := range out {
		a := elapsed[i]
		var b *float64
		if i+1 < n {
			b = elapsed[i+1]
		}
		if a != nil && b != nil && *a < *b && *b <= *a+cap {
			out[i] = *b - *a
		} else {
			out[i] = median
		}
	}
	return out
}

// paceZoneForSpeed finds the zone containing speed_mps. Zone bounds are speeds:
// min_speed_mps (slow edge) .. max_speed_mps (fast edge); nil = open. Contiguous
// half-open [min, max) so each speed lands in exactly one zone.
func paceZoneForSpeed(speedMps float64, zoneList []calibration.PaceZone) *calibration.PaceZone {
	for i := range zoneList {
		z := &zoneList[i]
		lo, hi := z.MinSpeedMps, z.MaxSpeedMps
		if (lo == nil || speedMps >= *lo) && (hi == nil || speedMps < *hi) {
			return z
		}
	}
	return nil
}

func hrZoneForBpm(hrBpm float64, zoneList []calibration.HeartRateZone) *calibration.HeartRateZone {
	for i := range zoneList {
		z := &zoneList[i]
		lo, hi := z.MinBpm, z.MaxBpm
		if (lo == nil || hrBpm >= *lo) && (hi == nil || hrBpm < *hi) {
			return z
		}
	}
	return nil
}

// paceMsPerKm converts a seconds-per-km pace bound to the frontend's
// milliseconds-per-km (the zones table stores ms/km; the frontend divides by
// 1000). Mirror of activity_zones._pace_ms_per_km.
func paceMsPerKm(sPerKm *float64) *float64 {
	if sPerKm == nil {
		return nil
	}
	v := math.Round(*sPerKm * 1000)
	return &v
}

func roundBpm(v *float64) *float64 {
	if v == nil {
		return nil
	}
	r := math.Round(*v)
	return &r
}

func roundInt(v float64) int {
	return int(math.Round(v))
}

func sptr(s string) *string { return &s }

// percentOf is round(100*seconds/total, 1) with total <= 0 → 0, mirroring
// activity_zones (pace percents and HR percents each sum to ~100 independently).
func percentOf(seconds, total float64) float64 {
	if total <= 0 {
		return 0.0
	}
	return math.Round(100*seconds/total*10) / 10
}

// ComputeActivityTimeInZone mirrors activity_zones.compute_activity_time_in_zone:
// builds `zones`-table rows from samples + STRIDE zone boundaries. Emits every
// defined zone (0-duration ones included) so the activity card shows the full
// ladder. Percent is each zone's share of the metric's total classified dwell, so
// pace percents and HR percents each sum to ~100 independently (a treadmill run
// with no GPS yields HR rows only).
//
// Rows are emitted in the input zone-list order; the calibration job passes
// ComputeTrainingZones' output, which iterates zoneNames in physiological order
// (recovery → repetition), so the resulting ladder is already ordered by
// zone_index without an explicit re-sort.
func ComputeActivityTimeInZone(samples []Sample, paceZoneList []calibration.PaceZone, hrZoneList []calibration.HeartRateZone) []Zone {
	paceDwell := make(map[string]float64, len(paceZoneList))
	for _, z := range paceZoneList {
		paceDwell[z.Name] = 0
	}
	hrDwell := make(map[string]float64, len(hrZoneList))
	for _, z := range hrZoneList {
		hrDwell[z.Name] = 0
	}

	for _, s := range samples {
		if s.SpeedMps != nil && len(paceZoneList) > 0 {
			if z := paceZoneForSpeed(*s.SpeedMps, paceZoneList); z != nil {
				paceDwell[z.Name] += s.DwellS
			}
		}
		if s.HRBpm != nil && len(hrZoneList) > 0 {
			if z := hrZoneForBpm(*s.HRBpm, hrZoneList); z != nil {
				hrDwell[z.Name] += s.DwellS
			}
		}
	}

	paceTotal := sumValues(paceDwell)
	rows := make([]Zone, 0, len(paceZoneList)+len(hrZoneList))
	for _, z := range paceZoneList {
		seconds := paceDwell[z.Name]
		idx, ok := zoneIndex[z.Name]
		if !ok {
			// Unknown calibration zone name: skip rather than emit a bogus
			// zone_index=0 row (the Python mirror raises KeyError here).
			continue
		}
		rows = append(rows, Zone{
			ZoneType:  "pace",
			ZoneIndex: idx,
			RangeMin:  paceMsPerKm(z.MinPaceSPerKm),
			RangeMax:  paceMsPerKm(z.MaxPaceSPerKm),
			RangeUnit: sptr("pace"),
			DurationS: intPtr(roundInt(seconds)),
			Percent:   floatPtr(percentOf(seconds, paceTotal)),
		})
	}

	hrTotal := sumValues(hrDwell)
	for _, z := range hrZoneList {
		seconds := hrDwell[z.Name]
		idx, ok := zoneIndex[z.Name]
		if !ok {
			continue
		}
		rows = append(rows, Zone{
			ZoneType:  "heartRate",
			ZoneIndex: idx,
			RangeMin:  roundBpm(z.MinBpm),
			RangeMax:  roundBpm(z.MaxBpm),
			RangeUnit: sptr("bpm"),
			DurationS: intPtr(roundInt(seconds)),
			Percent:   floatPtr(percentOf(seconds, hrTotal)),
		})
	}
	return rows
}

func sumValues(m map[string]float64) float64 {
	var total float64
	for _, v := range m {
		total += v
	}
	return total
}

func intPtr(v int) *int     { return &v }
func floatPtr(v float64) *float64 { return &v }
