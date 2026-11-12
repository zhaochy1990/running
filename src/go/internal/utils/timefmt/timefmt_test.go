package timefmt

import (
	"testing"
	"time"
)

func TestShanghaiDayCrossesMidnight(t *testing.T) {
	// 2026-07-28 20:00 UTC is 2026-07-29 04:00 Shanghai.
	utc := time.Date(2026, 7, 28, 20, 0, 0, 0, time.UTC)
	got := ShanghaiDay(utc)
	want := time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("ShanghaiDay = %v, want %v", got, want)
	}
}

func TestShanghaiDayStr(t *testing.T) {
	utc := time.Date(2026, 7, 28, 20, 0, 0, 0, time.UTC)
	if got := ShanghaiDayStr(utc); got != "2026-07-29" {
		t.Errorf("ShanghaiDayStr = %q, want 2026-07-29", got)
	}
	// An instant already inside the same Shanghai day stays put.
	utc2 := time.Date(2026, 7, 28, 4, 0, 0, 0, time.UTC)
	if got := ShanghaiDayStr(utc2); got != "2026-07-28" {
		t.Errorf("ShanghaiDayStr = %q, want 2026-07-28", got)
	}
}

func TestShanghaiFixedOffset(t *testing.T) {
	_, offset := time.Date(2026, 1, 1, 0, 0, 0, 0, Shanghai).Zone()
	if offset != 8*3600 {
		t.Errorf("Shanghai offset = %d, want %d", offset, 8*3600)
	}
}

func TestShanghaiWeekStart(t *testing.T) {
	cases := []struct {
		name string
		utc  time.Time
		want string
	}{
		// 2026-11-09 is a Monday. Mid-week days all map back to it.
		{"monday", time.Date(2026, 11, 9, 2, 0, 0, 0, time.UTC), "2026-11-09"},
		{"thursday", time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC), "2026-11-09"},
		// Shanghai Sunday 23:59 (UTC 15:59) is still the old week...
		{"sunday 23:59 shanghai", time.Date(2026, 11, 8, 15, 59, 0, 0, time.UTC), "2026-11-02"},
		// ...and the very next instant is Shanghai Monday 00:00, the new week.
		{"monday 00:00 shanghai", time.Date(2026, 11, 8, 16, 0, 0, 0, time.UTC), "2026-11-09"},
		// UTC is still Sunday 17:00 here, but Shanghai has already crossed into Monday 01:00.
		{"utc sunday crosses into shanghai monday", time.Date(2026, 11, 8, 17, 0, 0, 0, time.UTC), "2026-11-09"},
	}
	for _, tc := range cases {
		if got := ShanghaiWeekStart(tc.utc).Format("2006-01-02"); got != tc.want {
			t.Errorf("%s: ShanghaiWeekStart = %q, want %q", tc.name, got, tc.want)
		}
	}
}
