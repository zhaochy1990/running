// Package apifmt holds the API-boundary presentation helpers the activity read
// endpoints share: metre→kilometre rounding, duration/pace string formatting,
// and UTC→Asia/Shanghai ISO conversion.
//
// These port the Python serializer helpers one-for-one so the Go activity
// endpoints emit the same JSON as the FastAPI routes they shadow:
//
//   - DistanceKm  ← stride_core.distance.meters_to_km_zero (digits=2)
//   - DurationFmt ← stride_server.deps.format_duration
//   - PaceFmt     ← stride_core.models.pace_str, then `or "—"`
//   - ShanghaiISO ← stride_core.timefmt.utc_iso_to_shanghai_iso
//
// Segment naming (EXERCISE_NAMES / EXERCISE_TYPES) lives in exercise.go.
package apifmt

import (
	"fmt"
	"strconv"
	"time"
)

// shanghai is the fixed Asia/Shanghai offset (UTC+8, no DST — the invariant the
// repo pins for all user-facing day/instant math). A fixed zone guarantees the
// "+08:00" offset notation the Python isoformat() output carries.
var shanghai = time.FixedZone("Asia/Shanghai", 8*3600)

// EmDash is the placeholder the Python serializers emit for a missing duration
// or pace ("—", U+2014).
const EmDash = "—"

// DistanceKm converts a metre distance to kilometres rounded to 2 decimals,
// returning 0 for a missing/non-positive value. Mirrors meters_to_km_zero:
// meters_or_none treats nil and any value ≤ 0 as blank → 0.0.
func DistanceKm(meters *float64) float64 {
	if meters == nil || *meters <= 0 {
		return 0
	}
	return roundTo(*meters/1000.0, 2)
}

// DurationFmt renders whole seconds as HH:MM:SS (zero-padded, hours unbounded),
// returning "—" for a nil or zero input. Mirrors format_duration, whose
// `if not seconds` treats both None and 0 as the em-dash and whose int() cast
// truncates toward zero.
func DurationFmt(seconds *float64) string {
	if seconds == nil || *seconds == 0 {
		return EmDash
	}
	s := int64(*seconds) // truncates toward zero, like Python int()
	h := s / 3600
	m := (s % 3600) / 60
	sec := s % 60
	return fmt.Sprintf("%02d:%02d:%02d", h, m, sec)
}

// PaceFmt renders a seconds-per-km pace as "m:ss/km", returning "—" for a nil or
// zero input. Mirrors `pace_str(...) or "—"`: pace_str returns None for a falsy
// input (None or 0) and does not zero-pad the minutes field.
func PaceFmt(secPerKm *float64) string {
	if secPerKm == nil || *secPerKm == 0 {
		return EmDash
	}
	v := int64(*secPerKm) // int() truncation, matching pace_str
	m := v / 60
	s := v % 60
	return fmt.Sprintf("%d:%02d/km", m, s)
}

// PacePerKmSec converts a speed (m/s) to whole seconds per kilometre, rounded
// half-to-even, returning nil for a nil/non-positive speed. Mirrors the STRIDE
// zone serializer's _pace_per_km_sec: int(round(1000/speed)). Note the rounding
// (round, not truncate) differs from PaceFmt/pace_str, which truncates.
func PacePerKmSec(speedMps *float64) *int {
	if speedMps == nil || *speedMps <= 0 {
		return nil
	}
	n := int(roundTo(1000.0/(*speedMps), 0))
	return &n
}

// PaceMinSec renders a speed (m/s) as an "M:SS" per-km pace string (no "/km"
// suffix, minutes not zero-padded), returning nil for a nil/non-positive speed.
// Mirrors the STRIDE zone serializer's _pace_fmt, which formats the rounded
// _pace_per_km_sec as f"{secs // 60}:{secs % 60:02d}". Distinct from PaceFmt
// (which appends "/km", takes seconds-per-km, and truncates).
func PaceMinSec(speedMps *float64) *string {
	secs := PacePerKmSec(speedMps)
	if secs == nil {
		return nil
	}
	s := fmt.Sprintf("%d:%02d", *secs/60, *secs%60)
	return &s
}

// ShanghaiISO renders a UTC instant as an Asia/Shanghai ISO 8601 string with the
// "+08:00" offset, preserving the instant so the frontend's new Date(value)
// resolves to the same moment. Mirrors utc_iso_to_shanghai_iso, including
// Python isoformat()'s fractional-seconds rule: omitted when zero, otherwise
// exactly six digits (the DATETIME(6) microsecond precision).
//
// A zero time.Time renders "" so an absent activity date serializes as an empty
// string rather than year-0001 garbage.
func ShanghaiISO(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	lt := t.In(shanghai)
	off := lt.Format("-07:00")
	if lt.Nanosecond() == 0 {
		return lt.Format("2006-01-02T15:04:05") + off
	}
	// DATETIME(6) is microsecond-precise, so nanos are always a whole number of
	// microseconds; render six digits to match Python isoformat().
	micros := lt.Nanosecond() / 1000
	return fmt.Sprintf("%s.%06d%s", lt.Format("2006-01-02T15:04:05"), micros, off)
}

// TodayShanghai returns today's date in Asia/Shanghai as a YYYY-MM-DD string.
// Mirrors stride_core.timefmt.today_shanghai, used at the route boundary to pin
// an as-of date (e.g. the rhr-baseline calibration lookup).
func TodayShanghai() string {
	return time.Now().In(shanghai).Format("2006-01-02")
}

// RoundTo rounds x to the given number of decimals using round-half-to-even,
// mirroring Python's round(x, digits). Used for the monthly total_run_km, which
// the Python serializer rounds to one decimal.
func RoundTo(x float64, digits int) float64 { return roundTo(x, digits) }

// roundTo rounds x to the given number of decimals using round-half-to-even,
// matching Python's round(). FormatFloat('f') is correctly rounded (banker's
// rounding on ties), and re-parsing yields the nearest float64 to that decimal
// so the JSON shortest-repr matches Python's.
func roundTo(x float64, digits int) float64 {
	v, _ := strconv.ParseFloat(strconv.FormatFloat(x, 'f', digits, 64), 64)
	return v
}
