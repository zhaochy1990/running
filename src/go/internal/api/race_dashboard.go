package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// raceDashboardCityStore is the city-content lookup the publish dashboard adds
// to the calendar surface. It is a one-method interface so raceCalendarRoutes
// depends on the batch read alone; *storage.Store satisfies it via
// Config.RaceContentStore, and a nil store simply leaves the endpoint
// unregistered (the calendar routes work without it).
type raceDashboardCityStore interface {
	ListRaceCityContentByCities(ctx context.Context, cities []string) ([]storage.RaceCityContent, error)
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

// raceDashboardResponse is the whole GET /api/admin/races/dashboard payload:
// four mutually exclusive buckets, each carrying its full row list (no
// pagination — upcoming+cn measured ~127 rows in production, and the sync-new
// bucket is deliberately unbounded so nothing awaiting triage can hide behind
// a page break; spec devops#473 §3).
type raceDashboardResponse struct {
	Published raceDashboardBucket `json:"published"`
	Pending   raceDashboardBucket `json:"pending"`
	Missing   raceDashboardBucket `json:"missing"`
	NewSync   raceDashboardBucket `json:"new_sync"`
}

type raceDashboardBucket struct {
	Races []raceDashboardRace `json:"races"`
}

// raceDashboardRace is one RaceRow of the dashboard. Gates and observations
// ride on every row of the published/pending/missing buckets (a published race
// keeps its gates visible so residual gaps stay actionable); rows of the
// sync-new bucket omit both — an untouched row is missing everything by
// definition, which the bucket itself already says.
type raceDashboardRace struct {
	ID       uint64  `json:"id"`
	Name     string  `json:"name"`
	NameCN   *string `json:"name_cn"`
	RaceDate string  `json:"race_date"`
	// Country rides along beyond the spec's common-field list so the scope=all
	// view can fold international rows by the same predicate the endpoint
	// filters with (source would wrongly fold the 国际田联-mirrored Chinese
	// majors).
	Country      string    `json:"country"`
	City         *string   `json:"city"`
	Province     *string   `json:"province"`
	Source       string    `json:"source"`
	Origin       string    `json:"origin"`
	RaceTypes    []string  `json:"race_types"`
	Label        *string   `json:"label"`
	WALabel      *string   `json:"wa_label"`
	Published    bool      `json:"published"`
	ContentStale bool      `json:"content_stale"`
	CreatedAt    time.Time `json:"created_at"`
	// ContentSource/UpdatedAt are the automation tie-in surfaces (the daily
	// fill job stamps WebSearch/updated_at); exposed for future review
	// queues, unused by the一期 UI.
	ContentSource *string                    `json:"content_source"`
	UpdatedAt     time.Time                  `json:"updated_at"`
	Gates         *raceDashboardGates        `json:"gates,omitempty"`
	Observations  *raceDashboardObservations `json:"observations,omitempty"`
}

// raceDashboardGates is the three-threshold verdict of spec devops#473 §2.
// Data is per-item; City and Weather are event-level booleans.
type raceDashboardGates struct {
	Data    raceDashboardDataGate    `json:"data"`
	City    raceDashboardBooleanGate `json:"city"`
	Weather raceDashboardWeatherGate `json:"weather"`
}

// raceDashboardDataGate passes only when the event has at least one item and
// every item carries all seven data-gate fields. NoItems marks the bare-row
// case (an event with zero items can never pass, and there is nothing to list
// per item).
type raceDashboardDataGate struct {
	OK      bool                    `json:"ok"`
	NoItems bool                    `json:"no_items,omitempty"`
	Items   []raceDashboardItemGate `json:"items,omitempty"`
}

// raceDashboardItemGate names the data-gate fields one item is missing.
// distance_km is part of the gate (spec §2) and therefore part of this
// vocabulary even though the spec's RaceRow section omits it — a failing gate
// must be explainable from the payload alone.
type raceDashboardItemGate struct {
	Name    string   `json:"name"`
	Missing []string `json:"missing"`
}

type raceDashboardBooleanGate struct {
	OK bool `json:"ok"`
}

// raceDashboardWeatherGate names which of the two weather sub-conditions
// failed: climate (a non-empty summary) or weather_windows (at least two).
type raceDashboardWeatherGate struct {
	OK      bool     `json:"ok"`
	Missing []string `json:"missing,omitempty"`
}

// raceDashboardObservations lists the watch-list fields the race has nothing
// for. They are NOT publish gates — an administrator may publish without them.
type raceDashboardObservations struct {
	Missing []string `json:"missing"`
}

// ─── handler ─────────────────────────────────────────────────────────────────

// raceDashboardFilter is the parsed dashboard query: the country code storage
// filters on, plus the Shanghai-date time bounds the handler applies in Go
// (from inclusive, to exclusive; empty = unbounded).
type raceDashboardFilter struct {
	country string
	from    string
	to      string
}

// dashboard returns the four-bucket publish state of the race calendar.
//
//	@Summary		Publish dashboard
//	@Description	Administrator only. Buckets races into published / ready-to-publish / missing-info / new-from-sync per the spec's decision tree. time splits upcoming (race_date >= today, by calendar date) and past (race_date < today); the new-from-sync bucket ignores time entirely. scope=cn narrows to country=CHN. Rows carry their three-gate verdict and watch-list gaps; sync-new rows omit them.
//	@Tags			admin
//	@Param			time	query	string	false	"upcoming (default) / past / all"
//	@Param			scope	query	string	false	"cn (default, country=CHN) / all"
//	@Success		200		{object}	raceDashboardResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/dashboard [get]
func (r *raceCalendarRoutes) dashboard(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	filter, ok := bindRaceDashboardFilter(c)
	if !ok {
		return
	}
	rows, err := r.store.ListRaceCalendarDashboardRows(c.Request.Context(), filter.country)
	if err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}

	eventIDs := make([]uint64, 0, len(rows))
	cities := make([]string, 0, len(rows))
	citySeen := make(map[string]bool, len(rows))
	for _, row := range rows {
		eventIDs = append(eventIDs, row.ID)
		if row.City != nil && !citySeen[*row.City] {
			citySeen[*row.City] = true
			cities = append(cities, *row.City)
		}
	}
	items, err := r.store.ListRaceCalendarItemsByEventIDs(c.Request.Context(), eventIDs)
	if err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	var cityContents []storage.RaceCityContent
	if r.cities != nil {
		cityContents, err = r.cities.ListRaceCityContentByCities(c.Request.Context(), cities)
		if err != nil {
			writeRaceCalendarError(c, r.log, err)
			return
		}
	}

	itemsByEvent := make(map[uint64][]storage.RaceCalendarItem, len(rows))
	for _, item := range items {
		itemsByEvent[item.RaceEventID] = append(itemsByEvent[item.RaceEventID], item)
	}
	contentByCity := make(map[string]*storage.RaceCityContent, len(cityContents))
	for i := range cityContents {
		contentByCity[cityContents[i].City] = &cityContents[i]
	}

	out := raceDashboardResponse{
		Published: raceDashboardBucket{Races: []raceDashboardRace{}},
		Pending:   raceDashboardBucket{Races: []raceDashboardRace{}},
		Missing:   raceDashboardBucket{Races: []raceDashboardRace{}},
		NewSync:   raceDashboardBucket{Races: []raceDashboardRace{}},
	}
	// rows arrive race_date/name/id ordered and the loop preserves that order,
	// so every bucket comes out sorted per the spec without a re-sort.
	for _, row := range rows {
		rowItems := itemsByEvent[row.ID]
		neverMaintained := row.Origin == storage.RaceOriginSync && raceNeverMaintained(row, rowItems)
		// The time domain is the handler's call, not storage's: the sync-new
		// bucket ignores time, so an out-of-domain row survives only when it is
		// genuinely an untouched sync row; everything else is dropped here.
		if !raceDashboardInTimeDomain(row, filter) && !neverMaintained {
			continue
		}
		switch {
		case row.Published:
			gates, observations := r.dashboardVerdict(row, rowItems, contentByCity)
			out.Published.Races = append(out.Published.Races, newRaceDashboardRace(row, gates, observations))
		case neverMaintained:
			out.NewSync.Races = append(out.NewSync.Races, newRaceDashboardRace(row, nil, nil))
		default:
			gates, observations := r.dashboardVerdict(row, rowItems, contentByCity)
			if gates.Data.OK && gates.City.OK && gates.Weather.OK {
				out.Pending.Races = append(out.Pending.Races, newRaceDashboardRace(row, gates, observations))
			} else {
				out.Missing.Races = append(out.Missing.Races, newRaceDashboardRace(row, gates, observations))
			}
		}
	}
	c.JSON(http.StatusOK, out)
}

// raceDashboardInTimeDomain applies the requested date bounds in Go — from
// inclusive, to exclusive, both compared as "2006-01-02" strings.
func raceDashboardInTimeDomain(row storage.RaceCalendarEvent, filter raceDashboardFilter) bool {
	if filter.from != "" && row.RaceDate < filter.from {
		return false
	}
	if filter.to != "" && row.RaceDate >= filter.to {
		return false
	}
	return true
}

// dashboardVerdict computes the three-gate verdict and the watch-list gaps of
// one race against its items and city content.
func (r *raceCalendarRoutes) dashboardVerdict(row storage.RaceCalendarEvent, items []storage.RaceCalendarItem, contentByCity map[string]*storage.RaceCityContent) (*raceDashboardGates, *raceDashboardObservations) {
	var cityContent *storage.RaceCityContent
	if row.City != nil {
		cityContent = contentByCity[*row.City]
	}
	gates := &raceDashboardGates{
		Data:    raceDashboardDataGateFor(items),
		City:    raceDashboardCityGateFor(row, cityContent),
		Weather: raceDashboardWeatherGateFor(row),
	}
	observations := raceDashboardObservationsFor(row, items)
	return gates, &observations
}

// ─── gating ──────────────────────────────────────────────────────────────────

// bindRaceDashboardFilter parses the dashboard query in the same style as
// bindRaceListFilter: an unknown value is a 400 with a dedicated error code,
// an absent value takes the spec default.
func bindRaceDashboardFilter(c *gin.Context) (raceDashboardFilter, bool) {
	var filter raceDashboardFilter
	today := timefmt.ShanghaiToday().Format("2006-01-02")
	switch strings.TrimSpace(c.Query("time")) {
	case "", "upcoming":
		filter.from = today
	case "past":
		filter.to = today
	case "all":
	default:
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_time"})
		return filter, false
	}
	switch strings.TrimSpace(c.Query("scope")) {
	case "", "cn":
		filter.country = "CHN"
	case "all":
	default:
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_scope"})
		return filter, false
	}
	return filter, true
}

// raceNeverMaintained reports whether a sync-origin row has never been touched
// by an administrator: none of the six event content sections, no field
// overrides, and nothing admin-authored on any item (content, one of the entry
// fields the sync never writes, or a detached row). Such a row stays in the
// sync-new bucket until someone maintains it — no time window applies.
func raceNeverMaintained(row storage.RaceCalendarEvent, items []storage.RaceCalendarItem) bool {
	if row.HasContent() || len(row.AdminOverrides) > 0 {
		return false
	}
	for _, item := range items {
		if item.HasAdminData() {
			return false
		}
	}
	return true
}

// raceDashboardDataGateFor evaluates the per-item data gate. The gate passes
// only when the event has at least one item and every item carries all seven
// fields.
func raceDashboardDataGateFor(items []storage.RaceCalendarItem) raceDashboardDataGate {
	if len(items) == 0 {
		return raceDashboardDataGate{OK: false, NoItems: true}
	}
	gates := make([]raceDashboardItemGate, 0, len(items))
	ok := true
	for _, item := range items {
		gate := raceDashboardItemGateFor(item)
		if len(gate.Missing) > 0 {
			ok = false
		}
		gates = append(gates, gate)
	}
	return raceDashboardDataGate{OK: ok, Items: gates}
}

// raceDashboardItemGateFor lists the data-gate fields one item is missing, in
// the spec's field order.
func raceDashboardItemGateFor(item storage.RaceCalendarItem) raceDashboardItemGate {
	missing := make([]string, 0, 7)
	if raceRouteDescriptionMissing(item.RouteDescription) {
		missing = append(missing, "route_description")
	}
	if item.StartPoint == nil || item.StartPoint.Lat == nil {
		missing = append(missing, "start_point")
	}
	if item.FinishPoint == nil || item.FinishPoint.Lat == nil {
		missing = append(missing, "finish_point")
	}
	if item.DistanceKm == nil {
		missing = append(missing, "distance_km")
	}
	if item.StartTime == nil {
		missing = append(missing, "start_time")
	}
	if item.EntryFee == nil {
		missing = append(missing, "entry_fee")
	}
	if item.Quota == nil {
		missing = append(missing, "quota")
	}
	return raceDashboardItemGate{Name: item.Name, Missing: missing}
}

// raceRouteDescriptionMissing applies the data-gate rule for the route text:
// present only when non-blank and not a sync-era placeholder stub.
func raceRouteDescriptionMissing(route *string) bool {
	if route == nil {
		return true
	}
	trimmed := strings.TrimSpace(*route)
	return trimmed == "" || strings.HasPrefix(trimmed, "（注：")
}

// raceDashboardCityGateFor requires a city on the row and a race_city_content
// row for exactly that city spelling carrying an intro.
func raceDashboardCityGateFor(row storage.RaceCalendarEvent, content *storage.RaceCityContent) raceDashboardBooleanGate {
	if row.City == nil || strings.TrimSpace(*row.City) == "" {
		return raceDashboardBooleanGate{OK: false}
	}
	if content == nil || content.Intro == nil {
		return raceDashboardBooleanGate{OK: false}
	}
	return raceDashboardBooleanGate{OK: true}
}

// raceDashboardWeatherGateFor requires a climate summary and at least two
// historical weather windows, naming whichever sub-condition is unmet.
func raceDashboardWeatherGateFor(row storage.RaceCalendarEvent) raceDashboardWeatherGate {
	var missing []string
	if row.Climate == nil || strings.TrimSpace(row.Climate.Summary) == "" {
		missing = append(missing, "climate")
	}
	if len(row.WeatherWindows) < 2 {
		missing = append(missing, "weather_windows")
	}
	return raceDashboardWeatherGate{OK: len(missing) == 0, Missing: missing}
}

// raceDashboardObservationsFor lists the watch-list fields (the eleven
// non-gate sections of spec devops#473 §2) the race has nothing for, in the
// spec's canonical order. Item-level sections count as maintained when any
// item carries them — the races evaluated here mostly have one or two items,
// and per-item granularity below the gate level is noise for a badge count.
func raceDashboardObservationsFor(row storage.RaceCalendarEvent, items []storage.RaceCalendarItem) raceDashboardObservations {
	missing := make([]string, 0, 11)
	if row.SignupTimeline == nil {
		missing = append(missing, "signup_timeline")
	}
	if len(row.SignupChannels) == 0 {
		missing = append(missing, "signup_channels")
	}
	if row.PartitionRule == nil {
		missing = append(missing, "partition_rule")
	}
	if len(row.PacketPickup) == 0 {
		missing = append(missing, "packet_pickup")
	}
	anyItem := func(test func(storage.RaceCalendarItem) bool) bool {
		for _, item := range items {
			if test(item) {
				return true
			}
		}
		return false
	}
	if !anyItem(func(item storage.RaceCalendarItem) bool { return len(item.Cutoffs) > 0 }) {
		missing = append(missing, "cutoffs")
	}
	if !anyItem(func(item storage.RaceCalendarItem) bool { return len(item.AidStations) > 0 }) {
		missing = append(missing, "aid_stations")
	}
	if !anyItem(func(item storage.RaceCalendarItem) bool { return item.TotalAscentM != nil }) {
		missing = append(missing, "total_ascent_m")
	}
	if !anyItem(func(item storage.RaceCalendarItem) bool { return len(item.CourseChallenges) > 0 }) {
		missing = append(missing, "course_challenges")
	}
	if !anyItem(func(item storage.RaceCalendarItem) bool { return len(item.Prizes) > 0 }) {
		missing = append(missing, "prizes")
	}
	if !anyItem(func(item storage.RaceCalendarItem) bool { return item.Reputation != nil }) {
		missing = append(missing, "reputation")
	}
	if !anyItem(func(item storage.RaceCalendarItem) bool { return len(item.Photos) > 0 }) {
		missing = append(missing, "photos")
	}
	return raceDashboardObservations{Missing: missing}
}

// newRaceDashboardRace projects the common RaceRow fields; nil gates /
// observations (the sync-new bucket) serialize as omitted keys.
func newRaceDashboardRace(row storage.RaceCalendarEvent, gates *raceDashboardGates, observations *raceDashboardObservations) raceDashboardRace {
	return raceDashboardRace{
		ID:            row.ID,
		Name:          row.Name,
		NameCN:        row.NameCN,
		RaceDate:      row.RaceDate,
		Country:       row.Country,
		City:          row.City,
		Province:      row.Province,
		Source:        row.Source,
		Origin:        row.Origin,
		RaceTypes:     decodeRaceTypes(row.RaceTypes),
		Label:         row.Label,
		WALabel:       row.WALabel,
		Published:     row.Published,
		ContentStale:  row.ContentStale,
		CreatedAt:     row.CreatedAt,
		ContentSource: row.ContentSource,
		UpdatedAt:     row.UpdatedAt,
		Gates:         gates,
		Observations:  observations,
	}
}
