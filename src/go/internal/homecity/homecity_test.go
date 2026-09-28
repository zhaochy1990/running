// homecity_test.go validates the detector against synthetic scenarios that
// mirror the production patterns the thresholds were tuned on (2026-09-28,
// 12 users): a summer altitude-training camp that must not read as a move
// (Kunming 呈贡, 29-day span), a genuine relocation (Chengdu → Kunming,
// sustained and still current), a seasonal second base (Yantai home + two
// summer Kunming stints), and the name-only fallback (no GPS at all). The
// evaluation clock is pinned so the tests are deterministic.
package homecity

import (
	"fmt"
	"testing"
	"time"
)

var evalNow = time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)

// Reference coordinates (production-observed cluster centroids).
const (
	zhujiajiaoLat, zhujiajiaoLon = 31.133, 121.076 // 上海·青浦朱家角
	qingpuLat, qingpuLon         = 31.155, 121.114 // 上海·青浦城区
	pudongLat, pudongLon         = 31.212, 121.521 // 上海·浦东世纪公园
	chenggongLat, chenggongLon   = 24.896, 102.831 // 昆明·呈贡
	cuihuLat, cuihuLon           = 25.037, 102.691 // 昆明·翠湖
	tianfuLat, tianfuLon         = 30.657, 104.066 // 成都·天府广场
	dujiangyanLat, dujiangyanLon = 30.982, 103.641 // 成都·都江堰
	jiaozhouLat, jiaozhouLon     = 36.134, 119.906 // 青岛·胶州
	guangraoLat, guangraoLon     = 37.036, 118.410 // 东营·广饶
)

func mustDate(layout, value string) time.Time {
	t, err := time.Parse(layout, value)
	if err != nil {
		panic(err)
	}
	return t
}

func gpsSignal(date string, lat, lon float64) ActivitySignal {
	t := mustDate("2006-01-02 15:04", date+" 07:00")
	latCopy, lonCopy := lat, lon
	return ActivitySignal{StartGPSLat: &latCopy, StartGPSLon: &lonCopy, Time: t}
}

func nameSignal(date, name string) ActivitySignal {
	t := mustDate("2006-01-02 15:04", date+" 07:00")
	nameCopy := name
	return ActivitySignal{Name: &nameCopy, Time: t}
}

// spreadDates returns n dates evenly spaced from start to end inclusive.
func spreadDates(n int, start, end string) []time.Time {
	s := mustDate("2006-01-02", start)
	e := mustDate("2006-01-02", end)
	if n == 1 {
		return []time.Time{s}
	}
	step := e.Sub(s) / time.Duration(n-1)
	out := make([]time.Time, n)
	for i := range out {
		out[i] = s.Add(time.Duration(i) * step)
	}
	return out
}

// gpsBetween seeds n GPS votes evenly between the dates.
func gpsBetween(signals []ActivitySignal, n int, start, end string, lat, lon float64) []ActivitySignal {
	for _, t := range spreadDates(n, start, end) {
		signals = append(signals, gpsSignal(t.Format("2006-01-02"), lat, lon))
	}
	return signals
}

// nameBetween seeds n name-prefix votes evenly between the dates.
func nameBetween(signals []ActivitySignal, n int, start, end string, city string) []ActivitySignal {
	for _, t := range spreadDates(n, start, end) {
		signals = append(signals, nameSignal(t.Format("2006-01-02"), city+" 跑步"))
	}
	return signals
}

func TestCampDoesNotRelocate(t *testing.T) {
	var signals []ActivitySignal
	// Four years of Shanghai running (GPS across Qingpu/Pudong)...
	signals = gpsBetween(signals, 60, "2022-12-05", "2026-05-20", zhujiajiaoLat, zhujiajiaoLon)
	signals = gpsBetween(signals, 30, "2023-01-10", "2026-06-10", qingpuLat, qingpuLon)
	signals = gpsBetween(signals, 15, "2023-03-01", "2026-07-01", pudongLat, pudongLon)
	// ...a 29-day Kunming altitude camp in summer 2026...
	signals = gpsBetween(signals, 25, "2026-06-27", "2026-07-25", chenggongLat, chenggongLon)
	// ...then back to Shanghai through September.
	signals = gpsBetween(signals, 20, "2026-08-05", "2026-09-25", zhujiajiaoLat, zhujiajiaoLon)

	got := Detect(signals, DefaultOptions(evalNow))
	if got.City != "上海市" {
		t.Fatalf("city = %q, want 上海市", got.City)
	}
	if got.Relocated {
		t.Fatalf("camp must not trigger relocation: %+v", got)
	}
	if got.District == "" || got.Source != "gps" || got.Confidence != ConfidenceHigh {
		t.Fatalf("expected high-confidence gps result with district, got %+v", got)
	}
	assertSecondary(t, got, "昆明市", SecondaryTransient)
}

func TestRelocationFiresForSustainedMove(t *testing.T) {
	var signals []ActivitySignal
	// A year and a half of dense Chengdu history — the incumbent base the
	// challenger must outweigh in the trailing windows (not in all-time
	// weight, where it still dominates).
	signals = gpsBetween(signals, 250, "2025-03-01", "2026-06-20", tianfuLat, tianfuLon)
	// ...then a sustained move to Kunming: dense July–September, still there
	// in early September.
	signals = gpsBetween(signals, 30, "2026-07-01", "2026-07-31", cuihuLat, cuihuLon)
	signals = gpsBetween(signals, 45, "2026-08-01", "2026-08-28", cuihuLat, cuihuLon)
	for _, d := range []string{
		"2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-01",
		"2026-09-02", "2026-09-03", "2026-09-03", "2026-09-04", "2026-09-04",
		"2026-09-05", "2026-09-05", "2026-09-02", "2026-08-30",
	} {
		signals = append(signals, gpsSignal(d, cuihuLat, cuihuLon))
	}
	// September travel blips: Chengdu week plus northern-Hebei trail trips.
	signals = gpsBetween(signals, 9, "2026-09-06", "2026-09-17", tianfuLat, tianfuLon)
	signals = gpsBetween(signals, 10, "2026-09-08", "2026-09-11", 40.839, 114.883) // 张家口·崇礼南
	signals = gpsBetween(signals, 12, "2026-09-18", "2026-09-23", 40.699, 117.237) // 承德·兴隆北

	got := Detect(signals, DefaultOptions(evalNow))
	if !got.Relocated || got.City != "昆明市" || got.PreviousCity != "成都市" {
		t.Fatalf("expected relocation 成都市→昆明市, got %+v", got)
	}
	if got.Confidence != ConfidenceMedium {
		t.Fatalf("fresh relocations cap at medium, got %v", got.Confidence)
	}
	assertSecondary(t, got, "成都市", SecondaryFormer)
}

func TestSeasonalBaseNeverRelocates(t *testing.T) {
	var signals []ActivitySignal
	// Yantai home base (name-prefixed history at production volume, like the
	// Garmin-less coverage) plus two recurring Kunming summers and a September
	// return to Shandong — the exact seasonal user from production.
	signals = nameBetween(signals, 100, "2023-11-02", "2025-08-30", "烟台市")
	signals = nameBetween(signals, 100, "2025-09-05", "2026-06-15", "烟台市")
	signals = gpsBetween(signals, 20, "2025-07-01", "2025-09-24", chenggongLat, chenggongLon)
	signals = gpsBetween(signals, 35, "2026-07-01", "2026-09-12", chenggongLat, chenggongLon)
	signals = gpsBetween(signals, 33, "2026-09-15", "2026-09-26", jiaozhouLat, jiaozhouLon)
	signals = gpsBetween(signals, 6, "2026-09-25", "2026-09-26", guangraoLat, guangraoLon)

	got := Detect(signals, DefaultOptions(evalNow))
	if got.City != "烟台市" || got.Relocated {
		t.Fatalf("seasonal Kunming must not displace 烟台市, got %+v", got)
	}
	if got.RecentCity != "青岛市" {
		t.Fatalf("recent city = %q, want 青岛市 (September return to Shandong)", got.RecentCity)
	}
	assertSecondary(t, got, "昆明市", SecondarySeasonal)
}

func TestNameOnlyFallback(t *testing.T) {
	var signals []ActivitySignal
	for _, d := range []string{"2026-06-19", "2026-06-21", "2026-06-26", "2026-06-28", "2026-07-01", "2026-07-03", "2026-07-05", "2026-07-08", "2026-07-14", "2026-07-28"} {
		signals = append(signals, nameSignal(d, "上海市 跑步"))
	}
	signals = append(signals, nameSignal("2026-06-11", "瑜伽"), nameSignal("2026-06-15", "混合体能训练"))

	got := Detect(signals, DefaultOptions(evalNow))
	if got.City != "上海市" || got.Source != "name" || got.Confidence != ConfidenceLow {
		t.Fatalf("expected low-confidence name-only 上海市, got %+v", got)
	}
	if got.District != "" || got.Centroid != nil {
		t.Fatalf("name-only result must not claim a district/centroid: %+v", got)
	}
}

func TestForeignPointsDiscarded(t *testing.T) {
	var signals []ActivitySignal
	// Nantes, Frankfurt, Sydney, Zhanjiang-side stray — none within 60 km of
	// an anchor except the Shanghai starts.
	for _, p := range [][2]float64{{47.234, -1.653}, {50.088, 8.631}, {-33.786, 151.086}} {
		signals = append(signals, gpsSignal("2026-09-16", p[0], p[1]))
	}
	signals = gpsBetween(signals, 12, "2026-08-16", "2026-09-26", pudongLat, pudongLon)

	got := Detect(signals, DefaultOptions(evalNow))
	if got.City != "上海市" {
		t.Fatalf("city = %q, want 上海市 (foreign points discarded)", got.City)
	}
	if got.TotalVotes != 12 {
		t.Fatalf("total votes = %d, want 12", got.TotalVotes)
	}
}

func TestInsufficientData(t *testing.T) {
	signals := []ActivitySignal{
		gpsSignal("2026-09-01", zhujiajiaoLat, zhujiajiaoLon),
		nameSignal("2026-09-02", "上海市 跑步"),
	}
	got := Detect(signals, DefaultOptions(evalNow))
	if got.City != "" || got.Confidence != ConfidenceNone {
		t.Fatalf("expected none-confidence empty result, got %+v", got)
	}
}

func TestParseCityHint(t *testing.T) {
	cases := []struct {
		name string
		want string
		ok   bool
	}{
		{"上海市 跑步", "上海市", true},
		{"昆明市 越野跑", "昆明市", true},
		{"上海市 运动场跑步", "上海市", true},
		{"乌鲁木齐市 跑步", "乌鲁木齐市", true},
		{"晨跑", "", false},
		{"West Berlin Easy Run", "", false},
		{"", "", false},
		{"上海市", "上海市", true}, // bare city name still carries the hint
		{"跑步 上海市", "", false},
	}
	for _, tc := range cases {
		name := tc.name
		got, ok := ParseCityHint(&name)
		if got != tc.want || ok != tc.ok {
			t.Errorf("ParseCityHint(%q) = (%q, %v), want (%q, %v)", tc.name, got, ok, tc.want, tc.ok)
		}
	}
	if _, ok := ParseCityHint(nil); ok {
		t.Errorf("nil name must not parse")
	}
}

func TestAnchorResolutions(t *testing.T) {
	cases := []struct {
		lat, lon float64
		city     string
	}{
		{31.133, 121.076, "上海市"},  // 朱家角 cluster — must not fall to 昆山
		{31.387, 120.981, "苏州市"},  // 昆山玉山
		{24.896, 102.831, "昆明市"},  // 呈贡
		{30.982, 103.641, "成都市"},  // 都江堰
		{36.134, 119.906, "青岛市"},  // 胶州铺集
		{37.036, 118.410, "东营市"},  // 广饶
		{40.699, 117.237, "承德市"},  // 兴隆山区
		{30.657, 104.066, "成都市"},  // 天府广场
	}
	for _, tc := range cases {
		anchor, distance, ok := nearestAnchor(defaultAnchors, tc.lat, tc.lon)
		if !ok || anchor.City != tc.city {
			t.Errorf("nearestAnchor(%v,%v) = %q (%.1fkm), want %q", tc.lat, tc.lon, anchor.City, distance, tc.city)
		}
		if distance > 60 {
			t.Errorf("nearestAnchor(%v,%v) distance %.1fkm exceeds the 60km vote radius", tc.lat, tc.lon, distance)
		}
	}
}

func TestAnchorTableWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, a := range defaultAnchors {
		if a.Province == "" || a.City == "" || a.District == "" {
			t.Fatalf("anchor missing a name component: %+v", a)
		}
		if !validCoordinate(a.Latitude, a.Longitude) {
			t.Fatalf("anchor out of range: %+v", a)
		}
		key := fmt.Sprintf("%s|%s|%s", a.Province, a.City, a.District)
		if seen[key] {
			t.Fatalf("duplicate anchor: %s", key)
		}
		seen[key] = true
	}
}

func assertSecondary(t *testing.T, got Result, city string, kind SecondaryKind) {
	t.Helper()
	for _, s := range got.Secondary {
		if s.City == city {
			if s.Kind != kind {
				t.Errorf("secondary %s kind = %v, want %v", city, s.Kind, kind)
			}
			return
		}
	}
	t.Errorf("secondary %s (%v) missing from %+v", city, kind, got.Secondary)
}
