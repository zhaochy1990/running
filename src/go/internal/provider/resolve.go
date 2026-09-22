package provider

import (
	"fmt"
	"sort"
)

// ─────────────────────────────────────────────────────────────────────────────
// Relative / zone → absolute resolution
// ─────────────────────────────────────────────────────────────────────────────

// ZoneBand is one athlete-calibration training zone in an absolute unit. Zone
// numbers are 1-based and ordered easiest → hardest. Min/Max are numeric bounds
// in the unit of the zone family (bpm for HR zones, seconds-per-km for pace
// zones); they are not "Low/High" because those names carry intensity
// direction, which differs between pace and HR.
type ZoneBand struct {
	Zone int
	Min  float64
	Max  float64
}

// Baselines are the athlete-calibration values a relative or zone target
// resolves against. Every field is optional; a baseline required by a target's
// kind that is missing is a hard error — a default is never invented. Callers
// (sync/plan paths) inject these from the calibration domain.
type Baselines struct {
	HRMaxBPM    *float64
	RHRBPM      *float64
	LTHRBPM     *float64
	LTPaceSKM   *float64
	RacePaceSKM *float64
	FTPW        *float64
	PaceZones   []ZoneBand
	HRZones     []ZoneBand
}

// ResolveTarget turns a relative or zone target into an absolute one using the
// injected athlete baselines. It is pure: no I/O, no clock, no config. Absolute
// and open targets pass through unchanged. Any missing baseline, missing zone
// table, or empty zone selection is a hard error.
//
// The result keeps the Target Low(easier)/High(harder) convention. For the
// speed-ratio kinds (pct_lt_pace, pct_race_pace) absolute pace is
// reference_pace ÷ fraction, so a fraction below 1 yields a pace slower than
// the reference.
func ResolveTarget(t Target, b Baselines) (Target, error) {
	if err := t.Validate(); err != nil {
		return Target{}, err
	}
	switch t.Kind {
	case TargetKind(""), TargetOpen, TargetPaceSKM, TargetHRBPM, TargetPowerW:
		return t, nil
	case TargetPctMaxHR:
		return resolveScaled(t, b.HRMaxBPM, TargetHRBPM, "HRmax")
	case TargetPctHRR:
		return resolveHRR(t, b)
	case TargetPctLTHR:
		return resolveScaled(t, b.LTHRBPM, TargetHRBPM, "LT HR")
	case TargetPctLTPace:
		return resolvePaceRatio(t, b.LTPaceSKM, "LT pace")
	case TargetPctRacePace:
		return resolvePaceRatio(t, b.RacePaceSKM, "race pace")
	case TargetPctFTP:
		return resolveScaled(t, b.FTPW, TargetPowerW, "FTP")
	case TargetPaceZone:
		return resolveZone(t, b.PaceZones, TargetPaceSKM, "pace zones")
	case TargetHRZone:
		return resolveZone(t, b.HRZones, TargetHRBPM, "HR zones")
	}
	return Target{}, fmt.Errorf("cannot resolve target kind %q", t.Kind)
}

// resolveScaled multiplies each present fraction by a scalar baseline (HRmax,
// LT HR, FTP).
func resolveScaled(t Target, base *float64, outKind TargetKind, name string) (Target, error) {
	if base == nil {
		return Target{}, fmt.Errorf("cannot resolve %s target: %s baseline is not available", t.Kind, name)
	}
	out := Target{Kind: outKind}
	if t.Low != nil {
		v := *t.Low * *base
		out.Low = &v
	}
	if t.High != nil {
		v := *t.High * *base
		out.High = &v
	}
	return out, nil
}

// resolveHRR uses the Karvonen form: HR = RHR + fraction × (HRmax − RHR).
func resolveHRR(t Target, b Baselines) (Target, error) {
	if b.HRMaxBPM == nil || b.RHRBPM == nil {
		return Target{}, fmt.Errorf("cannot resolve %s target: HRmax and RHR baselines are required", t.Kind)
	}
	reserve := *b.HRMaxBPM - *b.RHRBPM
	out := Target{Kind: TargetHRBPM}
	if t.Low != nil {
		v := *b.RHRBPM + *t.Low*reserve
		out.Low = &v
	}
	if t.High != nil {
		v := *b.RHRBPM + *t.High*reserve
		out.High = &v
	}
	return out, nil
}

// resolvePaceRatio resolves a contractual speed ratio (v / v_reference):
// absolute pace = reference pace ÷ fraction.
func resolvePaceRatio(t Target, base *float64, name string) (Target, error) {
	if base == nil {
		return Target{}, fmt.Errorf("cannot resolve %s target: %s baseline is not available", t.Kind, name)
	}
	out := Target{Kind: TargetPaceSKM}
	if t.Low != nil {
		v := *base / *t.Low
		out.Low = &v
	}
	if t.High != nil {
		v := *base / *t.High
		out.High = &v
	}
	return out, nil
}

// resolveZone spans the numeric range covered by the selected zone numbers. A
// one-sided target (only Low or only High) starts from the lowest or extends to
// the highest zone present in the injected table.
func resolveZone(t Target, bands []ZoneBand, outKind TargetKind, name string) (Target, error) {
	if len(bands) == 0 {
		return Target{}, fmt.Errorf("cannot resolve %s target: %s table is not available", t.Kind, name)
	}
	sorted := append([]ZoneBand(nil), bands...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Zone < sorted[j].Zone })

	from, to := sorted[0].Zone, sorted[len(sorted)-1].Zone
	if t.Low != nil {
		from = int(*t.Low)
	}
	if t.High != nil {
		to = int(*t.High)
	}
	var numericMin, numericMax float64
	matched := false
	for _, band := range sorted {
		if band.Zone < from || band.Zone > to {
			continue
		}
		if !matched {
			numericMin, numericMax = band.Min, band.Max
			matched = true
			continue
		}
		numericMin = min(numericMin, band.Min)
		numericMax = max(numericMax, band.Max)
	}
	if !matched {
		return Target{}, fmt.Errorf("cannot resolve %s target: zones %d-%d are not in the %s table", t.Kind, from, to, name)
	}

	out := Target{Kind: outKind}
	switch outKind {
	case TargetPaceSKM:
		// Pace is inverted numerically: the slower (larger) bound is the easier Low.
		low, high := numericMax, numericMin
		out.Low, out.High = &low, &high
	default:
		low, high := numericMin, numericMax
		out.Low, out.High = &low, &high
	}
	return out, nil
}
