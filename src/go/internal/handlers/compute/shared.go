// Package compute hosts the two "derive results from already-synced watch data"
// job handlers that follow a sync in the data_sync pipeline:
//
//   - calibration (CalibrationJobType): the 180-day-window athlete baseline
//     (HRmax / LTHR / threshold pace / RHR / critical power + zones). Run once at
//     onboarding and, later, on a weekly cadence. Owns calibration writes.
//   - compute (ComputeJobType): per-activity training load + daily PMC
//     (CTL/ATL/Form) + personal bests. Mode-aware: full recomputes over the
//     window; incremental only touches this sync's new activities and extends the
//     PMC tail from prior state. It READS the latest calibration snapshot (single
//     source) rather than recomputing it.
//
// Both share the domain→storage converters and small helpers in this package, so
// there is one place mapping compute results onto the MySQL rows.
package compute

import (
	"encoding/json"
	"strings"
	"time"
)

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func jsonStrings(ss []string) *string {
	if len(ss) == 0 {
		return nil
	}
	b, _ := json.Marshal(ss)
	s := string(b)
	return &s
}

func intToFloat(v *int) *float64 {
	if v == nil {
		return nil
	}
	f := float64(*v)
	return &f
}

func parseDay(s string) (time.Time, bool) {
	s = strings.ReplaceAll(strings.TrimSpace(s), "-", "")
	if len(s) < 8 {
		return time.Time{}, false
	}
	t, err := time.Parse("20060102", s[:8])
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// shanghaiToday returns the Shanghai (UTC+8) civil day as a UTC-midnight time,
// matching the reader's activity-date representation.
func shanghaiToday() time.Time {
	sh := time.Now().UTC().Add(8 * time.Hour)
	return time.Date(sh.Year(), sh.Month(), sh.Day(), 0, 0, 0, 0, time.UTC)
}

// shanghaiDayOf returns the Shanghai civil day (as a UTC-midnight time) of a UTC
// instant — used to find the earliest new-activity day for the incremental
// window and PMC prior-state boundary.
func shanghaiDayOf(t time.Time) time.Time {
	sh := t.UTC().Add(8 * time.Hour)
	return time.Date(sh.Year(), sh.Month(), sh.Day(), 0, 0, 0, 0, time.UTC)
}
