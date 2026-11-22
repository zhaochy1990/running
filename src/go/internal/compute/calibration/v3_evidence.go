// Persistent per-activity sufficient statistics for the frozen v3 estimator.
// Keep the full estimator as an independent oracle. Only qualification against
// the current threshold, recency weighting and population reductions are daily.
package calibration

import (
	"bytes"
	"compress/zlib"
	"encoding/gob"
	"io"
	"math"
	"sort"
	"time"
)

// Bump on any incompatible change to extraction, source mapping or encoding.
const V3EvidenceVersion = 1

// V3RestingHRStart is inclusive, matching the frozen daily RHR estimator.
func V3RestingHRStart(day time.Time) time.Time { return day.AddDate(0, 0, -rhrLookbackDays) }

type v3Window struct{ Duration, Speed, HR float64 }

type V3ActivityEvidence struct {
	Speeds    []SpeedCandidate
	HR, Power map[float64]int
	Windows   []v3Window
	Fallback  *v3Window
}

func ExtractV3Evidence(a Activity) V3ActivityEvidence {
	e := V3ActivityEvidence{HR: map[float64]int{}, Power: map[float64]int{}}
	supported := supportedTimeseriesHRValues(a)
	for _, h := range supported {
		e.HR[h]++
	}
	if activityMaxHRSupported(a, supported) {
		e.HR[*a.MaxHR]++
	}
	if !isRunning(a) {
		return e
	}
	if validRunningPower(a.AvgPowerW) {
		e.Power[*a.AvgPowerW]++
	}
	for _, s := range a.Samples {
		if validRunningPower(s.PowerW) {
			e.Power[*s.PowerW]++
		}
	}
	p := prepareSamples(a.Samples)
	for _, d := range BestEffortDurationsS {
		if c := bestSpeedForDurationPrepared(a, d, p); c != nil {
			c.Activity = Activity{LabelID: a.LabelID, ActivityDate: a.ActivityDate}
			e.Speeds = append(e.Speeds, *c)
		}
	}
	e.Windows = v3HRWindows(p)
	// At its own mean speed the fallback passes the speed-ratio gate. The
	// unchanged daily gate is applied again at the actual threshold.
	if speed := activityMeanSpeed(a); speed != nil {
		if c := activityThresholdHrCandidate(a, *speed, 20*60, 40*60); c != nil {
			e.Fallback = &v3Window{c.DurationS, c.AvgSpeedMps, c.AvgHR}
		}
	}
	return e
}

// Enumerate the same intervals, in the same tie-breaking order, as frozen
// timeseriesThresholdHrCandidates. Save only threshold-independent features.
// A prefix count replaces the scan for an HR spike inside each short window.
func v3HRWindows(p preparedSamples) []v3Window {
	var out []v3Window
	// With identical speed and duration the frozen scorer always keeps the
	// first window, even if a later one has a different tail HR.
	seen := map[[2]float64]bool{}
	spikes := make([]int, len(p.times)+1)
	for i, s := range p.samples {
		spikes[i+1] = spikes[i]
		if hr := hrValue(s.HeartRateBpm); hr != nil && *hr >= shortSprintHRCutoffBpm {
			spikes[i+1]++
		}
	}
	for duration := 20 * 60; duration <= 40*60; duration += 5 * 60 {
		for right := 1; right < len(p.times); right++ {
			target := p.times[right] - float64(duration)
			left := bisectLeft(p.times, target, 0, right)
			if left > 0 && math.Abs(p.times[right]-p.times[left-1]-float64(duration)) < math.Abs(p.times[right]-p.times[left]-float64(duration)) {
				left--
			}
			elapsed := p.times[right] - p.times[left]
			if math.Abs(elapsed-float64(duration)) > 30 || (elapsed < 30*60 && rangeCount(spikes, left, right) > 0) {
				continue
			}
			size := float64(right - left + 1)
			if float64(rangeCount(p.speedCount, left, right))/size < 0.8 || float64(rangeCount(p.hrCount, left, right))/size < 0.8 || !stableSpeedWindowPrepared(p, left, right, thresholdSpeedMaxCV) {
				continue
			}
			speed := windowAverageSpeedPrepared(p, left, right)
			if speed == nil {
				continue
			}
			tail := bisectLeftRange(p.times, p.times[right]-math.Min(20*60, elapsed*0.5), left, right+1)
			count := rangeCount(p.hrCount, tail, right)
			key := [2]float64{elapsed, *speed}
			if count > 0 && !seen[key] {
				seen[key] = true
				out = append(out, v3Window{elapsed, *speed, rangeSum(p.hrSum, tail, right) / float64(count)})
			}
		}
	}
	return out
}

func (e *V3ActivityEvidence) thresholdHR(speed float64) *ThresholdHrCandidate {
	var best ThresholdHrCandidate
	bestScore := -1.0
	consider := func(w v3Window, confidence Confidence) {
		if !(thresholdSpeedLowRatio*speed <= w.Speed && w.Speed <= thresholdSpeedHighRatio*speed) {
			return
		}
		candidate := ThresholdHrCandidate{DurationS: w.Duration, AvgSpeedMps: w.Speed, AvgHR: w.HR, Confidence: confidence}
		if score := candidateScore(candidate, speed); score > bestScore {
			best, bestScore = candidate, score
		}
	}
	for _, w := range e.Windows {
		consider(w, ConfidenceHigh)
	}
	if bestScore < 0 && e.Fallback != nil {
		consider(*e.Fallback, ConfidenceMedium)
	}
	if bestScore < 0 {
		return nil
	}
	return &best
}

func (e *V3ActivityEvidence) Marshal() ([]byte, error) {
	var buf bytes.Buffer
	writer, err := zlib.NewWriterLevel(&buf, zlib.BestSpeed)
	if err != nil {
		return nil, err
	}
	if err := gob.NewEncoder(writer).Encode(e); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
func DecodeV3Evidence(data []byte) (V3ActivityEvidence, error) {
	var e V3ActivityEvidence
	reader, err := zlib.NewReader(bytes.NewReader(data))
	if err != nil {
		return e, err
	}
	defer reader.Close()
	if err := gob.NewDecoder(reader).Decode(&e); err != nil {
		return e, err
	}
	// Consume the trailer so a checksum failure also rebuilds this activity.
	_, err = io.Copy(io.Discard, reader)
	return e, err
}

// histogramRanks returns exact order statistics without expanding samples.
func histogramRanks(counts map[float64]int, ranks ...int) []float64 {
	keys := make([]float64, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Float64s(keys)
	values := make([]float64, len(ranks))
	n, i := 0, 0
	for _, k := range keys {
		n += counts[k]
		for i < len(ranks) && ranks[i] < n {
			values[i] = k
			i++
		}
	}
	return values
}

func EstimateV3Evidence(rows []V3ActivityEvidence, asOf time.Time, health []HealthRow) OfflineResult {
	var speeds []SpeedCandidate
	hr, power := map[float64]int{}, map[float64]int{}
	hrN, powerN := 0, 0
	var peaks []float64
	for _, e := range rows {
		speeds = append(speeds, e.Speeds...)
		var peak float64
		for k, n := range e.HR {
			hr[k] += n
			hrN += n
			peak = math.Max(peak, k)
		}
		peaks = append(peaks, peak)
		for k, n := range e.Power {
			power[k] += n
			powerN += n
		}
	}
	speed, sc, model := estimateThresholdSpeed(speeds, asOf)
	snap := Snapshot{
		AsOfDate:                 asOf,
		AlgorithmVersion:         ModelVersion,
		ThresholdSpeedMps:        round4(speed),
		ThresholdSpeedConfidence: sc,
		RHRBaseline:              round4(EstimateRHRBaseline(health, asOf)),
		HRMaxConfidence:          ConfidenceNone,
		ThresholdHRConfidence:    ConfidenceNone,
		CriticalSpeedMps:         model.CriticalSpeedMps,
		DPrimeM:                  model.DPrimeM,
		RiegelK:                  model.RiegelK,
		EnduranceIndex:           model.EnduranceIndex,
		SpeedIndex:               model.SpeedIndex,
		SpeedDurationConfidence:  model.Confidence,
	}
	var hrmax *float64
	if hrN > 0 {
		v := histogramRanks(hr, pyRound(float64(hrN-1)*0.98), hrN-1)
		hrmax = &v[1]
		snap.HighHRReference = round4(&v[0])
		snap.ObservedMaxHR = round4(hrmax)
		snap.HRMaxEstimate = round4(hrmax)
		near := 0
		for _, peak := range peaks {
			if peak >= *hrmax-3 {
				near++
			}
		}
		switch {
		case hrN >= 100 && near >= 2:
			snap.HRMaxConfidence = ConfidenceHigh
		case hrN >= 20:
			snap.HRMaxConfidence = ConfidenceMedium
		default:
			snap.HRMaxConfidence = ConfidenceLow
		}
	}
	if speed != nil {
		var cs []ThresholdHrCandidate
		for i := range rows {
			if c := rows[i].thresholdHR(*speed); c != nil {
				cs = append(cs, *c)
			}
		}
		h, conf := estimateThresholdHR(cs, hrmax, snap.HRMaxConfidence)
		snap.ThresholdHR = round4(h)
		snap.ThresholdHRConfidence = conf
	}
	if powerN > 0 {
		v := histogramRanks(power, (powerN-1)/2, powerN/2)
		median := (v[0] + v[1]) / 2
		snap.CriticalPowerW = round4(&median)
	}
	return OfflineResult{Strategy: StrategyV3, Implementation: "v3", ParameterVersion: "v3-frozen", Snapshot: snap}
}
