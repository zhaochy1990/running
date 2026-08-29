package ability

import (
	"fmt"
	"math"
	"time"
)

// parseYMD parses a YYYY-MM-DD (prefix) date, matching Python date.fromisoformat
// on the first 10 chars. Returns an error when malformed.
func parseYMD(s string) (time.Time, error) {
	if len(s) < 10 {
		return time.Time{}, fmt.Errorf("ability: bad date %q", s)
	}
	return time.Parse("2006-01-02", s[:10])
}

// mean mirrors ability._mean.
func mean(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	s := 0.0
	for _, x := range xs {
		s += x
	}
	return s / float64(len(xs))
}

// median mirrors ability._median.
func median(xs []float64) float64 {
	filt := make([]float64, 0, len(xs))
	for _, x := range xs {
		filt = append(filt, x)
	}
	if len(filt) == 0 {
		return 0
	}
	// copy to avoid mutating caller; sort ascending
	sortFloats(filt)
	n := len(filt)
	m := n / 2
	if n%2 == 1 {
		return filt[m]
	}
	return (filt[m-1] + filt[m]) / 2.0
}

// stdev mirrors ability._stdev (sample stddev).
func stdev(xs []float64) float64 {
	if len(xs) < 2 {
		return 0
	}
	mu := mean(xs)
	var v float64
	for _, x := range xs {
		d := x - mu
		v += d * d
	}
	return math.Sqrt(v / float64(len(xs)-1))
}

// cv mirrors ability._cv: coefficient of variation, 0 for <2 samples or mu==0.
func cv(xs []float64) float64 {
	if len(xs) < 2 {
		return 0
	}
	mu := mean(xs)
	if mu == 0 {
		return 0
	}
	return stdev(xs) / math.Abs(mu)
}

// clamp mirrors ability._clamp.
func clamp(x, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, x))
}

// linreg mirrors ability._linreg: OLS (slope, intercept). Returns ok=false when
// fewer than 2 distinct x values.
func linreg(points [][2]float64) (slope, intercept float64, ok bool) {
	pts := make([][2]float64, 0, len(points))
	for _, p := range points {
		pts = append(pts, p)
	}
	if len(pts) < 2 {
		return 0, 0, false
	}
	var mx, my float64
	for _, p := range pts {
		mx += p[0]
		my += p[1]
	}
	mx /= float64(len(pts))
	my /= float64(len(pts))
	var num, den float64
	for _, p := range pts {
		dx := p[0] - mx
		dy := p[1] - my
		num += dx * dy
		den += dx * dx
	}
	if den == 0 {
		return 0, 0, false
	}
	slope = num / den
	intercept = my - slope*mx
	return slope, intercept, true
}

// sortFloats sorts in-place ascending (stable not required).
func sortFloats(a []float64) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}

// abs mirrors math.Abs.
func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

func max2(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// round2 rounds to 2 decimal places (Python round(x, 2)).
func round2(x float64) float64 {
	return math.Round(x*100) / 100
}

// roundToInt mirrors Python round(x) → nearest int (halves away from zero for
// positive x, matching Python's banker's rounding for .5 is immaterial here).
func roundToInt(x float64) int {
	return int(math.Round(x))
}

// roundN rounds to N decimal places (Python round(x, n)).
func roundN(x float64, n int) float64 {
	p := math.Pow(10, float64(n))
	return math.Round(x*p) / p
}
