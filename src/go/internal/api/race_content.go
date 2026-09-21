package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// RaceContentStore is the persistence the admin race-content surface needs
// (issue #318 赛事信息维护): race-level and item-level content, city content,
// and the publish-version history for both. The concrete *storage.Store
// satisfies it; tests use an in-memory fake.
type RaceContentStore interface {
	GetRaceCalendarEvent(ctx context.Context, id uint64) (*storage.RaceCalendarEvent, error)
	GetRaceContentByEvent(ctx context.Context, eventID uint64) (*storage.RaceContent, []storage.RaceContentItem, error)
	UpsertRaceContent(ctx context.Context, event *storage.RaceCalendarEvent, in *storage.RaceContent, items []storage.RaceContentItem) (*storage.RaceContent, []storage.RaceContentItem, error)
	AttachRaceContent(ctx context.Context, contentID, eventID uint64) (*storage.RaceContent, []storage.RaceContentItem, error)
	ListOrphanRaceContent(ctx context.Context) ([]storage.RaceContent, error)
	PublishRaceContent(ctx context.Context, contentID uint64, publishedBy string) (*storage.RaceContent, []storage.RaceContentItem, int, error)
	ArchiveRaceContent(ctx context.Context, contentID uint64) (*storage.RaceContent, []storage.RaceContentItem, error)
	ListRaceContentVersions(ctx context.Context, contentType string, contentID uint64) ([]storage.RaceContentVersion, error)
	RollbackRaceContent(ctx context.Context, contentID uint64, version int) (*storage.RaceContent, []storage.RaceContentItem, error)
	GetRaceCityContent(ctx context.Context, city string) (*storage.RaceCityContent, error)
	UpsertRaceCityContent(ctx context.Context, in *storage.RaceCityContent) (*storage.RaceCityContent, error)
	PublishRaceCityContent(ctx context.Context, city, publishedBy string) (*storage.RaceCityContent, int, error)
	ArchiveRaceCityContent(ctx context.Context, city string) (*storage.RaceCityContent, error)
	RollbackRaceCityContent(ctx context.Context, city string, version int) (*storage.RaceCityContent, error)
}

// raceContentRoutes serves the administrator race-content surface. Mounted on
// the parent authenticated group so the admin JWT tier can reach it; every
// handler re-checks TierAdmin so user and internal callers are refused.
type raceContentRoutes struct {
	store RaceContentStore
	log   *zap.Logger
}

func newRaceContentRoutes(store RaceContentStore, log *zap.Logger) *raceContentRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &raceContentRoutes{store: store, log: log}
}

// register mounts the admin race-content endpoints. Content lives under the
// race it belongs to (races/:race_id/content), plus a small race-content root
// for orphan re-attachment and a cities root for the shared city content.
func (r *raceContentRoutes) register(rg *gin.RouterGroup) {
	if r.store == nil {
		return
	}
	rg.GET("/api/admin/races/:race_id/content", r.getRaceContent)
	rg.PUT("/api/admin/races/:race_id/content", r.putRaceContent)
	rg.POST("/api/admin/races/:race_id/content/publish", r.publishRaceContent)
	rg.POST("/api/admin/races/:race_id/content/archive", r.archiveRaceContent)
	rg.GET("/api/admin/races/:race_id/content/versions", r.listRaceContentVersions)
	rg.POST("/api/admin/races/:race_id/content/versions/:version/rollback", r.rollbackRaceContent)
	rg.GET("/api/admin/race-content/orphans", r.listOrphanRaceContent)
	rg.POST("/api/admin/race-content/:content_id/attach", r.attachRaceContent)
	rg.GET("/api/admin/cities/:city/content", r.getCityContent)
	rg.PUT("/api/admin/cities/:city/content", r.putCityContent)
	rg.POST("/api/admin/cities/:city/content/publish", r.publishCityContent)
	rg.POST("/api/admin/cities/:city/content/archive", r.archiveCityContent)
	rg.GET("/api/admin/cities/:city/content/versions", r.listCityContentVersions)
	rg.POST("/api/admin/cities/:city/content/versions/:version/rollback", r.rollbackCityContent)
	// AI draft generation (一期: 城市介绍+气候). The contract ships now; the
	// LLM provider wiring is二期 — until then the endpoint answers 501 so the
	// dashboard can render a real disabled state instead of guessing.
	rg.POST("/api/admin/cities/:city/content/ai-draft", r.aiDraftCityContent)
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

// raceContentDTO is the admin projection of one race's content aggregate.
// Nested payload structs are the storage value types (their json tags are the
// API contract); only the model-level fields are re-projected here.
type raceContentDTO struct {
	ID             uint64                      `json:"id"`
	RaceEventID    *uint64                     `json:"race_event_id"`
	Source         string                      `json:"source"`
	RaceName       string                      `json:"race_name"`
	RaceDate       string                      `json:"race_date"`
	Year           int                         `json:"year"`
	Status         string                      `json:"status"`
	PartitionRule  *storage.RacePartitionRule  `json:"partition_rule"`
	SignupTimeline *storage.RaceSignupTimeline `json:"signup_timeline"`
	SignupChannels []storage.RaceSignupChannel `json:"signup_channels"`
	PacketPickup   []storage.RacePacketPickup  `json:"packet_pickup"`
	Items          []raceContentItemDTO        `json:"items"`
	UpdatedAt      time.Time                   `json:"updated_at"`
}

// raceContentItemDTO is the admin projection of one distance's content.
type raceContentItemDTO struct {
	ID              uint64                       `json:"id"`
	ItemName        string                       `json:"item_name"`
	DistanceKm      *float64                     `json:"distance_km"`
	StartPoint      *storage.RacePoint           `json:"start_point"`
	FinishPoint     *storage.RacePoint           `json:"finish_point"`
	TotalAscentM    *int                         `json:"total_ascent_m"`
	ElevationPoints []storage.RaceElevationPoint `json:"elevation_points"`
	Quota           *int                         `json:"quota"`
	AidStations     []storage.RaceAidStation     `json:"aid_stations"`
	Cutoffs         []storage.RaceCutoff         `json:"cutoffs"`
	EntryFee        *int                         `json:"entry_fee"`
	Prizes          []storage.RacePrize          `json:"prizes"`
	Reputation      *storage.RaceReputation      `json:"reputation"`
	Photos          []storage.RacePhoto          `json:"photos"`
}

// raceContentSummaryDTO is the orphan-list projection: enough identity for an
// administrator to recognize the row and re-attach it, nothing else.
type raceContentSummaryDTO struct {
	ID          uint64    `json:"id"`
	RaceEventID *uint64   `json:"race_event_id"`
	Source      string    `json:"source"`
	RaceName    string    `json:"race_name"`
	RaceDate    string    `json:"race_date"`
	Year        int       `json:"year"`
	Status      string    `json:"status"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type raceContentResponse struct {
	Content *raceContentDTO `json:"content"`
}

type raceContentPublishResponse struct {
	Content *raceContentDTO `json:"content"`
	Version int             `json:"version"`
}

type raceContentVersionsResponse struct {
	Versions []raceContentVersionDTO `json:"versions"`
}

type raceContentVersionDTO struct {
	Version     int       `json:"version"`
	PublishedBy string    `json:"published_by"`
	PublishedAt time.Time `json:"published_at"`
}

type raceContentSummariesResponse struct {
	Contents []raceContentSummaryDTO `json:"contents"`
}

// raceCityContentDTO is the admin projection of one city's content.
type raceCityContentDTO struct {
	ID             uint64                      `json:"id"`
	City           string                      `json:"city"`
	Province       *string                     `json:"province"`
	Status         string                      `json:"status"`
	Intro          *storage.CityIntro          `json:"intro"`
	Attractions    []storage.CityAttraction    `json:"attractions"`
	Climate        *storage.CityClimate        `json:"climate"`
	WeatherWindows []storage.CityWeatherWindow `json:"weather_windows"`
	UpdatedAt      time.Time                   `json:"updated_at"`
}

type raceCityContentResponse struct {
	Content *raceCityContentDTO `json:"content"`
}

type raceCityContentPublishResponse struct {
	Content *raceCityContentDTO `json:"content"`
	Version int                 `json:"version"`
}

// ─── Input binding (PUT is a full replace: an absent section clears it) ─────

// raceContentInput is the PUT body for race content. Section pointers are
// nil-when-absent: nil clears the section. Items are fully replaced (matched to
// the calendar's distances by item_name).
type raceContentInput struct {
	PartitionRule  *storage.RacePartitionRule  `json:"partition_rule"`
	SignupTimeline *storage.RaceSignupTimeline `json:"signup_timeline"`
	SignupChannels []storage.RaceSignupChannel `json:"signup_channels"`
	PacketPickup   []storage.RacePacketPickup  `json:"packet_pickup"`
	Items          []raceContentItemInput      `json:"items"`
}

type raceContentItemInput struct {
	ItemName        string                       `json:"item_name"`
	DistanceKm      *float64                     `json:"distance_km"`
	StartPoint      *storage.RacePoint           `json:"start_point"`
	FinishPoint     *storage.RacePoint           `json:"finish_point"`
	TotalAscentM    *int                         `json:"total_ascent_m"`
	ElevationPoints []storage.RaceElevationPoint `json:"elevation_points"`
	Quota           *int                         `json:"quota"`
	AidStations     []storage.RaceAidStation     `json:"aid_stations"`
	Cutoffs         []storage.RaceCutoff         `json:"cutoffs"`
	EntryFee        *int                         `json:"entry_fee"`
	Prizes          []storage.RacePrize          `json:"prizes"`
	Reputation      *storage.RaceReputation      `json:"reputation"`
	Photos          []storage.RacePhoto          `json:"photos"`
}

// raceCityContentInput is the PUT body for city content.
type raceCityContentInput struct {
	Province       *string                     `json:"province"`
	Intro          *storage.CityIntro          `json:"intro"`
	Attractions    []storage.CityAttraction    `json:"attractions"`
	Climate        *storage.CityClimate        `json:"climate"`
	WeatherWindows []storage.CityWeatherWindow `json:"weather_windows"`
}

func newRaceContentDTO(row *storage.RaceContent, items []storage.RaceContentItem) *raceContentDTO {
	dto := &raceContentDTO{
		ID:             row.ID,
		RaceEventID:    row.RaceEventID,
		Source:         row.Source,
		RaceName:       row.RaceName,
		RaceDate:       row.RaceDate,
		Year:           row.Year,
		Status:         row.Status,
		PartitionRule:  row.PartitionRule,
		SignupTimeline: row.SignupTimeline,
		SignupChannels: row.SignupChannels,
		PacketPickup:   row.PacketPickup,
		UpdatedAt:      row.UpdatedAt,
	}
	dto.Items = make([]raceContentItemDTO, 0, len(items))
	for _, item := range items {
		dto.Items = append(dto.Items, newRaceContentItemDTO(item))
	}
	return dto
}

func newRaceContentItemDTO(row storage.RaceContentItem) raceContentItemDTO {
	return raceContentItemDTO{
		ID:              row.ID,
		ItemName:        row.ItemName,
		DistanceKm:      row.DistanceKm,
		StartPoint:      row.StartPoint,
		FinishPoint:     row.FinishPoint,
		TotalAscentM:    row.TotalAscentM,
		ElevationPoints: row.ElevationPoints,
		Quota:           row.Quota,
		AidStations:     row.AidStations,
		Cutoffs:         row.Cutoffs,
		EntryFee:        row.EntryFee,
		Prizes:          row.Prizes,
		Reputation:      row.Reputation,
		Photos:          row.Photos,
	}
}

func newRaceContentSummaryDTO(row storage.RaceContent) raceContentSummaryDTO {
	return raceContentSummaryDTO{
		ID:          row.ID,
		RaceEventID: row.RaceEventID,
		Source:      row.Source,
		RaceName:    row.RaceName,
		RaceDate:    row.RaceDate,
		Year:        row.Year,
		Status:      row.Status,
		UpdatedAt:   row.UpdatedAt,
	}
}

func newRaceCityContentDTO(row *storage.RaceCityContent) *raceCityContentDTO {
	return &raceCityContentDTO{
		ID:             row.ID,
		City:           row.City,
		Province:       row.Province,
		Status:         row.Status,
		Intro:          row.Intro,
		Attractions:    row.Attractions,
		Climate:        row.Climate,
		WeatherWindows: row.WeatherWindows,
		UpdatedAt:      row.UpdatedAt,
	}
}

// ─── Race content handlers ───────────────────────────────────────────────────

// getRaceContent returns a race's content aggregate, or content:null when the
// race has never been maintained.
//
//	@Summary		Get a race's maintained content
//	@Description	Administrator only. Returns the content aggregate (race-level fields + per-distance items) attached to the race, resolving a broken event link by business key.
//	@Tags			admin
//	@Param			race_id	path	int	true	"Race event id"
//	@Success		200	{object}	raceContentResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id}/content [get]
func (r *raceContentRoutes) getRaceContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	eventID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	row, items, err := r.store.GetRaceContentByEvent(c.Request.Context(), eventID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	if row == nil {
		c.JSON(http.StatusOK, raceContentResponse{Content: nil})
		return
	}
	c.JSON(http.StatusOK, raceContentResponse{Content: newRaceContentDTO(row, items)})
}

// putRaceContent creates or replaces a race's working content state (保存即生效:
// published content is edited in place; publish is a separate explicit action).
//
//	@Summary		Create or replace a race's content
//	@Description	Administrator only. Full-replace PUT: absent sections are cleared, items are matched to the calendar's distances by item_name. A new aggregate starts as draft; an existing one keeps its lifecycle status.
//	@Tags			admin
//	@Param			race_id	path	int					true	"Race event id"
//	@Param			body	body	raceContentInput	true	"Content payload"
//	@Success		200	{object}	raceContentResponse
//	@Failure		400	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id}/content [put]
func (r *raceContentRoutes) putRaceContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	eventID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	event, err := r.store.GetRaceCalendarEvent(c.Request.Context(), eventID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	var in raceContentInput
	if !bindRaceCalendarJSON(c, &in, "invalid_request") {
		return
	}
	row, items, err := validateRaceContentInput(&in)
	if err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_request"})
		return
	}
	saved, savedItems, err := r.store.UpsertRaceContent(c.Request.Context(), event, row, items)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceContentResponse{Content: newRaceContentDTO(saved, savedItems)})
}

// publishRaceContent snapshots the current state as the next immutable version.
//
//	@Summary		Publish a race's content
//	@Description	Administrator only. Snapshots the current content (including items) as the next version and flips the aggregate to published.
//	@Tags			admin
//	@Param			race_id	path	int	true	"Race event id"
//	@Success		200	{object}	raceContentPublishResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id}/content/publish [post]
func (r *raceContentRoutes) publishRaceContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	eventID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	row, _, err := r.store.GetRaceContentByEvent(c.Request.Context(), eventID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "content_not_found"})
		return
	}
	saved, savedItems, version, err := r.store.PublishRaceContent(c.Request.Context(), row.ID, callerFrom(c).UserID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceContentPublishResponse{Content: newRaceContentDTO(saved, savedItems), Version: version})
}

// archiveRaceContent takes a race's content offline without deleting it.
//
//	@Summary		Archive a race's content
//	@Description	Administrator only. Marks the aggregate archived; nothing is deleted.
//	@Tags			admin
//	@Param			race_id	path	int	true	"Race event id"
//	@Success		200	{object}	raceContentResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id}/content/archive [post]
func (r *raceContentRoutes) archiveRaceContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	eventID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	row, _, err := r.store.GetRaceContentByEvent(c.Request.Context(), eventID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "content_not_found"})
		return
	}
	saved, savedItems, err := r.store.ArchiveRaceContent(c.Request.Context(), row.ID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceContentResponse{Content: newRaceContentDTO(saved, savedItems)})
}

// listRaceContentVersions returns the publish history, newest first.
//
//	@Summary		List a race's content versions
//	@Description	Administrator only. Returns the publish history of the race's content, newest first, without snapshot bodies.
//	@Tags			admin
//	@Param			race_id	path	int	true	"Race event id"
//	@Success		200	{object}	raceContentVersionsResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id}/content/versions [get]
func (r *raceContentRoutes) listRaceContentVersions(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	eventID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	row, _, err := r.store.GetRaceContentByEvent(c.Request.Context(), eventID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	if row == nil {
		c.JSON(http.StatusOK, raceContentVersionsResponse{Versions: []raceContentVersionDTO{}})
		return
	}
	versions, err := r.store.ListRaceContentVersions(c.Request.Context(), storage.RaceContentVersionTypeRace, row.ID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceContentVersionsResponse{Versions: newRaceContentVersionDTOs(versions)})
}

// rollbackRaceContent copies a historical version back into the working state.
//
//	@Summary		Roll back a race's content to a version
//	@Description	Administrator only. Restores the version's snapshot as the new working state (content and items). The lifecycle status is untouched; history is never rewritten.
//	@Tags			admin
//	@Param			race_id	path	int	true	"Race event id"
//	@Param			version	path	int	true	"Version number"
//	@Success		200	{object}	raceContentResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id}/content/versions/{version}/rollback [post]
func (r *raceContentRoutes) rollbackRaceContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	eventID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	version, ok := parseUintParam(c, "version")
	if !ok {
		return
	}
	row, _, err := r.store.GetRaceContentByEvent(c.Request.Context(), eventID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "content_not_found"})
		return
	}
	saved, savedItems, err := r.store.RollbackRaceContent(c.Request.Context(), row.ID, int(version))
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceContentResponse{Content: newRaceContentDTO(saved, savedItems)})
}

// listOrphanRaceContent returns content whose race link broke upstream.
//
//	@Summary		List orphaned race content
//	@Description	Administrator only. Returns content rows whose live race link is broken (upstream renamed/rescheduled the race) so they can be re-attached.
//	@Tags			admin
//	@Success		200	{object}	raceContentSummariesResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/race-content/orphans [get]
func (r *raceContentRoutes) listOrphanRaceContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	rows, err := r.store.ListOrphanRaceContent(c.Request.Context())
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	dtos := make([]raceContentSummaryDTO, 0, len(rows))
	for _, row := range rows {
		dtos = append(dtos, newRaceContentSummaryDTO(row))
	}
	c.JSON(http.StatusOK, raceContentSummariesResponse{Contents: dtos})
}

// attachRaceContent re-links orphaned content to a race event.
//
//	@Summary		Attach race content to a race event
//	@Description	Administrator only. Re-links a (possibly orphaned) content row to a race event and refreshes its business-key snapshot from that event. 409 when the race already has content.
//	@Tags			admin
//	@Param			content_id	path	int					true	"Content id"
//	@Param			body		body	raceContentAttachInput	true	"Attach payload"
//	@Success		200	{object}	raceContentResponse
//	@Failure		400	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		409	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/race-content/{content_id}/attach [post]
func (r *raceContentRoutes) attachRaceContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	contentID, ok := parseUintParam(c, "content_id")
	if !ok {
		return
	}
	var in raceContentAttachInput
	if !bindRaceCalendarJSON(c, &in, "invalid_request") {
		return
	}
	if in.RaceEventID == 0 {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_request"})
		return
	}
	saved, savedItems, err := r.store.AttachRaceContent(c.Request.Context(), contentID, in.RaceEventID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceContentResponse{Content: newRaceContentDTO(saved, savedItems)})
}

type raceContentAttachInput struct {
	RaceEventID uint64 `json:"race_event_id"`
}

// ─── City content handlers ───────────────────────────────────────────────────

// getCityContent returns a city's content, or content:null when unmaintained.
//
//	@Summary		Get a city's maintained content
//	@Description	Administrator only. Returns the shared city content (introduction, attractions, climate, historical weather windows), or content:null when the city has none.
//	@Tags			admin
//	@Param			city	path	string	true	"City name (race_calendar.city spelling, e.g. 厦门市)"
//	@Success		200	{object}	raceCityContentResponse
//	@Failure		400	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/cities/{city}/content [get]
func (r *raceContentRoutes) getCityContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	city := c.Param("city")
	row, err := r.store.GetRaceCityContent(c.Request.Context(), city)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	if row == nil {
		c.JSON(http.StatusOK, raceCityContentResponse{Content: nil})
		return
	}
	c.JSON(http.StatusOK, raceCityContentResponse{Content: newRaceCityContentDTO(row)})
}

// putCityContent creates or replaces a city's working content state.
//
//	@Summary		Create or replace a city's content
//	@Description	Administrator only. Full-replace PUT: absent sections are cleared. A new row starts as draft; an existing one keeps its lifecycle status.
//	@Tags			admin
//	@Param			city	path	string					true	"City name"
//	@Param			body	body	raceCityContentInput	true	"Content payload"
//	@Success		200	{object}	raceCityContentResponse
//	@Failure		400	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/cities/{city}/content [put]
func (r *raceContentRoutes) putCityContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	city := c.Param("city")
	var in raceCityContentInput
	if !bindRaceCalendarJSON(c, &in, "invalid_request") {
		return
	}
	if err := validateCityContentInput(&in); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_request"})
		return
	}
	saved, err := r.store.UpsertRaceCityContent(c.Request.Context(), &storage.RaceCityContent{
		City:           city,
		Province:       in.Province,
		Intro:          in.Intro,
		Attractions:    in.Attractions,
		Climate:        in.Climate,
		WeatherWindows: in.WeatherWindows,
	})
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceCityContentResponse{Content: newRaceCityContentDTO(saved)})
}

// publishCityContent snapshots the city's content as the next version.
//
//	@Summary		Publish a city's content
//	@Description	Administrator only. Snapshots the current content as the next version and flips the row to published.
//	@Tags			admin
//	@Param			city	path	string	true	"City name"
//	@Success		200	{object}	raceCityContentPublishResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/cities/{city}/content/publish [post]
func (r *raceContentRoutes) publishCityContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	city := c.Param("city")
	saved, version, err := r.store.PublishRaceCityContent(c.Request.Context(), city, callerFrom(c).UserID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceCityContentPublishResponse{Content: newRaceCityContentDTO(saved), Version: version})
}

// archiveCityContent takes a city's content offline without deleting it.
//
//	@Summary		Archive a city's content
//	@Description	Administrator only. Marks the city content archived; nothing is deleted.
//	@Tags			admin
//	@Param			city	path	string	true	"City name"
//	@Success		200	{object}	raceCityContentResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/cities/{city}/content/archive [post]
func (r *raceContentRoutes) archiveCityContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	city := c.Param("city")
	saved, err := r.store.ArchiveRaceCityContent(c.Request.Context(), city)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceCityContentResponse{Content: newRaceCityContentDTO(saved)})
}

// listCityContentVersions returns the city's publish history, newest first.
//
//	@Summary		List a city's content versions
//	@Description	Administrator only. Returns the publish history of the city's content, newest first, without snapshot bodies.
//	@Tags			admin
//	@Param			city	path	string	true	"City name"
//	@Success		200	{object}	raceContentVersionsResponse
//	@Failure		400	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/cities/{city}/content/versions [get]
func (r *raceContentRoutes) listCityContentVersions(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	city := c.Param("city")
	row, err := r.store.GetRaceCityContent(c.Request.Context(), city)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	if row == nil {
		c.JSON(http.StatusOK, raceContentVersionsResponse{Versions: []raceContentVersionDTO{}})
		return
	}
	versions, err := r.store.ListRaceContentVersions(c.Request.Context(), storage.RaceContentVersionTypeCity, row.ID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceContentVersionsResponse{Versions: newRaceContentVersionDTOs(versions)})
}

// rollbackCityContent copies a historical version back into the working state.
//
//	@Summary		Roll back a city's content to a version
//	@Description	Administrator only. Restores the version's snapshot as the new working state. The lifecycle status is untouched; history is never rewritten.
//	@Tags			admin
//	@Param			city	path	string	true	"City name"
//	@Param			version	path	int		true	"Version number"
//	@Success		200	{object}	raceCityContentResponse
//	@Failure		400	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/cities/{city}/content/versions/{version}/rollback [post]
func (r *raceContentRoutes) rollbackCityContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	city := c.Param("city")
	version, ok := parseUintParam(c, "version")
	if !ok {
		return
	}
	saved, err := r.store.RollbackRaceCityContent(c.Request.Context(), city, int(version))
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceCityContentResponse{Content: newRaceCityContentDTO(saved)})
}

// aiDraftCityContent is the一期 AI-draft stub (city introduction + climate).
//
//	@Summary		Generate an AI city-content draft
//	@Description	Administrator only. One-期 contract endpoint for AI-generated city introduction + climate drafts. The LLM provider is二期; the endpoint currently answers 501 ai_draft_not_configured.
//	@Tags			admin
//	@Param			city	path	string	true	"City name"
//	@Failure		501	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/cities/{city}/content/ai-draft [post]
func (r *raceContentRoutes) aiDraftCityContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	c.JSON(http.StatusNotImplemented, errorResponse{Error: "ai_draft_not_configured"})
}

// ─── Binding + validation + errors ───────────────────────────────────────────

// validateRaceContentInput applies the cross-field rules the storage layer
// deliberately does not know about and projects the input onto the storage
// model. The rules are the minimum that keeps the dataset honest: a distance
// without a name cannot be matched to a calendar item, duplicate names would
// make the full-replace ambiguous, a photo without a URL carries nothing, and
// the enum fields have a closed value space.
func validateRaceContentInput(in *raceContentInput) (*storage.RaceContent, []storage.RaceContentItem, error) {
	row := &storage.RaceContent{
		PartitionRule:  in.PartitionRule,
		SignupTimeline: in.SignupTimeline,
		SignupChannels: in.SignupChannels,
		PacketPickup:   in.PacketPickup,
	}
	if in.PartitionRule != nil {
		if in.PartitionRule.Mode != "mixed" && in.PartitionRule.Mode != "by_item" {
			return nil, nil, errInvalidRaceContentInput
		}
	}
	if in.SignupTimeline != nil && !isCalendarDate(in.SignupTimeline.StartAt) {
		return nil, nil, errInvalidRaceContentInput
	}
	if in.SignupTimeline != nil && !isCalendarDate(in.SignupTimeline.Deadline) {
		return nil, nil, errInvalidRaceContentInput
	}
	if in.SignupTimeline != nil && in.SignupTimeline.LotteryResultAt != nil &&
		!isCalendarDate(*in.SignupTimeline.LotteryResultAt) {
		return nil, nil, errInvalidRaceContentInput
	}
	for _, ch := range in.SignupChannels {
		if strings.TrimSpace(ch.Name) == "" || strings.TrimSpace(ch.URL) == "" {
			return nil, nil, errInvalidRaceContentInput
		}
	}

	seen := make(map[string]bool, len(in.Items))
	items := make([]storage.RaceContentItem, 0, len(in.Items))
	for _, inItem := range in.Items {
		name := strings.TrimSpace(inItem.ItemName)
		if name == "" || seen[name] {
			return nil, nil, errInvalidRaceContentInput
		}
		seen[name] = true
		for _, cutoff := range inItem.Cutoffs {
			if !isRaceClock(cutoff.CutoffAt) {
				return nil, nil, errInvalidRaceContentInput
			}
		}
		for _, photo := range inItem.Photos {
			if strings.TrimSpace(photo.URL) == "" {
				return nil, nil, errInvalidRaceContentInput
			}
		}
		items = append(items, storage.RaceContentItem{
			ItemName:        name,
			DistanceKm:      inItem.DistanceKm,
			StartPoint:      inItem.StartPoint,
			FinishPoint:     inItem.FinishPoint,
			TotalAscentM:    inItem.TotalAscentM,
			ElevationPoints: inItem.ElevationPoints,
			Quota:           inItem.Quota,
			AidStations:     inItem.AidStations,
			Cutoffs:         inItem.Cutoffs,
			EntryFee:        inItem.EntryFee,
			Prizes:          inItem.Prizes,
			Reputation:      inItem.Reputation,
			Photos:          inItem.Photos,
		})
	}
	return row, items, nil
}

// validateCityContentInput applies the city-side rules: weather windows need
// MM-DD bounds and percent fields in range.
func validateCityContentInput(in *raceCityContentInput) error {
	for _, w := range in.WeatherWindows {
		if !isMonthDay(w.WindowStart) || !isMonthDay(w.WindowEnd) {
			return errInvalidRaceContentInput
		}
		for _, pct := range []*int{w.RainProbabilityPct, w.HumidityPct} {
			if pct != nil && (*pct < 0 || *pct > 100) {
				return errInvalidRaceContentInput
			}
		}
	}
	return nil
}

func newRaceContentVersionDTOs(rows []storage.RaceContentVersion) []raceContentVersionDTO {
	out := make([]raceContentVersionDTO, 0, len(rows))
	for _, row := range rows {
		out = append(out, raceContentVersionDTO{
			Version:     row.Version,
			PublishedBy: row.PublishedBy,
			PublishedAt: row.PublishedAt,
		})
	}
	return out
}

// errInvalidRaceContentInput marks a rejected request body (400 invalid_request).
var errInvalidRaceContentInput = errors.New("api: invalid race content input")

// writeRaceContentError maps storage sentinels onto the admin error envelope.
func writeRaceContentError(c *gin.Context, log *zap.Logger, err error) {
	switch {
	case errors.Is(err, storage.ErrRaceCalendarNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "race_not_found"})
	case errors.Is(err, storage.ErrRaceContentNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "content_not_found"})
	case errors.Is(err, storage.ErrRaceContentConflict):
		c.JSON(http.StatusConflict, errorResponse{Error: "content_conflict"})
	case errors.Is(err, storage.ErrInvalidRaceContent):
		c.JSON(http.StatusNotFound, errorResponse{Error: "content_not_found"})
	default:
		log.Error("race content write failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal_error"})
	}
}

// isRaceClock validates a cutoff instant: a race-day wall clock "HH:MM" or a
// dated datetime "2006-01-02 15:04" (both are wall-clock values, never
// timezone-converted).
func isRaceClock(v string) bool {
	switch len(v) {
	case 5: // "HH:MM"
		h, errH := strconv.Atoi(v[:2])
		m, errM := strconv.Atoi(v[3:])
		return v[2] == ':' && errH == nil && errM == nil && h >= 0 && h < 24 && m >= 0 && m < 60
	case 16: // "2006-01-02 15:04"
		return v[10] == ' ' && v[13] == ':' && isCalendarDate(v[:10]) && isDayClock(v[11:])
	default:
		return false
	}
}

// isDayClock validates the "HH:MM" tail of a datetime.
func isDayClock(v string) bool {
	h, errH := strconv.Atoi(v[:2])
	m, errM := strconv.Atoi(v[3:])
	return errH == nil && errM == nil && h >= 0 && h < 24 && m >= 0 && m < 60
}

// isMonthDay validates an "MM-DD" season slice.
func isMonthDay(v string) bool {
	if len(v) != 5 || v[2] != '-' {
		return false
	}
	m, errM := strconv.Atoi(v[:2])
	d, errD := strconv.Atoi(v[3:])
	return errM == nil && errD == nil && m >= 1 && m <= 12 && d >= 1 && d <= 31
}
