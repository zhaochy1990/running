package apifmt

import (
	"math"
	"testing"
)

func TestPacePerKmSecRejectsUnrepresentableDisplayValues(t *testing.T) {
	for _, speed := range []float64{math.SmallestNonzeroFloat64, math.MaxFloat64, math.Inf(1), math.NaN(), 0, -1} {
		if got := PacePerKmSec(&speed); got != nil {
			t.Fatalf("invalid display pace for speed %g: %d", speed, *got)
		}
	}
	for _, x := range []struct {
		seconds float64
		want    int
	}{{214.5, 214}, {215.5, 216}, {240, 240}} {
		speed := 1000 / x.seconds
		got := PacePerKmSec(&speed)
		if got == nil || *got != x.want {
			t.Fatalf("half-even %v got %v", x.seconds, got)
		}
	}
}
