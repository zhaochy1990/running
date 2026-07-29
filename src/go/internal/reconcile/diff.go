// Package reconcile compares the Go-written MySQL shadow store against the
// Python SQLite store, field by field, with typed tolerances (exact for
// ids/enums/ints, epsilon for floats). It is the engine behind cmd/reconcile
// (ADR 0005). The engine is pure and DB-agnostic: readers hand it row maps.
package reconcile

import (
	"fmt"
	"math"
	"sort"
)

// Kind selects how a field is compared.
type Kind int

const (
	// Exact requires equal values (ids, enums, ints, strings).
	Exact Kind = iota
	// Float allows |a-b| <= Tol (distance/pace/speed/GPS: Python vs Go rounding).
	Float
)

// Field describes one comparable column.
type Field struct {
	Name string
	Kind Kind
	Tol  float64 // used when Kind == Float
}

// Row is one record keyed by field name. Values are nil, float64, int64, or string.
type Row map[string]any

// Mismatch is a single divergence between the two stores.
type Mismatch struct {
	Key    string // row key (label_id)
	Field  string // "" for a whole-row presence mismatch
	Detail string
}

func (m Mismatch) String() string {
	if m.Field == "" {
		return fmt.Sprintf("%s: %s", m.Key, m.Detail)
	}
	return fmt.Sprintf("%s.%s: %s", m.Key, m.Field, m.Detail)
}

// Diff compares left (e.g. SQLite) and right (e.g. MySQL) keyed row sets over
// the given fields and returns all mismatches, ordered by key then field.
func Diff(fields []Field, left, right map[string]Row) []Mismatch {
	var out []Mismatch
	for _, key := range unionKeys(left, right) {
		l, lok := left[key]
		r, rok := right[key]
		switch {
		case lok && !rok:
			out = append(out, Mismatch{Key: key, Detail: "present in left, missing in right"})
			continue
		case !lok && rok:
			out = append(out, Mismatch{Key: key, Detail: "present in right, missing in left"})
			continue
		}
		for _, f := range fields {
			if d := compareField(f, l[f.Name], r[f.Name]); d != "" {
				out = append(out, Mismatch{Key: key, Field: f.Name, Detail: d})
			}
		}
	}
	return out
}

func compareField(f Field, a, b any) string {
	an, bn := a == nil, b == nil
	if an && bn {
		return ""
	}
	if an != bn {
		return fmt.Sprintf("nullability differs: left=%v right=%v", a, b)
	}
	switch f.Kind {
	case Float:
		af, aok := toFloat(a)
		bf, bok := toFloat(b)
		if !aok || !bok {
			if fmt.Sprint(a) != fmt.Sprint(b) {
				return fmt.Sprintf("non-numeric mismatch: left=%v right=%v", a, b)
			}
			return ""
		}
		if math.Abs(af-bf) > f.Tol {
			return fmt.Sprintf("float diff %.6g > tol %.6g (left=%v right=%v)", math.Abs(af-bf), f.Tol, a, b)
		}
	default: // Exact
		if fmt.Sprint(a) != fmt.Sprint(b) {
			return fmt.Sprintf("left=%v right=%v", a, b)
		}
	}
	return ""
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	default:
		return 0, false
	}
}

func unionKeys(a, b map[string]Row) []string {
	set := map[string]struct{}{}
	for k := range a {
		set[k] = struct{}{}
	}
	for k := range b {
		set[k] = struct{}{}
	}
	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// ActivityFields is the default comparison set for the activities table: exact
// on ids/enums/ints, float epsilon on measured quantities. Localized display
// columns (sport_name, train_type) and Go-only tables (activity_watch_zones) are
// intentionally excluded — see ADR 0005 / 0007.
func ActivityFields() []Field {
	const eps = 0.011 // tolerate ±0.01 rounding differences
	return []Field{
		{Name: "sport_type", Kind: Exact},
		{Name: "sport", Kind: Exact},
		{Name: "train_kind", Kind: Exact},
		{Name: "feel", Kind: Exact},
		{Name: "avg_hr", Kind: Exact},
		{Name: "max_hr", Kind: Exact},
		{Name: "calories_kcal", Kind: Exact},
		{Name: "distance_m", Kind: Float, Tol: eps},
		{Name: "duration_s", Kind: Float, Tol: eps},
		{Name: "vo2max", Kind: Float, Tol: eps},
		{Name: "temperature", Kind: Float, Tol: eps},
	}
}

// CalibrationFields compares running_calibration_snapshot rows (keyed by
// as_of_date). Baseline scalars use tight float tolerances; the speed-duration
// model fields use slightly looser bands (they cascade from threshold speed,
// which drifts marginally on legacy km-distance activities). See ADR 0015.
func CalibrationFields() []Field {
	return []Field{
		{Name: "algorithm_version", Kind: Exact},
		{Name: "threshold_hr_confidence", Kind: Exact},
		{Name: "threshold_speed_confidence", Kind: Exact},
		{Name: "hrmax_confidence", Kind: Exact},
		{Name: "speed_duration_confidence", Kind: Exact},
		{Name: "threshold_hr", Kind: Float, Tol: 0.5},
		{Name: "threshold_speed_mps", Kind: Float, Tol: 0.02},
		{Name: "rhr_baseline", Kind: Float, Tol: 0.5},
		{Name: "observed_max_hr", Kind: Float, Tol: 0.5},
		{Name: "hrmax_estimate", Kind: Float, Tol: 0.5},
		{Name: "high_hr_reference", Kind: Float, Tol: 0.5},
		{Name: "critical_power_w", Kind: Float, Tol: 1.0},
		{Name: "critical_speed_mps", Kind: Float, Tol: 0.05},
		{Name: "d_prime_m", Kind: Float, Tol: 5.0},
		{Name: "riegel_k", Kind: Float, Tol: 0.001},
		{Name: "endurance_index", Kind: Float, Tol: 0.01},
		{Name: "speed_index", Kind: Float, Tol: 0.01},
	}
}

// ZoneFields compares running_calibration_zone rows (keyed by
// as_of_date|zone_kind|name).
func ZoneFields() []Field {
	return []Field{
		{Name: "confidence", Kind: Exact},
		{Name: "min_value", Kind: Float, Tol: 0.5},
		{Name: "max_value", Kind: Float, Tol: 0.5},
		{Name: "min_speed_mps", Kind: Float, Tol: 0.02},
		{Name: "max_speed_mps", Kind: Float, Tol: 0.02},
	}
}

// PersonalBestFields compares personal_bests rows (keyed by distance). entry_json
// (a provenance blob) is intentionally excluded.
func PersonalBestFields() []Field {
	return []Field{
		{Name: "source", Kind: Exact},
		{Name: "achieved_at", Kind: Exact},
		{Name: "pb_time_sec", Kind: Float, Tol: 0.5},
	}
}

// ActivityLoadFields compares activity_training_load rows (keyed by label_id).
// mechanical_load is excluded: it depends on the raw activity distance, which
// diverges on legacy km-distance activities (a watch-sync data issue, not the
// load math — ADR 0015).
func ActivityLoadFields() []Field {
	return []Field{
		{Name: "session_class", Kind: Exact},
		{Name: "coverage_status", Kind: Exact},
		{Name: "load_confidence", Kind: Exact},
		{Name: "training_dose_source", Kind: Exact},
		{Name: "excluded_from_pmc", Kind: Exact},
		{Name: "training_dose", Kind: Float, Tol: 0.5},
		{Name: "cardio_tss", Kind: Float, Tol: 0.5},
		{Name: "external_tss", Kind: Float, Tol: 0.5},
		{Name: "high_intensity_tss", Kind: Float, Tol: 0.5},
		{Name: "cardio_coverage", Kind: Float, Tol: 0.02},
		{Name: "external_coverage", Kind: Float, Tol: 0.02},
		{Name: "high_intensity_coverage", Kind: Float, Tol: 0.02},
	}
}

// DailyLoadFields compares daily_training_load rows (keyed by date). NOTE: the
// PMC is path-dependent (EWMA), so a meaningful diff requires both stores to be
// computed over the same window/inputs. readiness_gate is excluded because it
// needs daily_hrv/sleep, which the Go sync does not yet populate (a sync gap).
func DailyLoadFields() []Field {
	return []Field{
		{Name: "coverage_status", Kind: Exact},
		{Name: "training_dose", Kind: Float, Tol: 0.5},
		{Name: "acute_load", Kind: Float, Tol: 1.0},
		{Name: "chronic_load", Kind: Float, Tol: 1.0},
		{Name: "form", Kind: Float, Tol: 1.0},
		{Name: "load_ratio", Kind: Float, Tol: 0.02},
	}
}
