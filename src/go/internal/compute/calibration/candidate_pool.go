package calibration

import (
	"math"
	"sort"
	"time"
)

// CandidateMetadata contains admitted, activity-bound input evidence, never a
// held-out outcome. AvailableAt covers ALL fields, not just the watch samples.
// References are opaque audit identifiers; free text is deliberately not accepted.
type CandidateMetadata struct {
	HR                          *CandidateHRMetadata `json:"hr,omitempty"`
	ActivityID                  string               `json:"activity_id"`
	RootActivityID              string               `json:"root_activity_id,omitempty"`
	SourceVersion               string               `json:"source_version"`
	EvidenceRef                 string               `json:"evidence_ref,omitempty"`
	AvailableAt                 *time.Time           `json:"available_at,omitempty"`
	AvailabilityEvidence        string               `json:"availability_evidence,omitempty"`
	Protocol                    string               `json:"protocol,omitempty"`
	ProtocolVerified            bool                 `json:"protocol_verified,omitempty"`
	DurationS                   float64              `json:"duration_s,omitempty"`
	StartS                      *float64             `json:"start_s,omitempty"`
	EndS                        *float64             `json:"end_s,omitempty"`
	RaceIdentity                bool                 `json:"race_identity,omitempty"`
	AthleteReportedMaximal      bool                 `json:"athlete_reported_maximal,omitempty"`
	SustainedEffortCorroborated bool                 `json:"sustained_effort_corroborated,omitempty"`
	Submaximal                  bool                 `json:"submaximal,omitempty"`
	Interrupted                 bool                 `json:"interrupted,omitempty"`
	Device                      string               `json:"device,omitempty"`
	Terrain                     string               `json:"terrain,omitempty"`
	TemperatureC                *float64             `json:"temperature_c,omitempty"`
	HumidityPercent             *float64             `json:"humidity_percent,omitempty"`
	AscentM                     *float64             `json:"ascent_m,omitempty"`
	NotePresent                 bool                 `json:"note_present,omitempty"`
	FeelPresent                 bool                 `json:"feel_present,omitempty"`
}

type EffortSupport string

const (
	EffortConfirmedMaximal EffortSupport = "confirmed_maximal"
	EffortProbableMaximal  EffortSupport = "probable_maximal"
	EffortSubmaximal       EffortSupport = "submaximal"
	EffortUnknown          EffortSupport = "unknown"
)
const evidenceImplementation = "evidence_v1_v3_estimator"
const evidenceParameterVersion = "evidence-v1-conservative-research"

// CandidateEvidence describes one observation. Lower bounds apply ONLY at
// DurationS in the speed domain. Continuous=false records never constrain Vmax.
type CandidateEvidence struct {
	ActivityID                string         `json:"activity_id"`
	RootActivityID            string         `json:"root_activity_id"`
	ActivityDate              time.Time      `json:"activity_date"`
	DurationS                 float64        `json:"duration_s"`
	AvgSpeedMps               float64        `json:"avg_speed_mps"`
	StartS                    *float64       `json:"start_s,omitempty"`
	EndS                      *float64       `json:"end_s,omitempty"`
	MeasurementQuality        Confidence     `json:"measurement_quality"`
	Quality                   SegmentQuality `json:"quality"`
	EffortSupport             EffortSupport  `json:"effort_support"`
	SupportReasons            []string       `json:"support_reasons"`
	CounterReasons            []string       `json:"counter_reasons"`
	SourceVersion             string         `json:"source_version"`
	EvidenceRef               string         `json:"evidence_ref,omitempty"`
	Source                    string         `json:"source"`
	Device                    string         `json:"device"`
	Terrain                   string         `json:"terrain"`
	TemperatureC              *float64       `json:"temperature_c,omitempty"`
	HumidityPercent           *float64       `json:"humidity_percent,omitempty"`
	AscentM                   *float64       `json:"ascent_m,omitempty"`
	DeclaredActivityDurationS *float64       `json:"declared_activity_duration_s,omitempty"`
	FullActivity              bool           `json:"full_activity"`
	Continuous                bool           `json:"continuous"`
	DurationClass             string         `json:"duration_class"`
	ObservedLowerBoundMps     float64        `json:"observed_lower_bound_mps,omitempty"`
	AgeDays                   float64        `json:"age_days"`
	SelectionScore            float64        `json:"selection_score"`
	Selected                  bool           `json:"selected"`
	SelectionReason           string         `json:"selection_reason"`
	Contribution              float64        `json:"contribution"`
}
type CandidateEvidenceReport struct {
	HR                    *CandidateHRReport            `json:"hr,omitempty"`
	Hour                  *HourCapabilityReport         `json:"hour,omitempty"`
	ParameterVersion      string                        `json:"parameter_version"`
	Candidates            []CandidateEvidence           `json:"candidates"`
	Diagnostics           []CandidateActivityDiagnostic `json:"diagnostics"`
	Excluded              map[string]int                `json:"excluded"`
	IndependentActivities int                           `json:"independent_activities"`
	IndependentDays       int                           `json:"independent_days"`
	TotalContribution     float64                       `json:"total_contribution"`
	Limitations           []string                      `json:"limitations"`
}

// BuildCandidateEvidence is the offline pure T3 boundary. Selection is aged
// before truncation; measurements and effort assertions are separate channels.
func BuildCandidateEvidence(history []Activity, metadata []CandidateMetadata, asOf time.Time) CandidateEvidenceReport {
	return buildCandidateEvidence(history, metadata, asOf, asOf)
}

func buildCandidateEvidence(history []Activity, metadata []CandidateMetadata, asOf, metadataCutoff time.Time) CandidateEvidenceReport {
	out := CandidateEvidenceReport{ParameterVersion: evidenceParameterVersion, Excluded: map[string]int{}, Limitations: []string{"research_parameters_not_independently_calibrated", "unlinked_cross_device_duplicates_may_remain", "environment_not_corrected"}}
	meta, excluded := admittedCandidateMetadata(metadata, metadataCutoff)
	for reason, n := range excluded {
		out.Excluded[reason] += n
	}
	// Sort identities and content hashes so duplicate handling is input-order independent.
	activities := append([]Activity(nil), history...)
	sort.Slice(activities, func(i, j int) bool {
		if activities[i].LabelID != activities[j].LabelID {
			return activities[i].LabelID < activities[j].LabelID
		}
		return ReplayContentHash(activities[i]) < ReplayContentHash(activities[j])
	})
	seen := map[string]bool{}
	for _, a := range activities {
		if a.LabelID == "" || a.ActivityDate.IsZero() || !isRunning(a) {
			out.Excluded["activity_identity_date_or_sport_missing"]++
			continue
		}
		if !inClosedRange(a.ActivityDate, asOf.AddDate(0, 0, -180), asOf) {
			out.Excluded["activity_outside_window"]++
			continue
		}
		if seen[a.LabelID] {
			out.Excluded["duplicate_activity"]++
			continue
		}
		seen[a.LabelID] = true
		m, hasMeta := meta[a.LabelID]
		if !hasMeta {
			m = CandidateMetadata{ActivityID: a.LabelID, SourceVersion: "unavailable"}
		}
		root := m.RootActivityID
		if root == "" {
			root = a.LabelID
		}
		durations := append([]int(nil), BestEffortDurationsS...)
		durations = append(durations, 4500, 5400, 7200)
		measurements := BuildCandidateSegments([]Activity{a}, durations)
		out.Diagnostics = append(out.Diagnostics, measurements.Diagnostics...)
		if protocol := candidateVerifiedWindow(a, m); protocol != nil {
			duplicate := false
			for _, c := range measurements.Candidates {
				if c.StartS != nil && c.EndS != nil && *c.StartS == *protocol.StartS && *c.EndS == *protocol.EndS {
					duplicate = true
					break
				}
			}
			if !duplicate {
				measurements.Candidates = append(measurements.Candidates, *protocol)
			}
		}
		// A complete elapsed observation is kept even when it cannot be a continuous
		// effort. Never concatenate work repetitions or bypass a continuity rejection.
		fullDuration := candidateFullDuration(a)
		fullIndex := -1
		if fullDuration > 0 {
			full := buildCandidateSegmentsFloat([]Activity{a}, []float64{fullDuration})
			// A standard window is the complete activity only if it spans the
			// actual whole recording, without reconstructing missing endpoints.
			fullContinuous := len(full.Candidates) > 0 && len(full.Diagnostics) > 0 && len(full.Diagnostics[0].Breaks) == 0 && math.Abs(candidateClockDuration(a)-fullDuration) < 1e-6
			if fullContinuous {
				c := full.Candidates[0]
				for i, v := range measurements.Candidates {
					if math.Abs(v.DurationS-fullDuration) < 1e-6 {
						fullIndex = i
						break
					}
				}
				if fullIndex < 0 {
					fullIndex = len(measurements.Candidates)
					measurements.Candidates = append(measurements.Candidates, c)
				}
			} else if candidateFinite(a.DistanceM) && *a.DistanceM > 0 && *a.DistanceM/fullDuration <= 8.5 {
				fullIndex = len(measurements.Candidates)
				measurements.Candidates = append(measurements.Candidates, CandidateSegment{SpeedCandidate: SpeedCandidate{Activity: a, DurationS: fullDuration, AvgSpeedMps: *a.DistanceM / fullDuration, Source: "full_activity_elapsed", Confidence: ConfidenceLow}, Quality: SegmentQuality{TimeBasis: "summary_elapsed", Reasons: []string{"full_activity_continuity_not_supported"}}})
			}
		}
		for index, c := range measurements.Candidates {
			e := CandidateEvidence{ActivityID: a.LabelID, RootActivityID: root, ActivityDate: a.ActivityDate, DurationS: c.DurationS, AvgSpeedMps: c.AvgSpeedMps, StartS: c.StartS, EndS: c.EndS, MeasurementQuality: c.Confidence, Quality: c.Quality, Source: c.Source, SourceVersion: m.SourceVersion, EvidenceRef: m.EvidenceRef, Device: m.Device, Terrain: m.Terrain, TemperatureC: m.TemperatureC, HumidityPercent: m.HumidityPercent, AscentM: m.AscentM, DeclaredActivityDurationS: a.DurationS, FullActivity: index == fullIndex, Continuous: c.Source == "timeseries", DurationClass: "continuous", AgeDays: float64(dayDiff(asOf, a.ActivityDate))}
			// Without a trustworthy mapping of provider pauses to this sample clock,
			// none of the windows can claim uninterrupted measurement.
			if m.Interrupted {
				e.Continuous = false
			}
			if e.Device == "" {
				e.Device = "unknown"
			}
			if e.Terrain == "" {
				e.Terrain = "unknown"
			}
			if !e.Continuous {
				e.DurationClass = "continuity_unverified"
			}
			if e.FullActivity && !e.Continuous && len(measurements.Diagnostics) > 0 && len(measurements.Diagnostics[0].Breaks) > 0 {
				e.DurationClass = "mixed_recovery"
			}
			if c.DurationS > 7200 {
				e.DurationClass = "ultra_endurance"
			}
			classifyCandidateEffort(&e, m)
			if e.Continuous && e.AvgSpeedMps > 0 {
				e.ObservedLowerBoundMps = e.AvgSpeedMps * .9
			}
			quality := map[Confidence]float64{ConfidenceHigh: 1, ConfidenceMedium: .7, ConfidenceLow: .3}[e.MeasurementQuality]
			effort := map[EffortSupport]float64{EffortConfirmedMaximal: 1, EffortProbableMaximal: .7, EffortSubmaximal: .35, EffortUnknown: .2}[e.EffortSupport]
			e.SelectionScore = e.AvgSpeedMps * quality * effort * math.Exp2(-e.AgeDays/90)
			out.Candidates = append(out.Candidates, e)
		}
	}
	selectCandidateEvidence(&out)
	return out
}

func candidateFullDuration(a Activity) float64 {
	clockDuration := candidateClockDuration(a)
	// Preserve the complete declared activity when the stream is truncated.
	// Otherwise elapsed is the recorded full clock, never the watch moving
	// duration; both declared duration and measured elapsed are retained.
	if candidateFinite(a.DurationS) && *a.DurationS > 0 {
		if clockDuration <= 0 || *a.DurationS-clockDuration > candidateMaxGapS {
			return *a.DurationS
		}
	}
	return clockDuration
}

func candidateClockDuration(a Activity) float64 {
	// Never add durations across clock restarts or concatenate repetitions.
	if len(a.Samples) >= 2 {
		useTimestamp := 0
		for _, s := range a.Samples {
			if candidateFinite(s.TimestampS) {
				useTimestamp++
			}
		}
		var first, last *float64
		for _, s := range a.Samples {
			p := s.ElapsedS
			if useTimestamp >= 2 {
				p = s.TimestampS
			}
			if candidateFinite(p) {
				if first == nil {
					first = p
				}
				last = p
			}
		}
		if first != nil && last != nil && *last > *first {
			return *last - *first
		}
	}
	return 0
}
func classifyCandidateEffort(e *CandidateEvidence, m CandidateMetadata) {
	e.EffortSupport = EffortUnknown
	e.CounterReasons = []string{}
	if m.Interrupted {
		e.CounterReasons = append(e.CounterReasons, "activity_interruption_window_mapping_unverified")
	}
	if m.NotePresent {
		e.CounterReasons = append(e.CounterReasons, "free_text_not_verified_effort")
	}
	if m.FeelPresent {
		e.CounterReasons = append(e.CounterReasons, "feel_alone_not_effort_evidence")
	}
	if m.RaceIdentity {
		e.SupportReasons = append(e.SupportReasons, "activity_bound_race_identity")
	}
	if m.AthleteReportedMaximal {
		e.SupportReasons = append(e.SupportReasons, "activity_bound_maximal_report")
	}
	if m.SustainedEffortCorroborated {
		e.SupportReasons = append(e.SupportReasons, "sustained_effort_corroborated")
	}
	switch {
	case m.Submaximal:
		e.EffortSupport = EffortSubmaximal
		e.CounterReasons = append(e.CounterReasons, "explicit_submaximal")
	case m.Interrupted || !e.Continuous:
		e.CounterReasons = append(e.CounterReasons, "continuous_effort_not_verified")
	case m.Protocol == "continuous_maximal_test_v1" && m.ProtocolVerified && m.EvidenceRef != "" && m.SourceVersion != "unavailable" && candidateWindowMatches(*e, m):
		e.EffortSupport = EffortConfirmedMaximal
		e.SupportReasons = append(e.SupportReasons, "verified_maximal_protocol_exact_window")
	case m.RaceIdentity && m.AthleteReportedMaximal && m.SustainedEffortCorroborated && e.FullActivity:
		e.EffortSupport = EffortProbableMaximal
	default:
		e.CounterReasons = append(e.CounterReasons, "maximal_effort_not_proven_for_window")
	}
}
func candidateWindowMatches(e CandidateEvidence, m CandidateMetadata) bool {
	return m.StartS != nil && m.EndS != nil && e.StartS != nil && e.EndS != nil && math.Abs(m.DurationS-e.DurationS) < 1e-6 && math.Abs(*m.StartS-*e.StartS) < 1e-6 && math.Abs(*m.EndS-*e.EndS) < 1e-6
}

// A root has one domain civil day. Without independently trusted root-day
// metadata, contradictory aliases cannot be arbitrarily assigned to one date.
// Keep every observation for audit, but reject that entire root from support.
func conflictingCandidateRootDays(evidence []CandidateEvidence) map[string]bool {
	days := map[string]string{}
	conflicts := map[string]bool{}
	for _, e := range evidence {
		root := candidateRootID(e)
		if root == "" || e.ActivityDate.IsZero() {
			continue
		}
		day := e.ActivityDate.Format("2006-01-02")
		if prior, ok := days[root]; ok && prior != day {
			conflicts[root] = true
		}
		days[root] = day
	}
	return conflicts
}
func candidateRootID(e CandidateEvidence) string {
	if e.RootActivityID != "" {
		return e.RootActivityID
	}
	return e.ActivityID
}
func selectCandidateEvidence(out *CandidateEvidenceReport) {
	conflicts := conflictingCandidateRootDays(out.Candidates)
	if len(conflicts) > 0 {
		out.Excluded["root_activity_day_conflict"] = len(conflicts)
	}
	sort.Slice(out.Candidates, func(i, j int) bool {
		a, b := out.Candidates[i], out.Candidates[j]
		if a.DurationS != b.DurationS {
			return a.DurationS < b.DurationS
		}
		if a.SelectionScore != b.SelectionScore {
			return a.SelectionScore > b.SelectionScore
		}
		return a.ActivityID < b.ActivityID
	})
	counts := map[float64]int{}
	rootsByDuration := map[float64]map[string]bool{}
	rootCounts := map[string]int{}
	rootDays := map[string]string{}
	for i := range out.Candidates {
		e := &out.Candidates[i]
		e.SelectionReason = "duration_pool_limit"
		if conflicts[candidateRootID(*e)] {
			e.SelectionReason = "root_activity_day_conflict"
			e.CounterReasons = append(e.CounterReasons, "root_activity_day_conflict")
			continue
		}
		if !e.Continuous {
			e.SelectionReason = "noncontinuous_observation_only"
			continue
		}
		if rootsByDuration[e.DurationS] == nil {
			rootsByDuration[e.DurationS] = map[string]bool{}
		}
		if rootsByDuration[e.DurationS][e.RootActivityID] {
			e.SelectionReason = "overlapping_root_duration"
			continue
		}
		if counts[e.DurationS] >= 3 {
			continue
		}
		rootsByDuration[e.DurationS][e.RootActivityID] = true
		counts[e.DurationS]++
		rootCounts[e.RootActivityID]++
		rootDays[e.RootActivityID] = e.ActivityDate.Format("2006-01-02")
		e.Selected = true
		e.SelectionReason = "quality_effort_age_rank"
	}
	days := map[string]int{}
	for _, d := range rootDays {
		days[d]++
	}
	for i := range out.Candidates {
		e := &out.Candidates[i]
		if e.Selected {
			e.Contribution = 1 / float64(rootCounts[e.RootActivityID]) / float64(days[rootDays[e.RootActivityID]])
			out.TotalContribution += e.Contribution
		}
	}
	out.IndependentActivities = len(rootCounts)
	out.IndependentDays = len(days)
}

// Retain the exact verified window BEFORE ranking the same-root/duration pool.
// A faster unknown window must not erase an activity-bound protocol observation.
func candidateVerifiedWindow(a Activity, m CandidateMetadata) *CandidateSegment {
	if !m.ProtocolVerified || m.Protocol != "continuous_maximal_test_v1" || m.EvidenceRef == "" || !candidateFinite(m.StartS) || !candidateFinite(m.EndS) || m.DurationS <= 0 || math.Abs(*m.EndS-*m.StartS-m.DurationS) > 1e-6 {
		return nil
	}
	diag := CandidateActivityDiagnostic{ActivityID: a.LabelID}
	series := prepareCandidateSeries(a.Samples, &diag)
	reconcileCandidateActivity(a, series, &diag)
	for _, p := range series {
		if len(p.points) >= 2 && *m.StartS >= p.points[0].t && *m.EndS <= p.points[len(p.points)-1].t {
			return measureCandidateWindow(a, p, *m.StartS, *m.EndS, m.DurationS, &diag)
		}
	}
	return nil
}

func admittedCandidateMetadata(metadata []CandidateMetadata, metadataCutoff time.Time) (map[string]CandidateMetadata, map[string]int) {
	excluded := map[string]int{}
	meta := map[string]CandidateMetadata{}
	conflicting := map[string]bool{}
	for _, m := range metadata {
		if m.ActivityID == "" || m.SourceVersion == "" {
			excluded["metadata_identity_or_version_missing"]++
			continue
		}
		if m.AvailableAt != nil && m.AvailableAt.After(metadataCutoff) {
			excluded["metadata_late_available"]++
			continue
		}
		if prior, ok := meta[m.ActivityID]; ok && ReplayContentHash(prior) != ReplayContentHash(m) {
			conflicting[m.ActivityID] = true
		}
		meta[m.ActivityID] = m
	}
	for id := range conflicting {
		delete(meta, id)
		excluded["conflicting_metadata"]++
	}
	return meta, excluded
}
