package coros

import (
	"math"
	"testing"

	"github.com/zhaochy1990/stride/internal/normalize"
)

func TestSportFromCode(t *testing.T) {
	tests := []struct {
		code int
		want normalize.Sport
	}{
		{100, normalize.SportRunOutdoor},
		{101, normalize.SportRunIndoor},
		{102, normalize.SportRunTrail},
		{103, normalize.SportRunTrack},
		{104, normalize.SportRunTreadmill},
		{901, normalize.SportJumpRope},
		{402, normalize.SportStrength},
		{800, normalize.SportStrength}, // alternate strength code
		{600, normalize.SportWalk},
		{601, normalize.SportHike},
		{10000, normalize.SportGPSCardio},
		{10004, normalize.SportSpeedsurfing},
		{999999, normalize.SportUnknown}, // uncatalogued → Unknown, never crash
		{0, normalize.SportUnknown},
	}
	for _, tt := range tests {
		if got := SportFromCode(tt.code); got != tt.want {
			t.Errorf("SportFromCode(%d) = %q, want %q", tt.code, got, tt.want)
		}
	}
}

func TestTrainKindFromCode(t *testing.T) {
	tests := []struct {
		code int
		want normalize.TrainKind
	}{
		{1, normalize.TrainBase},
		{2, normalize.TrainAerobic},
		{3, normalize.TrainThreshold},
		{4, normalize.TrainInterval},
		{5, normalize.TrainVO2Max},
		{6, normalize.TrainAnaerobic},
		{7, normalize.TrainSprint},
		{8, normalize.TrainRecovery},
		{0, normalize.TrainUnknown},
		{9, normalize.TrainUnknown},
	}
	for _, tt := range tests {
		if got := TrainKindFromCode(tt.code); got != tt.want {
			t.Errorf("TrainKindFromCode(%d) = %q, want %q", tt.code, got, tt.want)
		}
	}
}

const eps = 1e-9

func approx(a, b float64) bool { return math.Abs(a-b) < eps }

func TestDistanceCmToMeters(t *testing.T) {
	tests := []struct {
		cm   float64
		want float64
	}{
		{0, 0},
		{100, 1},
		{311337, 3113.37},
		{1050, 10.5},
	}
	for _, tt := range tests {
		if got := DistanceCmToMeters(tt.cm); !approx(got, tt.want) {
			t.Errorf("DistanceCmToMeters(%v) = %v, want %v", tt.cm, got, tt.want)
		}
	}
}

func TestOptionalDistanceCmToMeters(t *testing.T) {
	if got := OptionalDistanceCmToMeters(nil); got != nil {
		t.Errorf("nil input should stay nil, got %v", *got)
	}
	in := 250.0
	got := OptionalDistanceCmToMeters(&in)
	if got == nil || !approx(*got, 2.5) {
		t.Errorf("OptionalDistanceCmToMeters(250) = %v, want 2.5", got)
	}
	// the input must not be mutated
	if !approx(in, 250.0) {
		t.Errorf("input mutated to %v", in)
	}
}

func TestCentisecondsToSeconds(t *testing.T) {
	tests := []struct {
		cs   int64
		want float64
	}{
		{0, 0},
		{100, 1},
		{12345, 123.45},
		{6, 0.06},
	}
	for _, tt := range tests {
		if got := CentisecondsToSeconds(tt.cs); !approx(got, tt.want) {
			t.Errorf("CentisecondsToSeconds(%d) = %v, want %v", tt.cs, got, tt.want)
		}
	}
}

func TestVerticalRatioPct(t *testing.T) {
	if got := VerticalRatioPct(87); !approx(got, 8.7) {
		t.Errorf("VerticalRatioPct(87) = %v, want 8.7", got)
	}
}

func TestGPSCoord(t *testing.T) {
	// 311337430 → 31.1337430°N (WGS84 ground-truth from the Python port).
	deg, ok := GPSCoord(311337430)
	if !ok || !approx(deg, 31.133743) {
		t.Errorf("GPSCoord(311337430) = (%v, %v), want (31.133743, true)", deg, ok)
	}
	// negative (southern/western) coordinate
	deg, ok = GPSCoord(-1213456789)
	if !ok || !approx(deg, -121.3456789) {
		t.Errorf("GPSCoord(-1213456789) = (%v, %v), want (-121.3456789, true)", deg, ok)
	}
	// zero = no fix
	if _, ok := GPSCoord(0); ok {
		t.Error("GPSCoord(0) should report ok=false (no fix)")
	}
}
