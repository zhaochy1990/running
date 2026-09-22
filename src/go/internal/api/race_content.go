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

	"github.com/zhaochy1990/stride/internal/llm"
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
	UpsertRaceContentAIDraft(ctx context.Context, event *storage.RaceCalendarEvent, in *storage.RaceContent) (*storage.RaceContent, []storage.RaceContentItem, error)
	AttachRaceContent(ctx context.Context, contentID, eventID uint64) (*storage.RaceContent, []storage.RaceContentItem, error)
	ListOrphanRaceContent(ctx context.Context) ([]storage.RaceContent, error)
	PublishRaceContent(ctx context.Context, contentID uint64, publishedBy string) (*storage.RaceContent, []storage.RaceContentItem, int, error)
	ArchiveRaceContent(ctx context.Context, contentID uint64) (*storage.RaceContent, []storage.RaceContentItem, error)
	ListRaceContentVersions(ctx context.Context, contentType string, contentID uint64) ([]storage.RaceContentVersion, error)
	RollbackRaceContent(ctx context.Context, contentID uint64, version int) (*storage.RaceContent, []storage.RaceContentItem, error)
	GetRaceCityContent(ctx context.Context, city string) (*storage.RaceCityContent, error)
	UpsertRaceCityContent(ctx context.Context, in *storage.RaceCityContent) (*storage.RaceCityContent, error)
	UpsertRaceCityContentAIDraft(ctx context.Context, in *storage.RaceCityContent) (*storage.RaceCityContent, error)
	PublishRaceCityContent(ctx context.Context, city, publishedBy string) (*storage.RaceCityContent, int, error)
	ArchiveRaceCityContent(ctx context.Context, city string) (*storage.RaceCityContent, error)
	RollbackRaceCityContent(ctx context.Context, city string, version int) (*storage.RaceCityContent, error)
}

// CityAIDraftConfig configures the AI city-content draft generator. An empty
// APIKey keeps the ai-draft endpoint answering 501 ai_draft_not_configured
// (graceful degradation before rollout). Mirrors config.CityAIDraft.
type CityAIDraftConfig struct {
	Endpoint string
	APIKey   string
	Model    string
	Timeout  time.Duration
}

// raceContentRoutes serves the administrator race-content surface. Mounted on
// the parent authenticated group so the admin JWT tier can reach it; every
// handler re-checks TierAdmin so user and internal callers are refused.
type raceContentRoutes struct {
	store   RaceContentStore
	aiDraft CityAIDraftConfig
	log     *zap.Logger
}

func newRaceContentRoutes(store RaceContentStore, aiDraft CityAIDraftConfig, log *zap.Logger) *raceContentRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &raceContentRoutes{store: store, aiDraft: aiDraft, log: log}
}

// aiDraftMaxAttempts bounds the LLM retries per draft request. The provider is
// not deterministic even at temperature 0 — json_object mode occasionally
// emits structurally broken JSON — so a fresh roll is the practical recovery.
const aiDraftMaxAttempts = 3

// completeJSONWithRetry calls CompleteJSON up to aiDraftMaxAttempts times. A
// failed attempt (provider error, malformed payload) is logged and retried;
// the last error is returned. valid reports whether the decoded payload is
// usable — an unusable payload counts as a failed attempt, because a partial
// draft would silently clear sections the admin already wrote.
func (r *raceContentRoutes) completeJSONWithRetry(ctx context.Context, client *llm.ChatCompletions, system, user string, out any, valid func() bool) error {
	var err error
	for attempt := 1; attempt <= aiDraftMaxAttempts; attempt++ {
		if err = client.CompleteJSON(ctx, system, user, out); err == nil && valid() {
			return nil
		}
		r.log.Warn("ai-draft generation attempt failed",
			zap.Int("attempt", attempt), zap.Int("max_attempts", aiDraftMaxAttempts), zap.Error(err))
	}
	if err == nil {
		err = errors.New("llm: payload failed validation after retries")
	}
	return err
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
	// AI draft generation (一期: 城市介绍 + 比赛期气候). The contract ships
	// now; the LLM provider wiring is二期 — until then the endpoints answer
	// 501 so the dashboard can render a real disabled state instead of
	// guessing.
	rg.POST("/api/admin/cities/:city/content/ai-draft", r.aiDraftCityContent)
	rg.POST("/api/admin/races/:race_id/content/ai-draft", r.aiDraftRaceContent)
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
	Climate        *storage.RaceClimate        `json:"climate"`
	WeatherWindows []storage.RaceWeatherWindow `json:"weather_windows"`
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
	ID          uint64                   `json:"id"`
	City        string                   `json:"city"`
	Province    *string                  `json:"province"`
	Status      string                   `json:"status"`
	Intro       *storage.CityIntro       `json:"intro"`
	Attractions []storage.CityAttraction `json:"attractions"`
	UpdatedAt   time.Time                `json:"updated_at"`
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
	Climate        *storage.RaceClimate        `json:"climate"`
	WeatherWindows []storage.RaceWeatherWindow `json:"weather_windows"`
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

// raceCityContentInput is the PUT body for city content. Climate and weather
// windows moved to race level (race-period climatology, not city seasons).
type raceCityContentInput struct {
	Province    *string                  `json:"province"`
	Intro       *storage.CityIntro       `json:"intro"`
	Attractions []storage.CityAttraction `json:"attractions"`
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
		Climate:        row.Climate,
		WeatherWindows: row.WeatherWindows,
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
		ID:          row.ID,
		City:        row.City,
		Province:    row.Province,
		Status:      row.Status,
		Intro:       row.Intro,
		Attractions: row.Attractions,
		UpdatedAt:   row.UpdatedAt,
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
	saved, err := r.store.UpsertRaceCityContent(c.Request.Context(), &storage.RaceCityContent{
		City:        city,
		Province:    in.Province,
		Intro:       in.Intro,
		Attractions: in.Attractions,
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

// cityAIDraftPayload is the strict JSON shape the AI draft generator must
// return. Field names match storage.CityIntro exactly so the provider contract
// and the storage contract stay one-to-one. (Climate moved to race level — the
// race-content AI draft covers it.)
type cityAIDraftPayload struct {
	Intro *storage.CityIntro `json:"intro"`
}

// valid reports whether every intro section is present and non-empty. A
// partial draft would silently clear a section the admin already wrote, so
// incomplete payloads are treated as a generation failure (502), not saved.
func (p cityAIDraftPayload) valid() bool {
	if p.Intro == nil {
		return false
	}
	for _, s := range []string{
		p.Intro.Overview, p.Intro.Culture, p.Intro.Food, p.Intro.History,
	} {
		if strings.TrimSpace(s) == "" {
			return false
		}
	}
	return true
}

const cityAIDraftSystemPrompt = `你是马拉松赛事内容编辑助手，负责为中国城市撰写面向跑者的城市介绍草稿。你只能输出严格匹配以下结构的 JSON，不得输出其它字段、文字、代码块或注释，所有内容必须使用中文：

{"intro":{"overview":"城市总体介绍","culture":"城市文化","food":"城市美食","history":"城市历史"}}

要求：
1. intro.overview / intro.culture / intro.food / intro.history 各一段中文，面向参赛跑者。
2. 只写文字，禁止输出任何数值型天气数据（如具体气温、湿度、降雨概率），禁止输出图片 URL。
3. 每段内容 2-4 句话，客观、准确、有吸引力。`

func cityAIDraftUserPrompt(city string) string {
	return "请为城市「" + city + "」生成上述结构的城市介绍草稿。"
}

// aiDraftCityContent generates an AI draft for a city's intro.
//
//	@Summary		Generate an AI city-content draft
//	@Description	Administrator only. Synchronously calls the configured OpenAI-compatible LLM and upserts a draft city-content row with only the intro filled; published/archived content is refused (409). Unconfigured deployments answer 501 ai_draft_not_configured.
//	@Tags			admin
//	@Param			city	path	string	true	"City name"
//	@Success		200		{object}	raceCityContentResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		501		{object}	errorResponse
//	@Failure		502		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/cities/{city}/content/ai-draft [post]
func (r *raceContentRoutes) aiDraftCityContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	city := c.Param("city")

	if strings.TrimSpace(r.aiDraft.APIKey) == "" {
		c.JSON(http.StatusNotImplemented, errorResponse{Error: "ai_draft_not_configured"})
		return
	}

	// Cheap pre-check so a published/archived city refuses before we pay for a
	// (slow) LLM call. The storage upsert re-checks atomically so a concurrent
	// publish during generation still cannot be overwritten.
	existing, err := r.store.GetRaceCityContent(c.Request.Context(), city)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	if existing != nil && existing.Status != storage.RaceContentStatusDraft {
		c.JSON(http.StatusConflict, errorResponse{Error: "ai_draft_conflict"})
		return
	}

	client, err := llm.NewChatCompletions(llm.Config{
		Endpoint: r.aiDraft.Endpoint,
		APIKey:   r.aiDraft.APIKey,
		Model:    r.aiDraft.Model,
		Timeout:  r.aiDraft.Timeout,
	})
	if err != nil {
		r.log.Error("city ai-draft client misconfigured", zap.Error(err))
		c.JSON(http.StatusBadGateway, errorResponse{Error: "ai_draft_failed"})
		return
	}

	var out cityAIDraftPayload
	if err := r.completeJSONWithRetry(c.Request.Context(), client, cityAIDraftSystemPrompt, cityAIDraftUserPrompt(city), &out, func() bool { return out.valid() }); err != nil {
		r.log.Error("city ai-draft generation failed", zap.String("city", city), zap.Error(err))
		c.JSON(http.StatusBadGateway, errorResponse{Error: "ai_draft_failed"})
		return
	}
	if !out.valid() {
		r.log.Error("city ai-draft returned an incomplete payload", zap.String("city", city))
		c.JSON(http.StatusBadGateway, errorResponse{Error: "ai_draft_failed"})
		return
	}

	saved, err := r.store.UpsertRaceCityContentAIDraft(c.Request.Context(), &storage.RaceCityContent{
		City:  city,
		Intro: out.Intro,
	})
	if err != nil {
		if errors.Is(err, storage.ErrRaceContentConflict) {
			c.JSON(http.StatusConflict, errorResponse{Error: "ai_draft_conflict"})
			return
		}
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceCityContentResponse{Content: newRaceCityContentDTO(saved)})
}

// raceAIDraftPayload is the strict JSON shape the race AI draft generator must
// return. Field names match storage.RaceClimate / storage.RaceWeatherWindow so
// the provider contract and the storage contract stay one-to-one. Unlike the
// city draft, the race draft carries numeric climatology: the race's month is
// what makes a weather window meaningful.
type raceAIDraftPayload struct {
	Climate        *storage.RaceClimate        `json:"climate"`
	WeatherWindows []storage.RaceWeatherWindow `json:"weather_windows"`
}

// valid reports whether the climate summary is present and every window is
// complete. A partial draft would silently clear sections the admin already
// wrote, so incomplete payloads are treated as a generation failure (502), not
// saved. Bounds are 2-4 windows: enough to bracket the race date, few enough
// to stay a summary.
func (p raceAIDraftPayload) valid() bool {
	if p.Climate == nil || strings.TrimSpace(p.Climate.Summary) == "" {
		return false
	}
	if len(p.WeatherWindows) < 2 || len(p.WeatherWindows) > 4 {
		return false
	}
	for _, w := range p.WeatherWindows {
		if !isMonthDay(w.WindowStart) || !isMonthDay(w.WindowEnd) {
			return false
		}
	}
	return true
}

const raceAIDraftSystemPrompt = `你是马拉松赛事内容编辑助手，负责为具体一场赛事撰写面向跑者的比赛期气候草稿。你只能输出严格匹配以下结构的 JSON，不得输出其它字段、文字、代码块或注释，文字内容必须使用中文：

{"climate":{"summary":"比赛期气候综述"},"weather_windows":[{"window_start":"MM-DD","window_end":"MM-DD","avg_temp_c":13.5,"temp_high_c":18,"temp_low_c":9,"rain_probability_pct":30,"humidity_pct":65,"wind":"东北风3级"}]}

要求：
1. climate.summary 一段中文（2-4 句）：结合赛事所在城市与比赛时间，描述参赛跑者应预期的气候（气温体感、降水、湿度、风、穿衣建议）。
2. weather_windows 输出 2-4 个以比赛日期所在月份为中心的历史同期天气窗口；数值取该城市历史气候平均值（摄氏度/百分比），不确定的数值用 null。
3. window_start / window_end 必须为 MM-DD 格式且 start 不晚于 end；wind 为简短中文自由文本。
4. 禁止输出图片 URL。`

func raceAIDraftUserPrompt(name, raceDate, city string) string {
	return "请为赛事「" + name + "」（比赛日期 " + raceDate + "，城市：" + city + "）生成上述结构的比赛期气候草稿。"
}

// aiDraftRaceContent generates an AI draft for a race's race-period climate
// (summary + historical weather windows), keyed to the race's city and date.
//
//	@Summary		Generate an AI race-content climate draft
//	@Description	Administrator only. Synchronously calls the configured OpenAI-compatible LLM with the race's name/date/city and upserts a draft content row with only climate + weather_windows filled; published/archived content is refused (409). Unconfigured deployments answer 501 ai_draft_not_configured.
//	@Tags			admin
//	@Param			race_id	path	int	true	"Race event id"
//	@Success		200		{object}	raceContentResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		501		{object}	errorResponse
//	@Failure		502		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id}/content/ai-draft [post]
func (r *raceContentRoutes) aiDraftRaceContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	eventID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}

	if strings.TrimSpace(r.aiDraft.APIKey) == "" {
		c.JSON(http.StatusNotImplemented, errorResponse{Error: "ai_draft_not_configured"})
		return
	}

	event, err := r.store.GetRaceCalendarEvent(c.Request.Context(), eventID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	// The draft is keyed to the race's city and date; a race without a city
	// has no climatology to describe.
	var city string
	if event.City != nil {
		city = strings.TrimSpace(*event.City)
	}
	if city == "" {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "race_city_missing"})
		return
	}
	name := event.Name
	if event.NameCN != nil && strings.TrimSpace(*event.NameCN) != "" {
		name = strings.TrimSpace(*event.NameCN)
	}

	// Cheap pre-check so a published/archived race refuses before we pay for a
	// (slow) LLM call. The storage upsert re-checks atomically so a concurrent
	// publish during generation still cannot be overwritten.
	existing, _, err := r.store.GetRaceContentByEvent(c.Request.Context(), eventID)
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	if existing != nil && existing.Status != storage.RaceContentStatusDraft {
		c.JSON(http.StatusConflict, errorResponse{Error: "ai_draft_conflict"})
		return
	}

	client, err := llm.NewChatCompletions(llm.Config{
		Endpoint: r.aiDraft.Endpoint,
		APIKey:   r.aiDraft.APIKey,
		Model:    r.aiDraft.Model,
		Timeout:  r.aiDraft.Timeout,
	})
	if err != nil {
		r.log.Error("race ai-draft client misconfigured", zap.Error(err))
		c.JSON(http.StatusBadGateway, errorResponse{Error: "ai_draft_failed"})
		return
	}

	var out raceAIDraftPayload
	if err := r.completeJSONWithRetry(c.Request.Context(), client, raceAIDraftSystemPrompt, raceAIDraftUserPrompt(name, event.RaceDate, city), &out, func() bool { return out.valid() }); err != nil {
		r.log.Error("race ai-draft generation failed", zap.Uint64("race_id", eventID), zap.Error(err))
		c.JSON(http.StatusBadGateway, errorResponse{Error: "ai_draft_failed"})
		return
	}
	if !out.valid() {
		r.log.Error("race ai-draft returned an incomplete payload", zap.Uint64("race_id", eventID))
		c.JSON(http.StatusBadGateway, errorResponse{Error: "ai_draft_failed"})
		return
	}

	saved, savedItems, err := r.store.UpsertRaceContentAIDraft(c.Request.Context(), event, &storage.RaceContent{
		Climate:        out.Climate,
		WeatherWindows: out.WeatherWindows,
	})
	if err != nil {
		if errors.Is(err, storage.ErrRaceContentConflict) {
			c.JSON(http.StatusConflict, errorResponse{Error: "ai_draft_conflict"})
			return
		}
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceContentResponse{Content: newRaceContentDTO(saved, savedItems)})
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
		Climate:        in.Climate,
		WeatherWindows: in.WeatherWindows,
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
	if in.Climate != nil && strings.TrimSpace(in.Climate.Summary) == "" {
		// An empty-summary climate object carries nothing; treat it as absent
		// rather than storing a stub.
		row.Climate = nil
	}
	for _, w := range in.WeatherWindows {
		if !isMonthDay(w.WindowStart) || !isMonthDay(w.WindowEnd) {
			return nil, nil, errInvalidRaceContentInput
		}
		for _, pct := range []*int{w.RainProbabilityPct, w.HumidityPct} {
			if pct != nil && (*pct < 0 || *pct > 100) {
				return nil, nil, errInvalidRaceContentInput
			}
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
