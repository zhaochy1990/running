package calibrationsource

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// PublicDataReport is a local research diagnostic, never an accuracy or rollout gate.
// Records may contain source identifiers and must stay alongside the local input.
type PublicDataReport struct {
	SchemaVersion     int                  `json:"schema_version"`
	Format            string               `json:"format"`
	SourceSHA256      string               `json:"source_sha256"`
	LabelsSHA256      string               `json:"labels_sha256,omitempty"`
	CodeVersion       string               `json:"code_version"`
	Strategy          calibration.Strategy `json:"strategy"`
	Implementation    string               `json:"implementation"`
	ParameterVersion  string               `json:"parameter_version"`
	Status            string               `json:"status"`
	ReleaseReady      bool                 `json:"release_ready"`
	Limitations       []string             `json:"limitations"`
	Records           []PublicRecord       `json:"records"`
	LabelCount        int                  `json:"label_count"`
	LabelSpeedPresent int                  `json:"label_speed_present"`
	LabelHRPresent    int                  `json:"label_hr_present"`
	MatchedLabels     int                  `json:"matched_labels"`
}

type PublicRecord struct {
	// Samples contains only observed timed measurements, for offline pure-domain checks.
	// It is excluded from JSON to avoid redistributing source streams.
	Samples              []calibration.Sample       `json:"-"`
	SourceID             string                     `json:"source_id"`
	SampleCount          int                        `json:"sample_count"`
	MissingHR            int                        `json:"missing_hr"`
	MissingSpeed         int                        `json:"missing_speed"`
	MissingDistance      int                        `json:"missing_distance"`
	InvalidValues        int                        `json:"invalid_values"`
	HRAbove220           int                        `json:"hr_above_220"`
	TimeOrderRegressions int                        `json:"time_order_regressions"`
	DuplicateTimes       int                        `json:"duplicate_times"`
	DistanceRegressions  int                        `json:"distance_regressions"`
	SourceStartS         *float64                   `json:"source_start_s,omitempty"`
	DurationS            *float64                   `json:"duration_s,omitempty"`
	MaxGapS              float64                    `json:"max_gap_s"`
	MeasurementKind      string                     `json:"measurement_kind"`
	LabelKind            string                     `json:"label_kind"`
	Estimate             *calibration.OfflineResult `json:"estimate,omitempty"`
	EstimateOmitted      string                     `json:"estimate_omitted,omitempty"`
}

// InspectPublicData parses local bytes only. It never fetches data or opens a DB.
// Missing measurements stay nil; stage summaries never become synthetic samples.
func InspectPublicData(format string, raw, labels []byte, strategy calibration.Strategy, code string) (PublicDataReport, error) {
	if code == "" {
		return PublicDataReport{}, fmt.Errorf("code version is required")
	}
	identity, err := calibration.EstimateOffline(strategy, nil, time.Time{}, nil)
	if err != nil {
		return PublicDataReport{}, err
	}
	report := PublicDataReport{SchemaVersion: 1, Format: format, SourceSHA256: fmt.Sprintf("%x", sha256.Sum256(raw)), CodeVersion: code, Strategy: strategy, Implementation: identity.Implementation, ParameterVersion: identity.ParameterVersion, Status: "insufficient", Limitations: []string{"Local parser/estimator smoke checks only; no independent historical holdout, accuracy claim, or release evidence."}}
	if len(labels) > 0 && format != "trinity-stage-csv" {
		return report, fmt.Errorf("labels not supported for format %q", format)
	}
	switch format {
	case "trinity-stage-csv":
		err = inspectTrinity(raw, labels, &report)
	case "osf-60min-csv":
		err = inspectOSF(raw, &report)
	case "fitrec-jsonl":
		err = inspectFitRec(raw, strategy, &report)
	default:
		err = fmt.Errorf("unknown public data format %q", format)
	}
	if err != nil {
		return PublicDataReport{}, err
	}
	if len(report.Records) == 0 {
		return PublicDataReport{}, fmt.Errorf("no records")
	}
	return report, nil
}

func inspectFitRec(raw []byte, strategy calibration.Strategy, report *PublicDataReport) error {
	report.Limitations = append(report.Limitations, "FitRec effort unknown; no device speed/distance; GPS is not converted into device measurements. Each activity is an isolated smoke check, not athlete-history validation.")
	seen := map[string]bool{}
	for lineNo, line := range bytes.Split(raw, []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var row struct {
			ID        json.Number `json:"id"`
			UserID    json.Number `json:"userId"`
			Sport     string      `json:"sport"`
			Timestamp []float64   `json:"timestamp"`
			HR        []*float64  `json:"heart_rate"`
		}
		if err := json.Unmarshal(line, &row); err != nil {
			return fmt.Errorf("line %d: %w", lineNo+1, err)
		}
		id := row.UserID.String() + "/" + row.ID.String()
		if row.ID == "" || row.UserID == "" || row.Sport != "run" || len(row.Timestamp) == 0 || len(row.Timestamp) != len(row.HR) {
			return fmt.Errorf("line %d: require running identity and aligned nonempty timestamps/HR", lineNo+1)
		}
		if seen[id] {
			return fmt.Errorf("duplicate source activity %q", id)
		}
		seen[id] = true
		record := PublicRecord{SourceID: id, SampleCount: len(row.Timestamp), MeasurementKind: "sparse_observed_timestamp_hr", LabelKind: "none"}
		samples := make([]calibration.Sample, len(row.Timestamp))
		for i, t := range row.Timestamp {
			if t <= 0 || math.IsNaN(t) || math.IsInf(t, 0) {
				return fmt.Errorf("invalid timestamp")
			}
			samples[i] = calibration.Sample{TimestampS: ptr(t), HeartRateBpm: validMeasurement(row.HR[i], true, &record)}
			if i > 0 && t < row.Timestamp[i-1] {
				record.TimeOrderRegressions++
			}
		}
		inspectSamples(samples, &record)
		record.Samples = samples
		day := timefmt.ShanghaiDay(time.Unix(int64(*record.SourceStartS), 0))
		activity := calibration.Activity{LabelID: id, ActivityDate: day, Sport: "run", Samples: samples, DurationS: record.DurationS}
		estimate, err := calibration.EstimateOffline(strategy, []calibration.Activity{activity}, day, nil)
		if err != nil {
			return err
		}
		record.Estimate = &estimate
		report.Records = append(report.Records, record)
	}
	return nil
}

func ptr(v float64) *float64 { return &v }
func validMeasurement(v *float64, positive bool, r *PublicRecord) *float64 {
	if v != nil && (math.IsNaN(*v) || math.IsInf(*v, 0) || *v < 0 || (positive && *v == 0)) {
		r.InvalidValues++
		return nil
	}
	return v
}
func inspectSamples(samples []calibration.Sample, r *PublicRecord) {
	sort.SliceStable(samples, func(i, j int) bool { return *samples[i].TimestampS < *samples[j].TimestampS })
	start := *samples[0].TimestampS
	r.SourceStartS = ptr(start)
	r.DurationS = ptr(*samples[len(samples)-1].TimestampS - start)
	for i := range samples {
		s := &samples[i]
		elapsed := *s.TimestampS - start
		s.ElapsedS = ptr(elapsed)
		if s.HeartRateBpm == nil {
			r.MissingHR++
		} else if *s.HeartRateBpm > 220 {
			r.HRAbove220++
		}
		if s.SpeedMps == nil {
			r.MissingSpeed++
		}
		if s.DistanceM == nil {
			r.MissingDistance++
		}
		if i > 0 {
			gap := *s.TimestampS - *samples[i-1].TimestampS
			if gap == 0 {
				r.DuplicateTimes++
			}
			if gap > r.MaxGapS {
				r.MaxGapS = gap
			}
			if s.DistanceM != nil && samples[i-1].DistanceM != nil && *s.DistanceM < *samples[i-1].DistanceM {
				r.DistanceRegressions++
			}
		}
	}
}

func csvRows(raw []byte, required ...string) ([][]string, map[string]int, error) {
	rows, err := csv.NewReader(bytes.NewReader(raw)).ReadAll()
	if err != nil {
		return nil, nil, err
	}
	if len(rows) < 2 {
		return nil, nil, fmt.Errorf("CSV requires header and data")
	}
	columns := map[string]int{}
	for i, name := range rows[0] {
		if _, exists := columns[name]; exists {
			return nil, nil, fmt.Errorf("duplicate column %q", name)
		}
		columns[name] = i
	}
	for _, name := range required {
		if _, ok := columns[name]; !ok {
			return nil, nil, fmt.Errorf("missing column %q", name)
		}
	}
	return rows[1:], columns, nil
}
func csvNumber(s string) (*float64, error) {
	if s == "" {
		return nil, nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return nil, fmt.Errorf("invalid finite number %q", s)
	}
	return ptr(v), nil
}
func inspectOSF(raw []byte, report *PublicDataReport) error {
	rows, c, err := csvRows(raw, "participant", "source_elapsed_s", "distance_m", "speed_mps", "five_min_bin")
	if err != nil {
		return err
	}
	report.Limitations = append(report.Limitations, "OSF 60-minute near-maximal protocol; raw speed/distance only, no point HR or observed calendar date/prior history. No interpolation, clipping to 3600s, or accuracy evaluation against this same input.")
	groups := map[string][]calibration.Sample{}
	indices := map[string]int{}
	for i, row := range rows {
		id := row[c["participant"]]
		if id == "" {
			return fmt.Errorf("row %d: missing participant", i+2)
		}
		t, err := csvNumber(row[c["source_elapsed_s"]])
		if err != nil || t == nil || *t < 0 {
			return fmt.Errorf("row %d: invalid source clock", i+2)
		}
		d, err := csvNumber(row[c["distance_m"]])
		if err != nil {
			return err
		}
		v, err := csvNumber(row[c["speed_mps"]])
		if err != nil {
			return err
		}
		idx, exists := indices[id]
		if !exists {
			idx = len(report.Records)
			indices[id] = idx
			report.Records = append(report.Records, PublicRecord{SourceID: id, MeasurementKind: "observed_continuous_speed_distance", LabelKind: "near_maximal_test_protocol_not_independent_holdout", EstimateOmitted: "no observed calendar dates or pre-test history; not a chronological calibration evaluation"})
		}
		r := &report.Records[idx]
		prior := groups[id]
		if len(prior) > 0 && *t < *prior[len(prior)-1].TimestampS {
			r.TimeOrderRegressions++
		}
		groups[id] = append(prior, calibration.Sample{TimestampS: t, DistanceM: validMeasurement(d, false, r), SpeedMps: validMeasurement(v, false, r)})
	}
	for id, idx := range indices {
		r := &report.Records[idx]
		r.SampleCount = len(groups[id])
		inspectSamples(groups[id], r)
		r.Samples = groups[id]
	}
	return nil
}

func inspectTrinity(raw, labels []byte, report *PublicDataReport) error {
	rows, c, err := csvRows(raw, "test_id", "stage_index", "speed_kmh", "hr_bpm", "vo2_ml_kg_min", "lactate_mmol_l", "duration_s", "hr_aggregation", "lactate_sample_offset_s", "duration_source")
	if err != nil {
		return err
	}
	report.Limitations = append(report.Limitations, "Trinity stage means only: HR last-minute average, lactate sampled at 120s, 180s duration from protocol (not measured sample times). No continuous samples, calendar dates, or asserted independent participants. Author lactate breakpoint is not LTHR, LT2, MLSS or 60-minute ground truth.")
	indices := map[string]int{}
	seen := map[string]bool{}
	for i, row := range rows {
		id := row[c["test_id"]]
		stage, err := strconv.Atoi(row[c["stage_index"]])
		if id == "" || err != nil || stage < 0 {
			return fmt.Errorf("row %d: invalid test/stage identity", i+2)
		}
		key := fmt.Sprintf("%s/%d", id, stage)
		if seen[key] {
			return fmt.Errorf("duplicate stage %q", key)
		}
		seen[key] = true
		if row[c["hr_aggregation"]] != "last_minute_stage_mean" || row[c["duration_source"]] != "published_protocol_not_recorded_sample_times" {
			return fmt.Errorf("row %d: unsupported stage measurement semantics", i+2)
		}
		duration, err := csvNumber(row[c["duration_s"]])
		if err != nil || duration == nil || *duration != 180 {
			return fmt.Errorf("row %d: unsupported protocol duration", i+2)
		}
		offset, err := csvNumber(row[c["lactate_sample_offset_s"]])
		if err != nil || offset == nil || *offset != 120 {
			return fmt.Errorf("row %d: unsupported lactate timing", i+2)
		}
		idx, exists := indices[id]
		if !exists {
			idx = len(report.Records)
			indices[id] = idx
			report.Records = append(report.Records, PublicRecord{SourceID: id, MeasurementKind: "stage_aggregate_not_timeseries", LabelKind: "none", EstimateOmitted: "stage aggregates cannot supply continuous observed samples or dated history"})
		}
		r := &report.Records[idx]
		r.SampleCount++
		r.MissingDistance++
		hr, err := csvNumber(row[c["hr_bpm"]])
		if err != nil {
			return err
		}
		hr = validMeasurement(hr, true, r)
		if hr == nil {
			r.MissingHR++
		} else if *hr > 220 {
			r.HRAbove220++
		}
		speed, err := csvNumber(row[c["speed_kmh"]])
		if err != nil {
			return err
		}
		if validMeasurement(speed, false, r) == nil {
			r.MissingSpeed++
		}
		for _, name := range []string{"vo2_ml_kg_min", "lactate_mmol_l"} {
			value, err := csvNumber(row[c[name]])
			if err != nil {
				return err
			}
			validMeasurement(value, false, r)
		}
	}
	if len(labels) == 0 {
		return nil
	}
	var annotations []struct {
		TestID     string `json:"test_id"`
		LabelType  string `json:"label_type"`
		Speed      string `json:"speed_kmh"`
		HR         string `json:"hr_bpm"`
		SourceHash string `json:"source_test_sha256"`
		Not60min   bool   `json:"not_60min_ground_truth"`
	}
	if err := json.Unmarshal(labels, &annotations); err != nil {
		return err
	}
	report.LabelsSHA256 = fmt.Sprintf("%x", sha256.Sum256(labels))
	labelIDs := map[string]bool{}
	for _, a := range annotations {
		if a.TestID == "" || labelIDs[a.TestID] || a.LabelType != "lab_lactate_breakpoint_segmented_regression" || !a.Not60min || a.SourceHash == "" {
			return fmt.Errorf("invalid/duplicate Trinity author label")
		}
		labelIDs[a.TestID] = true
		for _, value := range []string{a.Speed, a.HR} {
			if _, err := csvNumber(value); err != nil {
				return err
			}
		}
		if a.Speed != "" {
			report.LabelSpeedPresent++
		}
		if a.HR != "" {
			report.LabelHRPresent++
		}
		report.LabelCount++
		if idx, exists := indices[a.TestID]; exists {
			report.MatchedLabels++
			report.Records[idx].LabelKind = "lab_lactate_breakpoint_not_lthr_lt2_mlss_or_60min"
		}
	}
	return nil
}
