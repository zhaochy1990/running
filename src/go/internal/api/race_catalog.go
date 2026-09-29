package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// RaceCatalogStore is the persistence the user-facing race catalog reads. It is
// a strict subset of the admin surface: the two list methods differ (published
// only, user filters), and everything else is shared row access.
type RaceCatalogStore interface {
	ListPublishedRaceCalendarEvents(ctx context.Context, f storage.PublishedRaceFilter) ([]storage.RaceCalendarEvent, int64, error)
	GetRaceCalendarEvent(ctx context.Context, id uint64) (*storage.RaceCalendarEvent, error)
	ListRaceCalendarItems(ctx context.Context, eventID uint64) ([]storage.RaceCalendarItem, error)
	GetRaceCityContent(ctx context.Context, city string) (*storage.RaceCityContent, error)
	FavoritedRaceEventIDs(ctx context.Context, userID string, eventIDs []uint64) (map[uint64]bool, error)
}

// raceCatalogRoutes serves the user-facing race catalog (issue #390): the
// 小程序 race center's published races, read-only. Distinct from the admin
// raceCalendarRoutes in both projection (no admin fields: origin, source,
// admin_overrides, content_source, published…) and access (user tier only).
type raceCatalogRoutes struct {
	store RaceCatalogStore
	log   *zap.Logger
}

func newRaceCatalogRoutes(store RaceCatalogStore, log *zap.Logger) *raceCatalogRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &raceCatalogRoutes{store: store, log: log}
}

// register mounts the user-facing race-catalog endpoints. They live on the
// default-deny (rejectAdminCaller) group: the dashboard admin reaches the same
// rows through /api/admin/races.
func (r *raceCatalogRoutes) register(rg *gin.RouterGroup) {
	if r.store == nil {
		return
	}
	rg.GET("/api/race-calendar", r.list)
	rg.GET("/api/race-calendar/:race_id", r.detail)
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

// userRaceSummaryDTO is one list row: what the 密表行 needs (date, name+city,
// label badges, race types, star). race_types is decoded from the stored JSON
// array so the client never parses a JSON string.
type userRaceSummaryDTO struct {
	ID        uint64   `json:"id"`
	Name      string   `json:"name"`
	NameCN    *string  `json:"name_cn"`
	RaceDate  string   `json:"race_date"`
	Province  *string  `json:"province"`
	City      *string  `json:"city"`
	Label     *string  `json:"label"`
	WALabel   *string  `json:"wa_label"`
	RaceTypes []string `json:"race_types"`
	// Favorited is whether the requesting user stars this race (race_favorite).
	// The toggle itself is #391; this read is what lights up the star state.
	Favorited bool `json:"favorited"`
}

// userRaceItemDTO is one 项目 row of the detail: entry fields plus the twelve
// per-distance content columns, projected verbatim. EntryFee is in 分 (fen),
// the storage unit — the client renders 元.
type userRaceItemDTO struct {
	ID        uint64  `json:"id"`
	Name      string  `json:"name"`
	Type      string  `json:"type"`
	StartTime *string `json:"start_time"`
	EntryFee  *int    `json:"entry_fee"`
	Quota     *int    `json:"quota"`

	DistanceKm       *float64                      `json:"distance_km"`
	StartPoint       *storage.RacePoint            `json:"start_point"`
	FinishPoint      *storage.RacePoint            `json:"finish_point"`
	RouteDescription *string                       `json:"route_description"`
	TotalAscentM     *int                          `json:"total_ascent_m"`
	ElevationPoints  []storage.RaceElevationPoint  `json:"elevation_points"`
	CourseChallenges []storage.RaceCourseChallenge `json:"course_challenges"`
	AidStations      []storage.RaceAidStation      `json:"aid_stations"`
	Cutoffs          []storage.RaceCutoff          `json:"cutoffs"`
	Prizes           []storage.RacePrize           `json:"prizes"`
	Reputation       *storage.RaceReputation       `json:"reputation"`
	Photos           []storage.RacePhoto           `json:"photos"`
}

// userCityContentDTO is the detail's 城市介绍 (race_city_content), null when
// the city has none (the 出行 tab renders its 待发布 empty state).
type userCityContentDTO struct {
	City        string                   `json:"city"`
	Province    *string                  `json:"province"`
	Intro       *storage.CityIntro       `json:"intro"`
	Attractions []storage.CityAttraction `json:"attractions"`
}

// userRaceDetailDTO is the detail page shape: the summary fields plus the three
// event-level content sections, the item list, and the city introduction.
// All sections are absent-when-empty as null/[] — the UI's uniform 空态 covers
// the gaps.
type userRaceDetailDTO struct {
	userRaceSummaryDTO
	SignupTimeline *storage.RaceSignupTimeline `json:"signup_timeline"`
	SignupChannels []storage.RaceSignupChannel `json:"signup_channels"`
	PacketPickup   []storage.RacePacketPickup  `json:"packet_pickup"`
	Items          []userRaceItemDTO           `json:"items"`
	CityContent    *userCityContentDTO         `json:"city_content"`
}

type userRaceListResponse struct {
	Races   []userRaceSummaryDTO `json:"races"`
	Total   int64                `json:"total"`
	Page    int                  `json:"page"`
	PerPage int                  `json:"per_page"`
}

func newUserRaceSummaryDTO(row storage.RaceCalendarEvent, favorited bool) userRaceSummaryDTO {
	return userRaceSummaryDTO{
		ID:        row.ID,
		Name:      row.Name,
		NameCN:    row.NameCN,
		RaceDate:  row.RaceDate,
		Province:  row.Province,
		City:      row.City,
		Label:     row.Label,
		WALabel:   row.WALabel,
		RaceTypes: decodeRaceTypes(row.RaceTypes),
		Favorited: favorited,
	}
}

func newUserRaceItemDTO(row storage.RaceCalendarItem) userRaceItemDTO {
	return userRaceItemDTO{
		ID:               row.ID,
		Name:             row.Name,
		Type:             row.Type,
		StartTime:        row.StartTime,
		EntryFee:         row.EntryFee,
		Quota:            row.Quota,
		DistanceKm:       row.DistanceKm,
		StartPoint:       row.StartPoint,
		FinishPoint:      row.FinishPoint,
		RouteDescription: row.RouteDescription,
		TotalAscentM:     row.TotalAscentM,
		ElevationPoints:  row.ElevationPoints,
		CourseChallenges: row.CourseChallenges,
		AidStations:      row.AidStations,
		Cutoffs:          row.Cutoffs,
		Prizes:           row.Prizes,
		Reputation:       row.Reputation,
		Photos:           row.Photos,
	}
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// writeRaceCatalogReadError maps storage errors for the read-only catalog via
// the shared writeRaceCalendarError mapping (nil logger silences its
// "write failed" line), then logs the failure with read wording.
func writeRaceCatalogReadError(c *gin.Context, log *zap.Logger, err error) {
	if log != nil && !errors.Is(err, storage.ErrRaceCalendarNotFound) {
		log.Error("race catalog read failed", zap.Error(err))
	}
	writeRaceCalendarError(c, nil, err)
}

// list returns one page of published races for the race center (issue #390).
//
//	@Summary		List published races
//	@Description	User tier only. Returns a page of published races ordered by race date, filtered by year (defaults to the current Shanghai year), optional item type (via the race's 项目 rows), optional city, and the upcoming scope. scope=upcoming (the default) keeps only races with race_date >= today (Shanghai); scope=all returns the whole year — the year-switching view of history. Each row carries the requesting user's favorited star state.
//	@Tags			races
//	@Param			year		query	int		false	"4-digit year (defaults to the current Shanghai year)"
//	@Param			type		query	string	false	"Race type token (Marathon / HalfMarathon / {n}Km…), matched against the race's items"
//	@Param			city		query	string	false	"City (race_calendar.city spelling, e.g. 厦门市)"
//	@Param			scope		query	string	false	"upcoming (default) or all"
//	@Param			page		query	int		false	"Page (1-based, default 1)"
//	@Param			per_page	query	int		false	"Page size (default 20, max 100)"
//	@Success		200			{object}	userRaceListResponse
//	@Failure		400			{object}	errorResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/race-calendar [get]
func (r *raceCatalogRoutes) list(c *gin.Context) {
	userID, ok := requireUser(c)
	if !ok {
		return
	}
	filter, ok := bindPublishedRaceFilter(c)
	if !ok {
		return
	}
	rows, total, err := r.store.ListPublishedRaceCalendarEvents(c.Request.Context(), filter)
	if err != nil {
		writeRaceCatalogReadError(c, r.log, err)
		return
	}
	ids := make([]uint64, len(rows))
	for i, row := range rows {
		ids[i] = row.ID
	}
	favorited, err := r.store.FavoritedRaceEventIDs(c.Request.Context(), userID, ids)
	if err != nil {
		writeRaceCatalogReadError(c, r.log, err)
		return
	}
	races := make([]userRaceSummaryDTO, 0, len(rows))
	for _, row := range rows {
		races = append(races, newUserRaceSummaryDTO(row, favorited[row.ID]))
	}
	c.JSON(http.StatusOK, userRaceListResponse{
		Races:   races,
		Total:   total,
		Page:    filter.Page,
		PerPage: filter.PerPage,
	})
}

// bindPublishedRaceFilter parses the query string into a ready storage filter,
// resolving the defaults: year → the current Shanghai year, scope → upcoming,
// page → 1, per_page → 20 (max 100).
func bindPublishedRaceFilter(c *gin.Context) (storage.PublishedRaceFilter, bool) {
	// One "today" for both the default year and the upcoming floor: two calls
	// could straddle Shanghai midnight and pair last year's window with next
	// year's floor.
	today := timefmt.ShanghaiToday()
	year := c.Query("year")
	if year == "" {
		year = strconv.Itoa(today.Year())
	} else if !isFourDigitYear(year) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_year"})
		return storage.PublishedRaceFilter{}, false
	}
	scope := c.DefaultQuery("scope", "upcoming")
	fromDate := ""
	switch scope {
	case "upcoming":
		fromDate = today.Format("2006-01-02")
	case "all":
	default:
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_scope"})
		return storage.PublishedRaceFilter{}, false
	}
	// Unlike the admin list (which 400s on a bad page), the user surface
	// clamps silently: a 小程序 client should never hard-fail over a page
	// number it computed itself.
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 {
		page = 1
	}
	perPage, err := strconv.Atoi(c.DefaultQuery("per_page", "20"))
	if err != nil || perPage < 1 {
		perPage = 20
	}
	if perPage > 100 {
		perPage = 100
	}
	return storage.PublishedRaceFilter{
		Year:     year,
		FromDate: fromDate,
		Type:     c.Query("type"),
		City:     c.Query("city"),
		Page:     page,
		PerPage:  perPage,
	}, true
}

// detail returns one published race with its items and city introduction.
//
//	@Summary		Get a published race
//	@Description	User tier only. Returns a published race's detail: the event's public fields and signup/packet-pickup sections, its 项目 rows with the twelve per-distance content columns, and the city introduction (null when unmaintained). Unpublished or missing races both answer 404, so an unpublished row's existence is not leaked.
//	@Tags			races
//	@Param			race_id	path	int	true	"Race id"
//	@Success		200		{object}	userRaceDetailDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/race-calendar/{race_id} [get]
func (r *raceCatalogRoutes) detail(c *gin.Context) {
	userID, ok := requireUser(c)
	if !ok {
		return
	}
	id, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	row, err := r.store.GetRaceCalendarEvent(c.Request.Context(), id)
	if err != nil {
		writeRaceCatalogReadError(c, r.log, err)
		return
	}
	if !row.Published {
		// Same answer as a missing row: an unpublished race is invisible to
		// users, including its existence.
		c.JSON(http.StatusNotFound, errorResponse{Error: "race_not_found"})
		return
	}
	items, err := r.store.ListRaceCalendarItems(c.Request.Context(), row.ID)
	if err != nil {
		writeRaceCatalogReadError(c, r.log, err)
		return
	}
	favorited, err := r.store.FavoritedRaceEventIDs(c.Request.Context(), userID, []uint64{row.ID})
	if err != nil {
		writeRaceCatalogReadError(c, r.log, err)
		return
	}
	itemDTOs := make([]userRaceItemDTO, 0, len(items))
	for _, item := range items {
		itemDTOs = append(itemDTOs, newUserRaceItemDTO(item))
	}
	detail := userRaceDetailDTO{
		userRaceSummaryDTO: newUserRaceSummaryDTO(*row, favorited[row.ID]),
		SignupTimeline:     row.SignupTimeline,
		SignupChannels:     row.SignupChannels,
		PacketPickup:       row.PacketPickup,
		Items:              itemDTOs,
	}
	if row.City != nil {
		city, err := r.store.GetRaceCityContent(c.Request.Context(), *row.City)
		if err != nil {
			writeRaceCatalogReadError(c, r.log, err)
			return
		}
		if city != nil {
			detail.CityContent = &userCityContentDTO{
				City:        city.City,
				Province:    city.Province,
				Intro:       city.Intro,
				Attractions: city.Attractions,
			}
		}
	}
	c.JSON(http.StatusOK, detail)
}
