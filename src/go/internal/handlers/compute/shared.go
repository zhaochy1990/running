// Package compute hosts the two "derive results from already-synced watch data"
// job handlers that follow a sync in the data_sync pipeline:
//
//   - calibration (CalibrationJobType): the 180-day-window athlete baseline
//     (HRmax / LTHR / threshold pace / RHR / critical power + zones). Run once at
//     onboarding and, later, on a weekly cadence. Owns calibration writes.
//   - compute (ComputeJobType): per-activity training load + daily PMC
//     (CTL/ATL/Form) + personal bests. Mode-aware: full recomputes over the
//     window; incremental uses this sync's new activity and health dates and
//     extends the PMC tail from prior state. It READS the latest calibration snapshot (single
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
