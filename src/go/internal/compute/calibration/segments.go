package calibration

import (
	"math"
	"sort"
	"time"
)

// BestEffortDurationsS mirrors core.BEST_EFFORT_DURATIONS_S.
var BestEffortDurationsS = []int{3 * 60, 5 * 60, 10 * 60, 20 * 60, 30 * 60, 45 * 60, 60 * 60}

const (
	thresholdSpeedLowRatio     = 0.94
	thresholdSpeedHighRatio    = 1.07
	thresholdSpeedMaxCV        = 0.07
	shortSprintHRCutoffBpm     = 198.0
	lapStreamActivityTolerance = 1.1
	recencyHalfLifeDays        = 90.0
)

// SpeedCandidate mirrors segments.SpeedCandidate.
type SpeedCandidate struct {
	Activity    Activity
	DurationS   float64
	AvgSpeedMps float64
	Source      string
	StartS      *float64
	EndS        *float64
	Confidence  Confidence
}

// ThresholdHrCandidate mirrors segments.ThresholdHrCandidate.
type ThresholdHrCandidate struct {
	Activity    Activity
	StartS      float64
	EndS        float64
	DurationS   float64
	AvgSpeedMps float64
	AvgHR       float64
	Confidence  Confidence
}

// preparedSamples mirrors segments._PreparedSamples (cleaned samples + prefix
// sums for O(1) windowed aggregates).
type preparedSamples struct {
	samples       []Sample
	times         []float64
	distances     []*float64
	speeds        []*float64
	distanceCount []int
	speedCount    []int
	speedSum      []float64
	speedSqSum    []float64
	hrCount       []int
	hrSum         []float64
}

func sampleTime(s Sample, index int) float64 {
	if s.ElapsedS != nil {
		return *s.ElapsedS
	}
	if s.TimestampS != nil {
		return *s.TimestampS
	}
	return float64(index)
}

// sampleSpeed mirrors segments.sample_speed: finite, >0, <=8.5, else nil.
func sampleSpeed(s Sample) *float64 {
	if s.SpeedMps == nil {
		return nil
	}
	speed := *s.SpeedMps
	if math.IsInf(speed, 0) || math.IsNaN(speed) || speed <= 0 || speed > 8.5 {
		return nil
	}
	v := speed
	return &v
}

// cleanSamples mirrors segments.clean_samples: sanitises speed + rejects
// implausible distance jumps.
func cleanSamples(samples []Sample) []Sample {
	out := make([]Sample, 0, len(samples))
	var lastDistance *float64
	for i, s := range samples {
		speed := sampleSpeed(s)
		var distance *float64
		if s.DistanceM != nil {
			d := *s.DistanceM
			distance = &d
		}
		if distance != nil && lastDistance != nil {
			dt := sampleTime(s, i) - sampleTime(samples[i-1], i-1)
			dd := *distance - *lastDistance
			if dt <= 0 || dd < -5 || (dt > 0 && dd/dt > 8.5) {
				distance = nil
			}
		}
		if distance != nil {
			lastDistance = distance
		}
		out = append(out, Sample{
			TimestampS:   s.TimestampS,
			ElapsedS:     s.ElapsedS,
			DistanceM:    distance,
			HeartRateBpm: s.HeartRateBpm,
			SpeedMps:     speed,
			PowerW:       s.PowerW,
			AltitudeM:    s.AltitudeM,
		})
	}
	return out
}

func prepareSamples(samples []Sample) preparedSamples {
	clean := cleanSamples(samples)
	n := len(clean)
	p := preparedSamples{
		samples:       clean,
		times:         make([]float64, n),
		distances:     make([]*float64, n),
		speeds:        make([]*float64, n),
		distanceCount: make([]int, n+1),
		speedCount:    make([]int, n+1),
		speedSum:      make([]float64, n+1),
		speedSqSum:    make([]float64, n+1),
		hrCount:       make([]int, n+1),
		hrSum:         make([]float64, n+1),
	}
	for i, s := range clean {
		p.times[i] = sampleTime(s, i)
		p.distances[i] = s.DistanceM
		var speed *float64
		if s.SpeedMps != nil && *s.SpeedMps >= 1.5 && *s.SpeedMps <= 8.5 {
			v := *s.SpeedMps
			speed = &v
		}
		p.speeds[i] = speed
		hr := hrValue(s.HeartRateBpm)

		p.distanceCount[i+1] = p.distanceCount[i] + boolToInt(s.DistanceM != nil)
		p.speedCount[i+1] = p.speedCount[i] + boolToInt(speed != nil)
		sv := 0.0
		if speed != nil {
			sv = *speed
		}
		p.speedSum[i+1] = p.speedSum[i] + sv
		p.speedSqSum[i+1] = p.speedSqSum[i] + sv*sv
		p.hrCount[i+1] = p.hrCount[i] + boolToInt(hr != nil)
		hv := 0.0
		if hr != nil {
			hv = *hr
		}
		p.hrSum[i+1] = p.hrSum[i] + hv
	}
	return p
}

func rangeCount(prefix []int, start, end int) int       { return prefix[end+1] - prefix[start] }
func rangeSum(prefix []float64, start, end int) float64 { return prefix[end+1] - prefix[start] }

func durationFromSamples(samples []Sample) *float64 {
	if len(samples) < 2 {
		return nil
	}
	start := sampleTime(samples[0], 0)
	end := sampleTime(samples[len(samples)-1], len(samples)-1)
	if end > start {
		v := end - start
		return &v
	}
	return nil
}

func activityDurationS(a Activity) *float64 {
	if a.DurationS != nil && *a.DurationS > 0 {
		v := *a.DurationS
		return &v
	}
	return durationFromSamples(a.Samples)
}

func activityMeanSpeed(a Activity) *float64 {
	duration := activityDurationS(a)
	if duration == nil || *duration <= 0 {
		return nil
	}
	if a.DistanceM != nil && *a.DistanceM >= 500 {
		speed := *a.DistanceM / *duration
		if speed >= 1.5 && speed <= 8.5 {
			return &speed
		}
	}
	var speeds []float64
	for _, s := range a.Samples {
		if v := sampleSpeed(s); v != nil {
			speeds = append(speeds, *v)
		}
	}
	if len(speeds) == 0 {
		return nil
	}
	m := meanFloat(speeds)
	return &m
}

func windowAverageSpeedPrepared(p preparedSamples, start, end int) *float64 {
	size := end - start + 1
	if size <= 1 {
		return nil
	}
	distanceCount := rangeCount(p.distanceCount, start, end)
	first := p.distances[start]
	last := p.distances[end]
	if float64(distanceCount)/float64(size) >= 0.8 && first != nil && last != nil {
		dt := p.times[end] - p.times[start]
		dd := *last - *first
		if dt > 0 && dd > 0 {
			speed := dd / dt
			if speed >= 1.5 && speed <= 8.5 {
				return &speed
			}
		}
	}
	speedCount := rangeCount(p.speedCount, start, end)
	if float64(speedCount)/float64(size) >= 0.8 && speedCount > 0 {
		v := rangeSum(p.speedSum, start, end) / float64(speedCount)
		return &v
	}
	return nil
}

func bestSpeedForDurationPrepared(a Activity, durationS int, p preparedSamples) *SpeedCandidate {
	if len(p.samples) >= 2 {
		type best struct {
			speed       float64
			left, right int
		}
		var b *best
		for right := 1; right < len(p.samples); right++ {
			target := p.times[right] - float64(durationS)
			left := bisectLeft(p.times, target, 0, right)
			if left > 0 && math.Abs(p.times[right]-p.times[left-1]-float64(durationS)) < math.Abs(p.times[right]-p.times[left]-float64(durationS)) {
				left--
			}
			elapsed := p.times[right] - p.times[left]
			if math.Abs(elapsed-float64(durationS)) > 30 {
				continue
			}
			if durationS >= 20*60 && !stableSpeedWindowPrepared(p, left, right, 0.12) {
				continue
			}
			speed := windowAverageSpeedPrepared(p, left, right)
			if speed != nil && (b == nil || *speed > b.speed) {
				b = &best{*speed, left, right}
			}
		}
		if b != nil {
			start := p.times[b.left]
			end := p.times[b.right]
			return &SpeedCandidate{
				Activity:    a,
				DurationS:   float64(durationS),
				AvgSpeedMps: b.speed,
				Source:      "timeseries",
				StartS:      &start,
				EndS:        &end,
				Confidence:  ConfidenceHigh,
			}
		}
	}

	if lapBest := bestLapBlock(a, durationS); lapBest != nil {
		return lapBest
	}

	duration := activityDurationS(a)
	speed := activityMeanSpeed(a)
	if duration == nil || speed == nil {
		return nil
	}
	if durationS >= 20*60 && len(p.samples) >= 2 {
		if !stableSpeedWindowPrepared(p, 0, len(p.samples)-1, 0.12) {
			return nil
		}
	}
	if *duration >= float64(durationS)*0.9 {
		conf := ConfidenceLow
		if *duration >= float64(durationS) {
			conf = ConfidenceMedium
		}
		dur := math.Min(*duration, float64(durationS))
		start := 0.0
		end := *duration
		return &SpeedCandidate{
			Activity:    a,
			DurationS:   dur,
			AvgSpeedMps: *speed,
			Source:      "activity",
			StartS:      &start,
			EndS:        &end,
			Confidence:  conf,
		}
	}
	return nil
}

func bestLapBlock(a Activity, durationS int) *SpeedCandidate {
	if len(a.Laps) == 0 {
		return nil
	}
	var bestSpeed *float64
	type span struct {
		laps          []Lap
		left, right   int
		totalDuration float64
	}
	var bestSpan *span
	for _, laps := range validLapStreams(a) {
		for left := 0; left < len(laps); left++ {
			totalDuration := 0.0
			totalDistance := 0.0
			for right := left; right < len(laps); right++ {
				lap := laps[right]
				if lap.DurationS == nil || *lap.DurationS == 0 || lap.DistanceM == nil || *lap.DistanceM == 0 {
					continue
				}
				totalDuration += *lap.DurationS
				totalDistance += *lap.DistanceM
				if totalDuration < float64(durationS)*0.9 {
					continue
				}
				if totalDuration > float64(durationS)*1.2 {
					break
				}
				if totalDuration <= 0 {
					continue
				}
				speed := totalDistance / totalDuration
				if speed >= 1.5 && speed <= 8.5 && (bestSpeed == nil || speed > *bestSpeed) {
					s := speed
					bestSpeed = &s
					bestSpan = &span{laps, left, right, totalDuration}
				}
			}
		}
	}
	if bestSpeed == nil || bestSpan == nil {
		return nil
	}
	startS := 0.0
	for _, l := range bestSpan.laps[:bestSpan.left] {
		if l.DurationS != nil {
			startS += *l.DurationS
		}
	}
	endS := startS + bestSpan.totalDuration
	return &SpeedCandidate{
		Activity:    a,
		DurationS:   bestSpan.totalDuration,
		AvgSpeedMps: *bestSpeed,
		Source:      "laps",
		StartS:      &startS,
		EndS:        &endS,
		Confidence:  ConfidenceMedium,
	}
}

func validLapStreams(a Activity) [][]Lap {
	var order []string
	byType := map[string][]Lap{}
	for _, lap := range a.Laps {
		key := "default"
		if lap.LapType != nil && *lap.LapType != "" {
			key = *lap.LapType
		}
		if _, ok := byType[key]; !ok {
			order = append(order, key)
		}
		byType[key] = append(byType[key], lap)
	}
	streams := make([][]Lap, 0, len(order))
	for _, k := range order {
		streams = append(streams, byType[k])
	}
	if len(streams) == 1 {
		if lapStreamMatchesActivity(a, streams[0]) {
			return streams
		}
		return nil
	}
	var out [][]Lap
	for _, s := range streams {
		if lapStreamMatchesActivity(a, s) {
			out = append(out, s)
		}
	}
	return out
}

func lapStreamMatchesActivity(a Activity, laps []Lap) bool {
	totalDuration := 0.0
	totalDistance := 0.0
	hasDuration := false
	hasDistance := false
	for _, lap := range laps {
		if lap.DurationS == nil || *lap.DurationS == 0 || lap.DistanceM == nil || *lap.DistanceM == 0 {
			continue
		}
		totalDuration += *lap.DurationS
		totalDistance += *lap.DistanceM
		hasDuration = true
		hasDistance = true
	}
	if !hasDuration || !hasDistance {
		return false
	}
	if a.DurationS != nil && *a.DurationS != 0 && totalDuration > *a.DurationS*lapStreamActivityTolerance {
		return false
	}
	if a.DistanceM != nil && *a.DistanceM != 0 && totalDistance > *a.DistanceM*lapStreamActivityTolerance {
		return false
	}
	return true
}

// BestSpeedCandidates mirrors segments.best_speed_candidates.
func BestSpeedCandidates(history []Activity, durationsS []int) []SpeedCandidate {
	var candidates []SpeedCandidate
	for _, a := range history {
		if !isRunning(a) {
			continue
		}
		p := prepareSamples(a.Samples)
		for _, d := range durationsS {
			if c := bestSpeedForDurationPrepared(a, d, p); c != nil {
				candidates = append(candidates, *c)
			}
		}
	}
	return candidates
}

func hrValue(v *float64) *float64 {
	if v == nil {
		return nil
	}
	hr := *v
	if hr >= 80 && hr <= 230 {
		return &hr
	}
	return nil
}

func coefficientOfVariation(values []float64) float64 {
	if len(values) == 0 {
		return 999.0
	}
	avg := meanFloat(values)
	if avg <= 0 {
		return 999.0
	}
	var ss float64
	for _, v := range values {
		ss += (v - avg) * (v - avg)
	}
	return math.Sqrt(ss/float64(len(values))) / avg
}

func stableSpeedWindow(samples []Sample, start, end int, maxCV float64) bool {
	window := samples[start : end+1]
	var speeds []float64
	for _, s := range window {
		if s.SpeedMps != nil {
			speeds = append(speeds, *s.SpeedMps)
		}
	}
	if float64(len(speeds))/float64(len(window)) < 0.8 {
		return true
	}
	return coefficientOfVariation(speeds) <= maxCV
}

func stableSpeedWindowPrepared(p preparedSamples, start, end int, maxCV float64) bool {
	size := end - start + 1
	if size <= 1 {
		return false
	}
	count := rangeCount(p.speedCount, start, end)
	if float64(count)/float64(size) < 0.8 {
		return true
	}
	total := rangeSum(p.speedSum, start, end)
	var avg float64
	if count != 0 {
		avg = total / float64(count)
	}
	if avg <= 0 {
		return false
	}
	sqTotal := rangeSum(p.speedSqSum, start, end)
	variance := math.Max(0.0, sqTotal/float64(count)-avg*avg)
	return math.Sqrt(variance)/avg <= maxCV
}

// StableThresholdHrCandidates mirrors segments.stable_threshold_hr_candidates.
func StableThresholdHrCandidates(history []Activity, thresholdSpeedMps float64) []ThresholdHrCandidate {
	minDurationS := 20 * 60
	maxDurationS := 40 * 60
	var out []ThresholdHrCandidate
	for _, a := range history {
		if !isRunning(a) {
			continue
		}
		p := prepareSamples(a.Samples)
		if len(p.samples) >= 2 {
			out = append(out, timeseriesThresholdHrCandidates(a, p, thresholdSpeedMps, minDurationS, maxDurationS)...)
		}
		already := false
		for _, c := range out {
			if c.Activity.LabelID == a.LabelID {
				already = true
				break
			}
		}
		if !already {
			if fb := activityThresholdHrCandidate(a, thresholdSpeedMps, minDurationS, maxDurationS); fb != nil {
				out = append(out, *fb)
			}
		}
	}
	return out
}

func timeseriesThresholdHrCandidates(a Activity, p preparedSamples, thresholdSpeedMps float64, minDurationS, maxDurationS int) []ThresholdHrCandidate {
	var bestByActivity *ThresholdHrCandidate
	step := 5 * 60
	for durationS := minDurationS; durationS <= maxDurationS; durationS += step {
		for right := 1; right < len(p.samples); right++ {
			target := p.times[right] - float64(durationS)
			left := bisectLeft(p.times, target, 0, right)
			if left > 0 && math.Abs(p.times[right]-p.times[left-1]-float64(durationS)) < math.Abs(p.times[right]-p.times[left]-float64(durationS)) {
				left--
			}
			elapsed := p.times[right] - p.times[left]
			if math.Abs(elapsed-float64(durationS)) > 30 {
				continue
			}
			size := right - left + 1
			avgSpeed := windowAverageSpeedPrepared(p, left, right)
			if avgSpeed == nil || !(thresholdSpeedLowRatio*thresholdSpeedMps <= *avgSpeed && *avgSpeed <= thresholdSpeedHighRatio*thresholdSpeedMps) {
				continue
			}
			speedCount := rangeCount(p.speedCount, left, right)
			if float64(speedCount)/float64(size) < 0.8 || !stableSpeedWindowPrepared(p, left, right, thresholdSpeedMaxCV) {
				continue
			}
			hrCount := rangeCount(p.hrCount, left, right)
			if float64(hrCount)/float64(size) < 0.8 {
				continue
			}
			maxHR := 0.0
			for k := left; k <= right; k++ {
				if h := hrValue(p.samples[k].HeartRateBpm); h != nil && *h > maxHR {
					maxHR = *h
				}
			}
			if maxHR >= shortSprintHRCutoffBpm && elapsed < 30*60 {
				continue
			}
			tailStartTime := p.times[right] - math.Min(20*60, elapsed*0.5)
			tailStart := bisectLeftRange(p.times, tailStartTime, left, right+1)
			tailHRCount := rangeCount(p.hrCount, tailStart, right)
			if tailHRCount <= 0 {
				continue
			}
			tailHR := rangeSum(p.hrSum, tailStart, right) / float64(tailHRCount)
			candidate := ThresholdHrCandidate{
				Activity:    a,
				StartS:      p.times[left],
				EndS:        p.times[right],
				DurationS:   elapsed,
				AvgSpeedMps: *avgSpeed,
				AvgHR:       tailHR,
				Confidence:  ConfidenceHigh,
			}
			if bestByActivity == nil || candidateScore(candidate, thresholdSpeedMps) > candidateScore(*bestByActivity, thresholdSpeedMps) {
				c := candidate
				bestByActivity = &c
			}
		}
	}
	if bestByActivity != nil {
		return []ThresholdHrCandidate{*bestByActivity}
	}
	return nil
}

func activityThresholdHrCandidate(a Activity, thresholdSpeedMps float64, minDurationS, maxDurationS int) *ThresholdHrCandidate {
	duration := activityDurationS(a)
	speed := activityMeanSpeed(a)
	hr := hrValue(a.AvgHR)
	if duration == nil || speed == nil || hr == nil {
		return nil
	}
	if len(a.Samples) >= 2 {
		samples := cleanSamples(a.Samples)
		if !stableSpeedWindow(samples, 0, len(samples)-1, 0.12) {
			return nil
		}
	}
	if !(float64(minDurationS) <= *duration && *duration <= float64(maxDurationS)*1.5) {
		return nil
	}
	if !(0.94*thresholdSpeedMps <= *speed && *speed <= 1.07*thresholdSpeedMps) {
		return nil
	}
	return &ThresholdHrCandidate{
		Activity:    a,
		StartS:      0.0,
		EndS:        *duration,
		DurationS:   *duration,
		AvgSpeedMps: *speed,
		AvgHR:       *hr,
		Confidence:  ConfidenceMedium,
	}
}

func candidateScore(c ThresholdHrCandidate, thresholdSpeedMps float64) float64 {
	durationScore := math.Min(c.DurationS/(30*60), 1.2)
	speedScore := 1.0 - math.Min(math.Abs(c.AvgSpeedMps-thresholdSpeedMps)/thresholdSpeedMps, 0.2)
	return durationScore + speedScore
}

// recencyWeight mirrors segments.recency_weight.
func recencyWeight(activityDate, asOfDate time.Time) float64 {
	ageDays := dayDiff(asOfDate, activityDate)
	if ageDays < 0 {
		ageDays = 0
	}
	return math.Pow(0.5, float64(ageDays)/recencyHalfLifeDays)
}

// candidateWeight mirrors segments.candidate_weight.
func candidateWeight(c SpeedCandidate, asOfDate time.Time) float64 {
	weight := math.Sqrt(math.Max(c.DurationS, 1.0) / (60 * 60))
	switch c.Confidence {
	case ConfidenceHigh:
		weight *= 1.5
	case ConfidenceLow:
		weight *= 0.6
	}
	if c.Source == "timeseries" {
		weight *= 1.15
	}
	weight *= recencyWeight(c.Activity.ActivityDate, asOfDate)
	return weight
}

// weightedMedian mirrors segments.weighted_median.
func weightedMedian(values [][2]float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	ordered := make([][2]float64, len(values))
	for i, v := range values {
		ordered[i] = [2]float64{v[0], math.Max(0.0, v[1])}
	}
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i][0] < ordered[j][0] })
	total := 0.0
	for _, o := range ordered {
		total += o[1]
	}
	if total <= 0 {
		vals := make([]float64, len(ordered))
		for i, o := range ordered {
			vals[i] = o[0]
		}
		m := medianFloat(vals)
		return &m
	}
	acc := 0.0
	for _, o := range ordered {
		acc += o[1]
		if acc >= total/2.0 {
			v := o[0]
			return &v
		}
	}
	v := ordered[len(ordered)-1][0]
	return &v
}

// --- small helpers ---

func bisectLeft(a []float64, x float64, lo, hi int) int {
	for lo < hi {
		mid := (lo + hi) / 2
		if a[mid] < x {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return lo
}

func bisectLeftRange(a []float64, x float64, lo, hi int) int { return bisectLeft(a, x, lo, hi) }

func meanFloat(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	var s float64
	for _, v := range xs {
		s += v
	}
	return s / float64(len(xs))
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
