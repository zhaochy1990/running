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
