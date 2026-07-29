package calibration

import (
	"math"
	"sort"
	"strings"
	"time"
)

// pyRound replicates Python 3's round(x) -> int: round half to even. Go's
// math.Round rounds half away from zero, which would diverge at exact .5 index
// boundaries used by the percentile selectors.
func pyRound(x float64) int {
	fl := math.Floor(x)
	diff := x - fl
	switch {
	case diff < 0.5:
		return int(fl)
	case diff > 0.5:
		return int(fl) + 1
	default: // exactly .5 -> nearest even
		i := int(fl)
		if i%2 == 0 {
			return i
		}
		return i + 1
	}
}

// medianFloat mirrors statistics.median: sort, then for even n average the two
// middle values. Caller guarantees len > 0.
func medianFloat(xs []float64) float64 {
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2.0
}

// percentileSorted mirrors core._percentile_sorted: index =
// clamp(round((n-1)*pct)), on an already-sorted slice. Returns false when empty.
func percentileSorted(sorted []float64, pct float64) (float64, bool) {
	n := len(sorted)
	if n == 0 {
		return 0, false
	}
	idx := pyRound(float64(n-1) * pct)
	if idx < 0 {
		idx = 0
	}
	if idx > n-1 {
		idx = n - 1
	}
	return sorted[idx], true
}

// isRunning mirrors segments.is_running.
func isRunning(a Activity) bool {
	s := strings.ToLower(strings.TrimSpace(a.Sport))
	return s == "run" || strings.HasPrefix(s, "run_") || strings.HasPrefix(s, "running")
}

// dayDiff returns (a - b) in whole days, matching Python date subtraction. Both
// are UTC-midnight civil days, so the difference is an exact multiple of 24h.
func dayDiff(a, b time.Time) int {
	return int(math.Round(a.Sub(b).Hours() / 24.0))
}

// inClosedRange reports start <= d <= end (inclusive), matching Python's
// window_start <= date <= as_of_date on civil days.
func inClosedRange(d, start, end time.Time) bool {
	return !d.Before(start) && !d.After(end)
}

// round4 mirrors core._round: round(v, 4). Returns nil for nil.
func round4(v *float64) *float64 {
	if v == nil {
		return nil
	}
	r := math.Round(*v*1e4) / 1e4
	return &r
}
