package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"reflect"
	"time"
)

// CalibrationValues is the actual frozen numeric input, independent of mutable
// snapshot IDs. It is calibration lineage, not a raw-data replay event log.
type CalibrationValues struct {
	ThresholdSpeedMps *float64                     `json:"threshold_speed_mps"`
	ThresholdHR       *float64                     `json:"threshold_hr"`
	HRMaxEstimate     *float64                     `json:"hrmax_estimate"`
	RHRBaseline       *float64                     `json:"rhr_baseline"`
	CriticalPowerW    *float64                     `json:"critical_power_w"`
	PaceZones         []RunningCalibrationPaceZone `json:"pace_zones,omitempty"`
	HRZones           []RunningCalibrationHRZone   `json:"hr_zones,omitempty"`
}
type CalibrationInput struct {
	SnapshotID       uint64                    `json:"snapshot_id"`
	AsOfDate         string                    `json:"as_of_date"`
	AlgorithmVersion int                       `json:"algorithm_version"`
	Selection        CalibrationSelection      `json:"selection"`
	Fingerprint      string                    `json:"fingerprint"`
	ValuesUsed       CalibrationValues         `json:"values_used"`
	Source           calibration.SourceSummary `json:"source"`
}
type CalibrationSeed struct {
	Date             string  `json:"date"`
	AcuteLoad        float64 `json:"acute_load"`
	ChronicLoad      float64 `json:"chronic_load"`
	ProvenanceDigest string  `json:"provenance_digest,omitempty"`
	State            string  `json:"state"`
}
type CalibrationProvenance struct {
	SchemaVersion int                `json:"schema_version"`
	WrittenAt     time.Time          `json:"written_at"`
	OutputDigest  string             `json:"output_digest"`
	Inputs        []CalibrationInput `json:"inputs"`
	Seed          *CalibrationSeed   `json:"seed,omitempty"`
}

func (b CalibrationBundle) FrozenInput() CalibrationInput {
	out := CalibrationInput{Selection: b.Selection, Fingerprint: b.Fingerprint, Source: b.Source}
	if s := b.Snapshot; s != nil {
		out.SnapshotID = s.ID
		out.AsOfDate = s.AsOfDate
		out.AlgorithmVersion = s.AlgorithmVersion
		out.ValuesUsed = CalibrationValues{ThresholdSpeedMps: s.ThresholdSpeedMps, ThresholdHR: s.ThresholdHR, HRMaxEstimate: s.HRMaxEstimate, RHRBaseline: s.RHRBaseline, CriticalPowerW: s.CriticalPowerW, PaceZones: b.PaceZones, HRZones: b.HRZones}
	}
	return out
}
func provenanceRow(row any) reflect.Value {
	v := reflect.ValueOf(row)
	if v.Kind() == reflect.Pointer {
		v = v.Elem()
	}
	return v
}

// rowDigest includes computed_at as well as output fields, so an old binary
// touching a row while retaining an unknown provenance column cannot certify it.
func rowDigest(row any) (string, error) {
	v := provenanceRow(row)
	if v.Kind() != reflect.Struct {
		return "", fmt.Errorf("provenance requires derived row")
	}
	t := v.Type()
	fields := map[string]any{}
	for i := 0; i < v.NumField(); i++ {
		name := t.Field(i).Name
		if name == "CalibrationProvenanceJSON" || name == "ID" {
			continue
		}
		fields[name] = v.Field(i).Interface()
	}
	raw, err := json.Marshal(fields)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
func FreezeCalibrationProvenance(row any, inputs []CalibrationInput, seed *CalibrationSeed) error {
	v := provenanceRow(row)
	f := v.FieldByName("CalibrationProvenanceJSON")
	if !f.IsValid() || !f.CanSet() {
		return fmt.Errorf("unsupported provenance row")
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	if date := v.FieldByName("ComputedAt"); date.IsValid() {
		date.Set(reflect.ValueOf(now))
	}
	digest, err := rowDigest(row)
	if err != nil {
		return err
	}
	p := CalibrationProvenance{SchemaVersion: 1, WrittenAt: now, OutputDigest: digest, Inputs: inputs, Seed: seed}
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	text := string(raw)
	f.Set(reflect.ValueOf(&text))
	return nil
}

// ReadCalibrationProvenance never joins a mutable current snapshot to backfill
// old sources. Missing or stale metadata stays explicitly unavailable.
func ReadCalibrationProvenance(row any) (CalibrationProvenance, string) {
	var out CalibrationProvenance
	v := provenanceRow(row)
	f := v.FieldByName("CalibrationProvenanceJSON")
	if !f.IsValid() || f.IsNil() {
		return out, "legacy_provenance_unavailable"
	}
	text := f.Interface().(*string)
	if json.Unmarshal([]byte(*text), &out) != nil || out.SchemaVersion != 1 {
		return CalibrationProvenance{}, "legacy_or_stale_provenance"
	}
	digest, err := rowDigest(row)
	if err != nil || digest != out.OutputDigest {
		return CalibrationProvenance{}, "legacy_or_stale_provenance"
	}
	return out, "available"
}
