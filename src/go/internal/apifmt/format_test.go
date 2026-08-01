package apifmt

import (
	"testing"
	"time"
)

func f64(v float64) *float64 { return &v }
func iptr(v int) *int        { return &v }
func sptr(v string) *string  { return &v }

func TestDistanceKm(t *testing.T) {
	tests := []struct {
		name string
		in   *float64
		want float64
	}{
		{"nil", nil, 0},
		{"zero", f64(0), 0},
		{"negative", f64(-5), 0},
		{"round down", f64(5194), 5.19},
		{"round up", f64(5195), 5.2}, // 5.195 → 5.2 (round-half-to-even lands here via float repr)
		{"exact km", f64(10000), 10},
		{"marathon", f64(42195), 42.2},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := DistanceKm(tc.in); got != tc.want {
				t.Fatalf("DistanceKm(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestDurationFmt(t *testing.T) {
	tests := []struct {
		in   *float64
		want string
	}{
		{nil, "—"},
		{f64(0), "—"},
		{f64(59), "00:00:59"},
		{f64(60), "00:01:00"},
		{f64(3661), "01:01:01"},
		{f64(3661.9), "01:01:01"},  // int() truncates toward zero
		{f64(360000), "100:00:00"}, // hours unbounded
	}
	for _, tc := range tests {
		if got := DurationFmt(tc.in); got != tc.want {
			t.Fatalf("DurationFmt(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestPaceFmt(t *testing.T) {
	tests := []struct {
		in   *float64
		want string
	}{
		{nil, "—"},
		{f64(0), "—"},
		{f64(300), "5:00/km"},
		{f64(330), "5:30/km"},
		{f64(365), "6:05/km"},
		{f64(365.8), "6:05/km"}, // truncation
		{f64(59), "0:59/km"},    // minutes not zero-padded
	}
	for _, tc := range tests {
		if got := PaceFmt(tc.in); got != tc.want {
			t.Fatalf("PaceFmt(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestShanghaiISO(t *testing.T) {
	tests := []struct {
		name string
		in   time.Time
		want string
	}{
		{
			name: "no fraction",
			in:   time.Date(2026, 5, 8, 16, 30, 0, 0, time.UTC),
			want: "2026-05-09T00:30:00+08:00",
		},
		{
			name: "microseconds",
			in:   time.Date(2026, 5, 9, 10, 46, 47, 600000*1000, time.UTC),
			want: "2026-05-09T18:46:47.600000+08:00",
		},
		{
			name: "zero time",
			in:   time.Time{},
			want: "",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ShanghaiISO(tc.in); got != tc.want {
				t.Fatalf("ShanghaiISO(%v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestSegmentName(t *testing.T) {
	tests := []struct {
		name    string
		nameKey *string
		exType  *int
		want    string
	}{
		{"mapped T-code", sptr("T1010"), iptr(2), "平板支撑"},
		{"mapped S-code", sptr("S3618"), nil, "休息"},
		{"sid_strength title-case", sptr("sid_strength_single_leg_press"), nil, "Single Leg Press"},
		{"sid_strength with digit", sptr("sid_strength_squat_3x"), nil, "Squat 3X"},
		{"unknown key falls to type", sptr("T9999"), iptr(1), "热身"},
		{"empty key uses type", sptr(""), iptr(3), "放松"},
		{"nil key uses type", nil, iptr(4), "恢复"},
		{"nil key nil type default", nil, nil, "训练"},
		{"unknown type default", sptr("T9999"), iptr(7), "训练"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := SegmentName(tc.nameKey, tc.exType); got != tc.want {
				t.Fatalf("SegmentName(%v, %v) = %q, want %q", tc.nameKey, tc.exType, got, tc.want)
			}
		})
	}
}
