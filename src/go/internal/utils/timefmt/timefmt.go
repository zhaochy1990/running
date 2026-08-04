// Package timefmt is the single source for Shanghai (Asia/Shanghai, UTC+8, no
// DST) calendar conversions on the Go side, mirroring stride_core.timefmt on
// the Python side.
//
// All coros.db timestamps are stored as UTC; every user-facing day/week bucket
// is Shanghai-local. Mixing the two silently misfiles the 00:00–07:59 Shanghai
// window onto the wrong date. Route every Go conversion through this package
// rather than re-deriving the +8 offset inline.
package timefmt

import "time"

// Shanghai is Asia/Shanghai (UTC+8, no DST). It is a fixed zone rather than a
// tzdata lookup so behaviour is identical on hosts without a zoneinfo database.
var Shanghai = time.FixedZone("CST", 8*3600)

// ShanghaiDay returns the Shanghai civil day of a UTC instant, expressed as a
// UTC-midnight time.Time so day arithmetic stays exact.
func ShanghaiDay(utc time.Time) time.Time {
	sh := utc.In(Shanghai)
	return time.Date(sh.Year(), sh.Month(), sh.Day(), 0, 0, 0, 0, time.UTC)
}

// ShanghaiToday returns today's Shanghai civil day as a UTC-midnight time.Time.
func ShanghaiToday() time.Time {
	return ShanghaiDay(time.Now())
}

// ShanghaiDayStr returns the Shanghai civil day of a UTC instant as a
// "2006-01-02" string.
func ShanghaiDayStr(utc time.Time) string {
	return ShanghaiDay(utc).Format("2006-01-02")
}
