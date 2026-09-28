// Package homecity infers a user's resident city (常驻城市) from synced
// activity signals: the cached GPS start fix of each activity and, when the
// watch named the activity after its city ("上海市 跑步"), the activity-name
// city prefix. One activity contributes at most one vote — the GPS fix when
// present, otherwise the name prefix — so providers that auto-name every
// activity cannot double-count against GPS-covered users.
//
// The detector is deterministic and side-effect free; callers inject the
// evaluation clock so tests and backfills can pin "now". The intended runtime
// is a periodic stride-worker job that stores the latest Result per user.
//
// Algorithm (validated against the 12-user production dataset, 2026-09-28):
//
//  1. Vote pool. Every GPS start is resolved against a city/district anchor
//     table (nearest anchor within MaxAnchorDistanceKM; farther points are
//     discarded as foreign travel or open country). Name prefixes vote for the
//     parsed city directly. Each vote is time-weighted: ×3 within 90 days, ×1.5
//     within a year, ×0.5 older.
//
//  2. Incumbent. The all-history weighted leader is the incumbent resident
//     city. A dense history base beats an intense recent month unless the
//     relocation gate (step 4) says otherwise.
//
//  3. Seasonality. A non-incumbent city with votes in ≥2 distinct years
//     (≥ SeasonalMinVotesPerYear each) AND proof the user returned to the
//     incumbent after the earlier stint is a seasonal base (e.g. summer
//     altitude training in Kunming) and can never trigger relocation.
//
//  4. Relocation. A non-seasonal challenger takes over only when it leads the
//     last 90 days with ≥ RelocationMinShare and ≥ RelocationMinVotes, is still
//     the top city of the last 30 days (≥ RecentMinVotes), and its own span
//     exceeds MinChallengerSpanDays (a race weekend does not move a user).
//     Then Result.City switches, PreviousCity keeps the incumbent, and
//     Relocated is set.
//
//  5. Reporting. Secondary cities with ≥ MinSecondaryShare weighted share are
//     listed with a kind: seasonal, transient (whole span ≤
//     TransientMaxSpanDays, i.e. a one-off camp or trip), or other. The top
//     city of the last 30 days, when different from City, is surfaced as
//     RecentCity to flag in-progress moves.
package homecity

import (
	"math"
	"sort"
	"time"
)

// ActivitySignal is one activity reduced to the two location signals the
// detector consumes. Name is the raw watch-recorded activity name; its city
// prefix is used only when the GPS fix is absent.
type ActivitySignal struct {
	Name        *string
	StartGPSLat *float64
	StartGPSLon *float64
	Time        time.Time
}

// Confidence grades how solid the detection is. None means "not enough data
// to say anything" and accompanies an empty City.
type Confidence string

const (
	ConfidenceNone   Confidence = "none"
	ConfidenceLow    Confidence = "low"
	ConfidenceMedium Confidence = "medium"
	ConfidenceHigh   Confidence = "high"
)

// SecondaryKind explains why a non-resident city shows up in the history.
type SecondaryKind string

const (
	SecondarySeasonal  SecondaryKind = "seasonal"  // recurring stints across years (summer training base)
	SecondaryTransient SecondaryKind = "transient" // one bounded stint: camp, race trip, long holiday
	SecondaryFormer    SecondaryKind = "former"    // the residence a relocation just replaced
	SecondaryOther     SecondaryKind = "other"     // persistent minor presence (workday city, nearby metro)
)

// SecondaryCity is a non-winning city with meaningful weighted presence.
type SecondaryCity struct {
	City          string
	Kind          SecondaryKind
	WeightedShare float64
	VoteCount     int
	FirstSeen     time.Time
	LastSeen      time.Time
	SpanDays      int
}

// Result is the resident-city detection for one user.
type Result struct {
	// City is the detected resident city in the anchor table's naming
	// ("上海市"). Empty with ConfidenceNone when data is insufficient.
	City string
	// District is the finest anchor granularity for City derived from the
	// winner's GPS centroid ("青浦区"); empty when the winner has no GPS votes.
	District string
	// Province is the anchor's province ("上海"/"四川").
	Province string
	// Centroid is the mean of the winner's GPS votes; nil without GPS votes.
	Centroid *Coordinate
	// Source reports which signal carried the winner: "gps" or "name".
	Source string
	// Confidence grades the evidence volume and agreement.
	Confidence Confidence
	// WeightedShare is the winner's fraction of all weighted votes.
	WeightedShare float64
	// VoteCount is the winner's raw vote count (GPS + name fallback).
	VoteCount int
	// TotalVotes is the size of the whole vote pool.
	TotalVotes int

	// Relocated is true when the trailing-window gate switched the resident
	// city away from the all-history incumbent; PreviousCity names it.
	Relocated    bool
	PreviousCity string

	// RecentCity is the top city of the last RecentWindow days when it differs
	// from City — an in-progress move or extended stay worth surfacing.
	RecentCity string

	// Secondary lists up to SecondaryCap non-winning cities, most weighted
	// first, each tagged seasonal / transient / other.
	Secondary []SecondaryCity
}

// Coordinate is a WGS84 point (activity GPS fixes are stored as recorded; for
// China the offset from GCJ-02 is small relative to the 60 km anchor radius).
type Coordinate struct {
	Latitude  float64
	Longitude float64
}

// Options tunes the detector. DefaultOptions carries the values validated
// against production; override mainly in tests and threshold experiments.
type Options struct {
	Now time.Time

	// Anchor resolution.
	Anchors             []Anchor
	MaxAnchorDistanceKM float64

	// Time weighting.
	RecentWeight   float64 // ≤ 90 days
	PastYearWeight float64 // ≤ 365 days
	OlderWeight    float64 // > 365 days

	// Minimum evidence to output a city at all.
	MinVotes         int
	MinTotalWeighted float64

	// Seasonality (blocks relocation for recurring non-resident stints).
	SeasonalMinYears        int
	SeasonalMinVotesPerYear int

	// Relocation gate (challenger must pass every check).
	RelocationWindow      time.Duration
	RelocationMinShare    float64
	RelocationMinVotes    int
	RecentWindow          time.Duration
	RecentMinVotes        int
	MinChallengerSpanDays int

	// Reporting.
	TransientMaxSpanDays int
	MinSecondaryShare    float64
	SecondaryCap         int

	// Confidence thresholds.
	HighConfidenceMinVotes int
	HighConfidenceMinShare float64
	NameMediumMinVotes     int
	NameMediumMinShare     float64
}

// DefaultOptions returns the validated defaults anchored to the evaluation
// clock now.
func DefaultOptions(now time.Time) Options {
	return Options{
		Now:                     now,
		Anchors:                 DefaultAnchors(),
		MaxAnchorDistanceKM:     60,
		RecentWeight:            3,
		PastYearWeight:          1.5,
		OlderWeight:             0.5,
		MinVotes:                3,
		MinTotalWeighted:        3,
		SeasonalMinYears:        2,
		SeasonalMinVotesPerYear: 5,
		RelocationWindow:        90 * 24 * time.Hour,
		RelocationMinShare:      0.5,
		RelocationMinVotes:      10,
		RecentWindow:            30 * 24 * time.Hour,
		RecentMinVotes:          3,
		MinChallengerSpanDays:   30,
		TransientMaxSpanDays:    45,
		MinSecondaryShare:       0.05,
		SecondaryCap:            3,
		HighConfidenceMinVotes:  40,
		HighConfidenceMinShare:  0.6,
		NameMediumMinVotes:      100,
		NameMediumMinShare:      0.7,
	}
}

// vote is one resolved city vote with its provenance. lat/lon carry the GPS
// fix for the winner's centroid; they are zero for name-derived votes.
type vote struct {
	city   string
	hasGPS bool
	weight float64
	at     time.Time
	lat    float64
	lon    float64
}

type cityStats struct {
	weighted  float64
	count     int
	gpsCount  int
	firstSeen time.Time
	lastSeen  time.Time
	// yearVotes buckets raw counts per Shanghai-local calendar year, the
	// seasonality signal.
	yearVotes map[int]int
	// gpsSum accumulates the winner-only centroid.
	latSum, lonSum float64
}

func (s *cityStats) observe(at time.Time, weight float64, hasGPS bool, lat, lon float64) {
	s.count++
	s.weighted += weight
	if hasGPS {
		s.gpsCount++
		s.latSum += lat
		s.lonSum += lon
	}
	if s.firstSeen.IsZero() || at.Before(s.firstSeen) {
		s.firstSeen = at
	}
	if at.After(s.lastSeen) {
		s.lastSeen = at
	}
	s.yearVotes[at.Add(8*time.Hour).Year()]++
}

// Detect reduces one user's activity signals to a resident-city Result.
func Detect(signals []ActivitySignal, opts Options) Result {
	votes := make([]vote, 0, len(signals))
	for _, sig := range signals {
		if v, ok := resolveSignal(sig, opts); ok {
			votes = append(votes, v)
		}
	}

	result := Result{Confidence: ConfidenceNone, TotalVotes: len(votes)}
	if len(votes) < opts.MinVotes {
		return result
	}

	stats := map[string]*cityStats{}
	var totalWeighted float64
	for _, v := range votes {
		s := stats[v.city]
		if s == nil {
			s = &cityStats{yearVotes: map[int]int{}}
			stats[v.city] = s
		}
		s.observe(v.at, v.weight, v.hasGPS, v.lat, v.lon)
		totalWeighted += v.weight
	}
	if totalWeighted < opts.MinTotalWeighted {
		return result
	}

	incumbent := leadingCity(stats)

	// Relocation: a challenger dominating the trailing windows takes over.
	winner := incumbent
	for challenger, cs := range stats {
		if challenger == incumbent || isSeasonal(challenger, cs, incumbent, stats, votes, opts) {
			continue
		}
		if relocationGate(challenger, cs, votes, opts) {
			winner = challenger
		}
	}

	ws := stats[winner]
	result.City = winner
	result.VoteCount = ws.count
	result.WeightedShare = ws.weighted / totalWeighted
	result.Source = "name"
	if ws.gpsCount > 0 {
		result.Source = "gps"
		centroid := Coordinate{Latitude: ws.latSum / float64(ws.gpsCount), Longitude: ws.lonSum / float64(ws.gpsCount)}
		result.Centroid = &centroid
		if anchor, _, ok := nearestAnchor(opts.Anchors, centroid.Latitude, centroid.Longitude); ok && anchorCity(anchor) == winner {
			result.District = anchor.District
			result.Province = anchor.Province
		}
	}

	result.Relocated = winner != incumbent
	if result.Relocated {
		result.PreviousCity = incumbent
	}
	if recent := recentTopCity(votes, opts); recent != "" && recent != winner {
		result.RecentCity = recent
	}
	result.Secondary = secondaryCities(stats, winner, incumbent, totalWeighted, votes, opts)
	result.Confidence = gradeConfidence(result, opts)
	return result
}

// resolveSignal turns one activity into at most one vote: the GPS fix against
// the anchor table, else the name prefix. Signals with neither are dropped.
func resolveSignal(sig ActivitySignal, opts Options) (vote, bool) {
	if sig.StartGPSLat != nil && sig.StartGPSLon != nil && validCoordinate(*sig.StartGPSLat, *sig.StartGPSLon) {
		anchor, distanceKM, ok := nearestAnchor(opts.Anchors, *sig.StartGPSLat, *sig.StartGPSLon)
		if !ok || distanceKM > opts.MaxAnchorDistanceKM {
			// No anchor within radius: foreign travel or open country —
			// discard rather than force-assign to a distant city.
			return vote{}, false
		}
		return vote{
			city:   anchorCity(anchor),
			hasGPS: true,
			weight: timeWeight(sig.Time, opts),
			at:     sig.Time,
			lat:    *sig.StartGPSLat,
			lon:    *sig.StartGPSLon,
		}, true
	}
	if city, ok := ParseCityHint(sig.Name); ok {
		return vote{city: city, weight: timeWeight(sig.Time, opts), at: sig.Time}, true
	}
	return vote{}, false
}

func timeWeight(at time.Time, opts Options) float64 {
	age := opts.Now.Sub(at)
	switch {
	case age <= 90*24*time.Hour:
		return opts.RecentWeight
	case age <= 365*24*time.Hour:
		return opts.PastYearWeight
	default:
		return opts.OlderWeight
	}
}

// leadingCity picks the maximum-weighted city, breaking ties by the most
// recent last activity.
func leadingCity(stats map[string]*cityStats) string {
	best := ""
	for city, s := range stats {
		if best == "" || s.weighted > stats[best].weighted ||
			(s.weighted == stats[best].weighted && s.lastSeen.After(stats[best].lastSeen)) {
			best = city
		}
	}
	return best
}

// isSeasonal reports whether city's presence recurs across years with the user
// returning to the incumbent in between — a recurring training base, not a
// move. The return-home check is what separates "two summer camps" from "lived
// there two years then left": after the challenger's last vote of the
// second-to-last qualifying year, the incumbent must appear again. A city that
// is still the user's most recent presence is never seasonal, so seasonality
// cannot mask an in-progress move.
func isSeasonal(city string, cs *cityStats, incumbent string, stats map[string]*cityStats, votes []vote, opts Options) bool {
	if len(cs.yearVotes) < opts.SeasonalMinYears {
		return false
	}
	years := make([]int, 0, len(cs.yearVotes))
	for year, count := range cs.yearVotes {
		if count >= opts.SeasonalMinVotesPerYear {
			years = append(years, year)
		}
	}
	if len(years) < opts.SeasonalMinYears {
		return false
	}
	sort.Ints(years)
	earlierYear := years[len(years)-2]
	lastVoteOfEarlierYear := time.Time{}
	for _, v := range votes {
		if v.city == city && v.at.Add(8*time.Hour).Year() == earlierYear && v.at.After(lastVoteOfEarlierYear) {
			lastVoteOfEarlierYear = v.at
		}
	}
	inc, ok := stats[incumbent]
	if !ok {
		return false
	}
	// A challenger that is the single most recent presence overall is an
	// active pattern, not a closed recurring stint — seasonality must not
	// mask it. Any other city appearing after the challenger's last vote
	// (the incumbent itself, or a newer destination) reopens seasonality.
	var otherLastSeen time.Time
	for other, s2 := range stats {
		if other != city && s2.lastSeen.After(otherLastSeen) {
			otherLastSeen = s2.lastSeen
		}
	}
	if !cs.lastSeen.Before(otherLastSeen) {
		return false
	}
	return inc.lastSeen.After(lastVoteOfEarlierYear)
}

// relocationGate holds the trailing-window checks every challenger must pass.
func relocationGate(city string, cs *cityStats, votes []vote, opts Options) bool {
	windowStart := opts.Now.Add(-opts.RelocationWindow)
	var windowWeight float64
	challengerWeight := 0.0
	challengerCount := 0
	for _, v := range votes {
		if v.at.Before(windowStart) {
			continue
		}
		windowWeight += v.weight
		if v.city == city {
			challengerWeight += v.weight
			challengerCount++
		}
	}
	if windowWeight == 0 || challengerCount < opts.RelocationMinVotes || challengerWeight/windowWeight < opts.RelocationMinShare {
		return false
	}
	if cs.lastSeen.Sub(cs.firstSeen) < time.Duration(opts.MinChallengerSpanDays)*24*time.Hour {
		return false
	}
	return recentTopCity(votes, opts) == city
}

// recentTopCity returns the leading city by raw count inside the recent
// window, or "" when no city reaches RecentMinVotes there.
func recentTopCity(votes []vote, opts Options) string {
	windowStart := opts.Now.Add(-opts.RecentWindow)
	counts := map[string]int{}
	for _, v := range votes {
		if !v.at.Before(windowStart) {
			counts[v.city]++
		}
	}
	best, bestCount := "", 0
	for city, count := range counts {
		if count > bestCount || (count == bestCount && city < best) {
			best, bestCount = city, count
		}
	}
	if bestCount < opts.RecentMinVotes {
		return ""
	}
	return best
}

// secondaryCities reports non-winning cities above the share floor. The city
// a relocation just replaced (if any) is tagged former — it is still the bulk
// of the history, which is also why fresh relocations cap at medium
// confidence.
func secondaryCities(stats map[string]*cityStats, winner, incumbent string, totalWeighted float64, votes []vote, opts Options) []SecondaryCity {
	var out []SecondaryCity
	for city, s := range stats {
		if city == winner {
			continue
		}
		share := s.weighted / totalWeighted
		if share < opts.MinSecondaryShare {
			continue
		}
		kind := SecondaryOther
		span := int(s.lastSeen.Sub(s.firstSeen).Hours() / 24)
		switch {
		case incumbent != winner && city == incumbent:
			kind = SecondaryFormer
		case span <= opts.TransientMaxSpanDays:
			kind = SecondaryTransient
		case isSeasonal(city, s, winner, stats, votes, opts):
			kind = SecondarySeasonal
		}
		out = append(out, SecondaryCity{
			City: city, Kind: kind, WeightedShare: share,
			VoteCount: s.count, FirstSeen: s.firstSeen, LastSeen: s.lastSeen, SpanDays: span,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].WeightedShare != out[j].WeightedShare {
			return out[i].WeightedShare > out[j].WeightedShare
		}
		return out[i].City < out[j].City
	})
	if len(out) > opts.SecondaryCap {
		out = out[:opts.SecondaryCap]
	}
	return out
}

// gradeConfidence maps evidence volume and agreement onto the four levels.
func gradeConfidence(r Result, opts Options) Confidence {
	if r.City == "" {
		return ConfidenceNone
	}
	if r.Relocated {
		// A fresh move is reported one notch lower: the incumbent base is
		// still the bulk of the history.
		if r.Source == "gps" && r.VoteCount >= opts.RelocationMinVotes {
			return ConfidenceMedium
		}
		return ConfidenceLow
	}
	switch r.Source {
	case "gps":
		switch {
		case r.VoteCount >= opts.HighConfidenceMinVotes && r.WeightedShare >= opts.HighConfidenceMinShare:
			return ConfidenceHigh
		case r.VoteCount >= opts.RelocationMinVotes && r.WeightedShare >= 0.35:
			return ConfidenceMedium
		default:
			return ConfidenceLow
		}
	default: // name-only
		switch {
		case r.VoteCount >= opts.NameMediumMinVotes && r.WeightedShare >= opts.NameMediumMinShare:
			return ConfidenceMedium
		default:
			return ConfidenceLow
		}
	}
}

func validCoordinate(latitude, longitude float64) bool {
	return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 && (latitude != 0 || longitude != 0)
}

// haversineKM mirrors racedetection's distance helper; kept private so the two
// packages can evolve independently.
func haversineKM(lat1, lon1, lat2, lon2 float64) float64 {
	const earthRadiusKM = 6371.0088
	radLat1 := lat1 * math.Pi / 180
	radLat2 := lat2 * math.Pi / 180
	deltaLat := (lat2 - lat1) * math.Pi / 180
	deltaLon := (lon2 - lon1) * math.Pi / 180
	h := math.Sin(deltaLat/2)*math.Sin(deltaLat/2) + math.Cos(radLat1)*math.Cos(radLat2)*math.Sin(deltaLon/2)*math.Sin(deltaLon/2)
	return earthRadiusKM * 2 * math.Atan2(math.Sqrt(h), math.Sqrt(1-h))
}
