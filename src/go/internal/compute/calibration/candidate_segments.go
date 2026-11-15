package calibration

import (
	"math"
	"sort"
)

// Conservative, predeclared research limits; see candidate-segments-v1.md.
const candidateMaxGapS = 10.0
const candidatePauseS = 10.0
const candidateStationaryMps = 0.3
const candidateConflictRatio = 0.10

// SegmentQuality describes measurement only; it never asserts maximal effort.
// Rules are conservative research choices, not calibrated probabilities.
type SegmentQuality struct {
	TimeBasis        string   `json:"time_basis"`
	DistanceCoverage float64  `json:"distance_coverage"`
	SpeedCoverage    float64  `json:"speed_coverage"`
	DistanceSpeedMps *float64 `json:"distance_speed_mps,omitempty"`
	IntegralSpeedMps *float64 `json:"integral_speed_mps,omitempty"`
	Reasons          []string `json:"reasons"`
	SpeedCV          *float64 `json:"speed_cv,omitempty"`
}

// CandidateSegment keeps the legacy estimator input beside auditable quality.
type CandidateSegment struct {
	SpeedCandidate
	Quality SegmentQuality `json:"quality"`
}

type CandidateContinuityBreak struct {
	StartS float64 `json:"start_s"`
	EndS   float64 `json:"end_s"`
	Reason string  `json:"reason"`
}

type CandidateActivityDiagnostic struct {
	ActivityID        string                     `json:"activity_id"`
	Reasons           []string                   `json:"reasons"`
	RejectedWindows   int                        `json:"rejected_windows"`
	RejectedReasons   map[string]int             `json:"rejected_reasons,omitempty"`
	Breaks            []CandidateContinuityBreak `json:"continuity_breaks,omitempty"`
	MissingDurationsS []int                      `json:"missing_durations_s,omitempty"`
}

type CandidateSegments struct {
	Candidates  []CandidateSegment            `json:"candidates"`
	Diagnostics []CandidateActivityDiagnostic `json:"diagnostics"`
}

type candidatePoint struct {
	t     float64
	d     *float64
	s     *float64
	epoch int
}

type candidateSeries struct {
	points                                                 []candidatePoint
	distance, speed, distanceTime, speedTime, speedSquared []float64
}

// BuildCandidateSegments is the offline pure measurement boundary for T2+.
// Production BestSpeedCandidates and every frozen v3 helper remain unchanged.
func BuildCandidateSegments(history []Activity, durationsS []int) CandidateSegments {
	out := CandidateSegments{}
	for _, a := range history {
		if !isRunning(a) {
			continue
		}
		diag := CandidateActivityDiagnostic{ActivityID: a.LabelID}
		series := prepareCandidateSeries(a.Samples, &diag)
		reconcileCandidateActivity(a, series, &diag)
		for _, duration := range durationsS {
			if duration <= 0 {
				continue
			}
			var best *CandidateSegment
			for _, p := range series {
				for right := 1; right < len(p.points); right++ {
					end := p.points[right].t
					start := end - float64(duration)
					if start < p.points[0].t {
						continue
					}
					left := bisectCandidate(p.points, start)
					da, sa, dc, sc := p.at(start, left)
					elapsed := float64(duration)
					quality := SegmentQuality{TimeBasis: "elapsed", DistanceCoverage: (p.distanceTime[right] - dc) / elapsed, SpeedCoverage: (p.speedTime[right] - sc) / elapsed, Reasons: append([]string(nil), diag.Reasons...)}
					if quality.SpeedCoverage >= 0.8 {
						mean := (p.speed[right] - sa) / elapsed
						if mean > 0 {
							variance := math.Max(0, (p.speedSquared[right]-p.squareAt(start, left))/elapsed-mean*mean)
							quality.SpeedCV = f64(math.Sqrt(variance) / mean)
						}
					}
					if duration >= 20*60 && quality.SpeedCV != nil && *quality.SpeedCV > 0.12 {
						diag.reject("unstable_long_window")
						continue
					}
					if quality.DistanceCoverage >= 0.95 {
						quality.DistanceSpeedMps = f64((p.distance[right] - da) / elapsed)
					}
					if quality.SpeedCoverage >= 0.95 {
						quality.IntegralSpeedMps = f64((p.speed[right] - sa) / elapsed)
					}
					speed := quality.DistanceSpeedMps
					conf := ConfidenceHigh
					if speed == nil {
						speed = quality.IntegralSpeedMps
						conf = ConfidenceMedium
						quality.Reasons = appendReason(quality.Reasons, "speed_integral_fallback")
					}
					if quality.DistanceSpeedMps != nil && quality.IntegralSpeedMps != nil && candidateConflict(*quality.DistanceSpeedMps, *quality.IntegralSpeedMps) {
						speed = f64(math.Min(*quality.DistanceSpeedMps, *quality.IntegralSpeedMps))
						conf = ConfidenceLow
						quality.Reasons = appendReason(quality.Reasons, "distance_speed_conflict")
					}
					if candidateHasConflict(quality.Reasons) {
						conf = ConfidenceLow
					}
					if speed == nil {
						diag.reject("measurement_coverage_below_95_percent")
						continue
					}
					if quality.DistanceCoverage < 1 || quality.SpeedCoverage < 1 {
						conf = ConfidenceLow
						quality.Reasons = appendReason(quality.Reasons, "incomplete_measurement_coverage")
					}
					if len(quality.Reasons) > 0 && conf == ConfidenceHigh {
						conf = ConfidenceMedium
					}
					c := CandidateSegment{SpeedCandidate: SpeedCandidate{Activity: a, DurationS: elapsed, AvgSpeedMps: *speed, Source: "timeseries", StartS: f64(start), EndS: f64(end), Confidence: conf}, Quality: quality}
					if best == nil || c.AvgSpeedMps > best.AvgSpeedMps {
						best = &c
					}
				}
			}
			if best == nil && len(a.Samples) < 2 {
				best = candidateSummary(a, duration, &diag)
			}
			if best != nil {
				out.Candidates = append(out.Candidates, *best)
			} else {
				diag.MissingDurationsS = append(diag.MissingDurationsS, duration)
			}
		}
		out.Diagnostics = append(out.Diagnostics, diag)
	}
	return out
}

func prepareCandidateSeries(samples []Sample, diag *CandidateActivityDiagnostic) []candidateSeries {
	var groups [][]candidatePoint
	var group []candidatePoint
	flush := func() {
		if len(group) > 0 {
			groups = append(groups, group)
			group = nil
		}
	}
	useTimestamp := 0
	for _, s := range samples {
		if candidateFinite(s.TimestampS) {
			useTimestamp++
		}
	}
	for _, s := range samples {
		clock := s.ElapsedS
		if useTimestamp >= 2 {
			clock = s.TimestampS
		}
		if !candidateFinite(clock) {
			diag.Reasons = appendReason(diag.Reasons, "missing_time")
			flush()
			continue
		}
		p := candidatePoint{t: *clock}
		if candidateFinite(s.SpeedMps) && *s.SpeedMps >= 0 && *s.SpeedMps <= 8.5 {
			p.s = s.SpeedMps
		} else {
			diag.Reasons = appendReason(diag.Reasons, "speed_missing")
		}
		if candidateFinite(s.DistanceM) && *s.DistanceM >= 0 {
			p.d = s.DistanceM
		} else {
			diag.Reasons = appendReason(diag.Reasons, "distance_missing")
		}
		if len(group) > 0 && p.t <= group[len(group)-1].t {
			diag.Breaks = append(diag.Breaks, CandidateContinuityBreak{StartS: group[len(group)-1].t, EndS: p.t, Reason: "non_increasing_time"})
			diag.Reasons = appendReason(diag.Reasons, "non_increasing_time")
			flush()
		}
		if len(group) > 0 && p.t-group[len(group)-1].t > candidateMaxGapS {
			diag.Breaks = append(diag.Breaks, CandidateContinuityBreak{StartS: group[len(group)-1].t, EndS: p.t, Reason: "long_gap"})
			diag.Reasons = appendReason(diag.Reasons, "long_gap")
			flush()
		}
		group = append(group, p)
	}
	flush()
	var out []candidateSeries
	for _, points := range groups {
		anchor := -1
		epoch := 0
		for i := range points {
			p := &points[i]
			p.epoch = epoch
			if p.d == nil {
				continue
			}
			if anchor >= 0 {
				dt := p.t - points[anchor].t
				dd := *p.d - *points[anchor].d
				if dd < 0 {
					// A return to the old track is an isolated downward spike. Otherwise
					// a locally plausible following point confirms a new distance epoch.
					reset := false
					if i+1 < len(points) && points[i+1].d != nil {
						next := points[i+1]
						ndt := next.t - p.t
						ndd := *next.d - *p.d
						oldDelta := *next.d - *points[anchor].d
						reset = oldDelta < 0 && ndd >= 0 && ndd/ndt <= 8.5
					}
					if reset {
						epoch++
						p.epoch = epoch
						diag.Reasons = appendReason(diag.Reasons, "distance_reset")
					} else {
						p.d = nil
						diag.Reasons = appendReason(diag.Reasons, "distance_spike")
					}
				} else if dd/dt > 8.5 {
					p.d = nil
					diag.Reasons = appendReason(diag.Reasons, "distance_spike")
				}
			}
			if p.d != nil {
				anchor = i
			}
		}
		left := -1
		for right, p := range points {
			if p.d == nil {
				continue
			}
			if left >= 0 && p.epoch == points[left].epoch && right > left+1 && p.t-points[left].t <= candidateMaxGapS {
				for k := left + 1; k < right; k++ {
					v := *points[left].d + (*p.d-*points[left].d)*(points[k].t-points[left].t)/(p.t-points[left].t)
					points[k].d = &v
					points[k].epoch = p.epoch
				}
			}
			left = right
		}
		for _, points := range splitCandidatePauses(points, diag) {
			n := len(points)
			p := candidateSeries{points: points, distance: make([]float64, n), speed: make([]float64, n), distanceTime: make([]float64, n), speedTime: make([]float64, n), speedSquared: make([]float64, n)}
			for i := 1; i < n; i++ {
				a, b := points[i-1], points[i]
				dt := b.t - a.t
				p.distance[i] = p.distance[i-1]
				p.speed[i] = p.speed[i-1]
				p.distanceTime[i] = p.distanceTime[i-1]
				p.speedTime[i] = p.speedTime[i-1]
				p.speedSquared[i] = p.speedSquared[i-1]
				if a.d != nil && b.d != nil && a.epoch == b.epoch {
					p.distance[i] += *b.d - *a.d
					p.distanceTime[i] += dt
				}
				if a.s != nil && b.s != nil {
					p.speed[i] += (*a.s + *b.s) * dt / 2
					p.speedTime[i] += dt
					p.speedSquared[i] += (*a.s**a.s + *a.s**b.s + *b.s**b.s) * dt / 3
				}
			}
			out = append(out, p)
		}
	}
	return out
}

// Explicit stationary spans are boundaries, never removable moving-time gaps.
func splitCandidatePauses(points []candidatePoint, diag *CandidateActivityDiagnostic) [][]candidatePoint {
	var out [][]candidatePoint
	start := 0
	for i := 1; i < len(points); {
		a, b := points[i-1], points[i]
		if !candidateStationary(a, b) {
			i++
			continue
		}
		left := i - 1
		for i < len(points) && candidateStationary(points[i-1], points[i]) {
			i++
		}
		right := i - 1
		if points[right].t-points[left].t >= candidatePauseS {
			diag.Breaks = append(diag.Breaks, CandidateContinuityBreak{StartS: points[left].t, EndS: points[right].t, Reason: "stationary_pause"})
			diag.Reasons = appendReason(diag.Reasons, "stationary_pause")
			if left >= start {
				out = append(out, points[start:left+1])
			}
			start = right
		}
	}
	if start < len(points) {
		out = append(out, points[start:])
	}
	return out
}
func candidateStationary(a, b candidatePoint) bool {
	if a.s != nil && b.s != nil {
		return *a.s <= candidateStationaryMps && *b.s <= candidateStationaryMps
	}
	return a.d != nil && b.d != nil && a.epoch == b.epoch && (*b.d-*a.d)/(b.t-a.t) <= candidateStationaryMps
}

// at integrates to an exact elapsed boundary. Speed is linear between adjacent
// samples, so sparse and irregular sampling never becomes a point-count mean.
func (p candidateSeries) at(t float64, left int) (distance, speed, distanceTime, speedTime float64) {
	distance = p.distance[left]
	speed = p.speed[left]
	distanceTime = p.distanceTime[left]
	speedTime = p.speedTime[left]
	if t == p.points[left].t || left+1 >= len(p.points) {
		return
	}
	a, b := p.points[left], p.points[left+1]
	dt := b.t - a.t
	x := t - a.t
	if a.d != nil && b.d != nil && a.epoch == b.epoch {
		distance += (*b.d - *a.d) * x / dt
		distanceTime += x
	}
	if a.s != nil && b.s != nil {
		speed += *a.s*x + (*b.s-*a.s)*x*x/(2*dt)
		speedTime += x
	}
	return
}
func bisectCandidate(points []candidatePoint, t float64) int {
	lo, hi := 0, len(points)
	for lo < hi {
		mid := (lo + hi) / 2
		if points[mid].t <= t {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return lo - 1
}
func candidateFinite(v *float64) bool { return v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) }
func appendReason(reasons []string, reason string) []string {
	for _, r := range reasons {
		if r == reason {
			return reasons
		}
	}
	return append(reasons, reason)
}

func candidateConflict(a, b float64) bool {
	return math.Abs(a-b) > candidateConflictRatio*math.Max(math.Abs(a), math.Abs(b))
}
func candidateHasConflict(reasons []string) bool {
	for _, r := range reasons {
		if r == "summary_distance_conflict" || r == "summary_elapsed_conflict" || r == "laps_summary_conflict" || r == "laps_timeseries_conflict" || r == "distance_speed_conflict" {
			return true
		}
	}
	return false
}
func reconcileCandidateActivity(a Activity, series []candidateSeries, diag *CandidateActivityDiagnostic) {
	var duration, distance, dc float64
	for _, p := range series {
		if len(p.points) < 2 {
			continue
		}
		n := len(p.points) - 1
		duration += p.points[n].t - p.points[0].t
		distance += p.distance[n]
		dc += p.distanceTime[n]
	}
	if candidateFinite(a.DurationS) && *a.DurationS > 0 && duration > 0 {
		if candidateConflict(duration, *a.DurationS) {
			diag.Reasons = appendReason(diag.Reasons, "summary_elapsed_conflict")
		} else if candidateFinite(a.DistanceM) && dc >= 0.95*duration && candidateConflict(distance, *a.DistanceM) {
			diag.Reasons = appendReason(diag.Reasons, "summary_distance_conflict")
		}
	}
	// Lap streams are alternatives, never concatenated across types.
	type totals struct {
		duration, distance float64
		valid              bool
	}
	streams := map[string]totals{}
	for _, lap := range a.Laps {
		key := "default"
		if lap.LapType != nil {
			key = *lap.LapType
		}
		v, exists := streams[key]
		if !exists {
			v.valid = true
		}
		if !candidateFinite(lap.DurationS) || *lap.DurationS <= 0 || !candidateFinite(lap.DistanceM) || *lap.DistanceM < 0 {
			v.valid = false
		} else {
			v.duration += *lap.DurationS
			v.distance += *lap.DistanceM
		}
		streams[key] = v
	}
	keys := make([]string, 0, len(streams))
	for key := range streams {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		v := streams[key]
		if !v.valid {
			continue
		}
		if duration > 0 && dc >= 0.95*duration && !candidateConflict(v.duration, duration) && candidateConflict(v.distance, distance) {
			diag.Reasons = appendReason(diag.Reasons, "laps_timeseries_conflict")
		}
		if candidateFinite(a.DurationS) && candidateFinite(a.DistanceM) && !candidateConflict(v.duration, *a.DurationS) && candidateConflict(v.distance, *a.DistanceM) {
			diag.Reasons = appendReason(diag.Reasons, "laps_summary_conflict")
		}
	}
}

// Without a recorded clock a summary is only low-quality, unverified continuity
// evidence for its actual duration. It never fills a hole in a recorded stream.
func candidateSummary(a Activity, duration int, diag *CandidateActivityDiagnostic) *CandidateSegment {
	if !candidateFinite(a.DurationS) || *a.DurationS <= 0 || !candidateFinite(a.DistanceM) || *a.DistanceM < 500 {
		return nil
	}
	if math.Abs(*a.DurationS-float64(duration)) > 0.1*float64(duration) {
		return nil
	}
	speed := *a.DistanceM / *a.DurationS
	if speed < 0 || speed > 8.5 {
		return nil
	}
	reasons := append([]string(nil), diag.Reasons...)
	reasons = appendReason(reasons, "summary_only_continuity_unverified")
	return &CandidateSegment{SpeedCandidate: SpeedCandidate{Activity: a, DurationS: *a.DurationS, AvgSpeedMps: speed, Source: "activity", StartS: f64(0), EndS: f64(*a.DurationS), Confidence: ConfidenceLow}, Quality: SegmentQuality{TimeBasis: "summary_unverified", Reasons: reasons}}
}

func (p candidateSeries) squareAt(t float64, left int) float64 {
	value := p.speedSquared[left]
	if t == p.points[left].t || left+1 >= len(p.points) {
		return value
	}
	a, b := p.points[left], p.points[left+1]
	if a.s == nil || b.s == nil {
		return value
	}
	dt := b.t - a.t
	x := t - a.t
	slope := (*b.s - *a.s) / dt
	return value + *a.s**a.s*x + *a.s*slope*x*x + slope*slope*x*x*x/3
}
func (d *CandidateActivityDiagnostic) reject(reason string) {
	d.RejectedWindows++
	if d.RejectedReasons == nil {
		d.RejectedReasons = map[string]int{}
	}
	d.RejectedReasons[reason]++
}
