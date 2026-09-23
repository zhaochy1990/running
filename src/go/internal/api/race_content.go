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

// Race content lives ON the race_calendar row (the six event-level sections)
// and in race_item_content (one row per distance); the race-calendar routes in
// race_calendar.go serve it. This file keeps what is genuinely separate: the
// city content surface, the AI draft generators, and the content input
// validation shared by the calendar handlers.

// RaceContentStore is the persistence the city-content and AI-draft surface
// needs. There is no lifecycle — an upsert is the live content. The concrete
// *storage.Store satisfies it; tests use an in-memory fake.
type RaceContentStore interface {
	GetRaceCalendarEvent(ctx context.Context, id uint64) (*storage.RaceCalendarEvent, error)
	UpdateRaceCalendarEvent(ctx context.Context, row *storage.RaceCalendarEvent) error
	GetRaceCityContent(ctx context.Context, city string) (*storage.RaceCityContent, error)
	UpsertRaceCityContent(ctx context.Context, in *storage.RaceCityContent) (*storage.RaceCityContent, error)
	UpsertRaceCityContentAIDraft(ctx context.Context, in *storage.RaceCityContent) (*storage.RaceCityContent, error)
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

// raceContentRoutes serves the administrator city-content surface plus the AI
// draft generators. Mounted on the parent authenticated group so the admin JWT
// tier can reach it; every handler re-checks TierAdmin so user and internal
// callers are refused.
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

// register mounts the city content endpoints and the race AI draft. Race
// content itself is served by the race-calendar routes; only the AI draft
// keeps a race-scoped path here.
func (r *raceContentRoutes) register(rg *gin.RouterGroup) {
	if r.store == nil {
		return
	}
	rg.GET("/api/admin/cities/:city/content", r.getCityContent)
	rg.PUT("/api/admin/cities/:city/content", r.putCityContent)
	// AI draft generation (一期: 城市介绍 + 比赛期气候). The contract ships
	// now; the LLM provider wiring is二期 — until then the endpoints answer
	// 501 so the dashboard can render a real disabled state instead of
	// guessing.
	rg.POST("/api/admin/cities/:city/content/ai-draft", r.aiDraftCityContent)
	rg.POST("/api/admin/races/:race_id/content/ai-draft", r.aiDraftRaceContent)
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

// raceCityContentDTO is the admin projection of one city's content.
type raceCityContentDTO struct {
	ID          uint64                   `json:"id"`
	City        string                   `json:"city"`
	Province    *string                  `json:"province"`
	Intro       *storage.CityIntro       `json:"intro"`
	Attractions []storage.CityAttraction `json:"attractions"`
	UpdatedAt   time.Time                `json:"updated_at"`
}

type raceCityContentResponse struct {
	Content *raceCityContentDTO `json:"content"`
}

func newRaceCityContentDTO(row *storage.RaceCityContent) *raceCityContentDTO {
	return &raceCityContentDTO{
		ID:          row.ID,
		City:        row.City,
		Province:    row.Province,
		Intro:       row.Intro,
		Attractions: row.Attractions,
		UpdatedAt:   row.UpdatedAt,
	}
}

// raceCityContentInput is the PUT body for city content. Climate and weather
// windows moved to race level (race-period climatology, not city seasons).
type raceCityContentInput struct {
	Province    *string                  `json:"province"`
	Intro       *storage.CityIntro       `json:"intro"`
	Attractions []storage.CityAttraction `json:"attractions"`
}

// ─── City content handlers ───────────────────────────────────────────────────

// getCityContent returns a city's content, or content:null when unmaintained.
//
//	@Summary		Get a city's maintained content
//	@Description	Administrator only. Returns the shared city content (introduction, attractions), or content:null when the city has none. Race-period climate lives on the race's own content.
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

// putCityContent creates or replaces a city's content. 保存即生效: the saved
// content is the live content.
//
//	@Summary		Create or replace a city's content
//	@Description	Administrator only. Full-replace PUT: absent sections are cleared. The saved content is live immediately.
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

// cityAIDraftPayload is the strict JSON shape the AI draft generator must
// return. The four fields are deliberately FLAT (not nested under an "intro"
// object): DeepSeek's json_object mode intermittently drops the closing brace
// of a nested object that follows a long text member, and the flattened
// schema removes that failure mode. The handler maps the fields onto
// storage.CityIntro. (Climate moved to race level — the race-content AI draft
// covers it.)
type cityAIDraftPayload struct {
	Overview string `json:"overview"`
	Culture  string `json:"culture"`
	Food     string `json:"food"`
	History  string `json:"history"`
}

// valid reports whether every intro section is present and non-empty. A
// partial draft would silently clear a section the admin already wrote, so
// incomplete payloads are treated as a generation failure (502), not saved.
func (p cityAIDraftPayload) valid() bool {
	for _, s := range []string{p.Overview, p.Culture, p.Food, p.History} {
		if strings.TrimSpace(s) == "" {
			return false
		}
	}
	return true
}

func (p cityAIDraftPayload) intro() *storage.CityIntro {
	return &storage.CityIntro{
		Overview: p.Overview,
		Culture:  p.Culture,
		Food:     p.Food,
		History:  p.History,
	}
}

const cityAIDraftSystemPrompt = `你是马拉松赛事内容编辑助手，负责为中国城市撰写面向跑者的城市介绍草稿。你只能输出严格匹配以下结构的 JSON，不得输出其它字段、文字、代码块或注释，所有内容必须使用中文：

{"overview":"城市总体介绍","culture":"城市文化","food":"城市美食","history":"城市历史"}

要求：
1. overview / culture / food / history 各一段中文，面向参赛跑者。
2. 只写文字，禁止输出任何数值型天气数据（如具体气温、湿度、降雨概率），禁止输出图片 URL。
3. 每段内容 2-4 句话，客观、准确、有吸引力。`

func cityAIDraftUserPrompt(city string) string {
	return "请为城市「" + city + "」生成上述结构的城市介绍草稿。"
}

// aiDraftCityContent generates an AI draft for a city's intro.
//
//	@Summary		Generate an AI city-content draft
//	@Description	Administrator only. Synchronously calls the configured OpenAI-compatible LLM and upserts the city content row with only the intro filled, preserving the other sections. Unconfigured deployments answer 501 ai_draft_not_configured.
//	@Tags			admin
//	@Param			city	path	string	true	"City name"
//	@Success		200		{object}	raceCityContentResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
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
		Intro: out.intro(),
	})
	if err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, raceCityContentResponse{Content: newRaceCityContentDTO(saved)})
}

// raceAIDraftPayload is the strict JSON shape the race AI draft generator must
// return. The summary is deliberately FLAT at the top level (not nested under
// a "climate" object): DeepSeek's json_object mode intermittently drops the
// closing brace of a nested object that follows a long text member, which is
// exactly this payload's shape otherwise. The handler wraps the summary into
// storage.RaceClimate. Unlike the city draft, the race draft carries numeric
// climatology: the race's month is what makes a weather window meaningful.
type raceAIDraftPayload struct {
	Summary        string                      `json:"summary"`
	WeatherWindows []storage.RaceWeatherWindow `json:"weather_windows"`
}

// valid reports whether the climate summary is present and every window is
// complete. A partial draft would silently clear sections the admin already
// wrote, so incomplete payloads are treated as a generation failure (502), not
// saved. Bounds are 2-4 windows: enough to bracket the race date, few enough
// to stay a summary.
func (p raceAIDraftPayload) valid() bool {
	if strings.TrimSpace(p.Summary) == "" {
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

{"summary":"比赛期气候综述","weather_windows":[{"window_start":"MM-DD","window_end":"MM-DD","avg_temp_c":13.5,"temp_high_c":18,"temp_low_c":9,"rain_probability_pct":30,"humidity_pct":65,"wind":"东北风3级"}]}

要求：
1. summary 一段中文（2-4 句）：结合赛事所在城市与比赛时间，描述参赛跑者应预期的气候（气温体感、降水、湿度、风、穿衣建议）。
2. weather_windows 输出 2-4 个以比赛日期所在月份为中心的历史同期天气窗口；数值取该城市历史气候平均值（摄氏度/百分比），不确定的数值用 null。
3. window_start / window_end 必须为 MM-DD 格式且 start 不晚于 end；wind 为简短中文自由文本。
4. 禁止输出图片 URL。`

func raceAIDraftUserPrompt(name, raceDate, city string) string {
	return "请为赛事「" + name + "」（比赛日期 " + raceDate + "，城市：" + city + "）生成上述结构的比赛期气候草稿。"
}

// aiDraftRaceContent generates an AI draft for a race's race-period climate
// (summary + historical weather windows), keyed to the race's city and date.
// The draft merges onto the race_calendar row's climate + weather_windows
// columns; the other sections are untouched.
//
//	@Summary		Generate an AI race-content climate draft
//	@Description	Administrator only. Synchronously calls the configured OpenAI-compatible LLM with the race's name/date/city and merges climate + weather_windows onto the race row, preserving the other sections. Unconfigured deployments answer 501 ai_draft_not_configured.
//	@Tags			admin
//	@Param			race_id	path	int	true	"Race event id"
//	@Success		200		{object}	raceCalendarDetailDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
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

	event.Climate = &storage.RaceClimate{Summary: out.Summary}
	event.WeatherWindows = out.WeatherWindows
	if err := r.store.UpdateRaceCalendarEvent(c.Request.Context(), event); err != nil {
		writeRaceContentError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, newRaceCalendarEventDTO(*event))
}

// ─── Content input validation (shared with the race-calendar handlers) ──────

// raceEventContentInput is the content object of a PATCH /api/admin/races/:id
// body (and the shape the detail DTO mirrors back). It is a FULL REPLACE of
// the six sections: an absent section clears it — the same save-is-live
// semantics the old PUT /content endpoint had. An explicit JSON null at the
// content level (optionalField.Value == nil) clears everything.
type raceEventContentInput struct {
	PartitionRule  *storage.RacePartitionRule  `json:"partition_rule"`
	SignupTimeline *storage.RaceSignupTimeline `json:"signup_timeline"`
	SignupChannels []storage.RaceSignupChannel `json:"signup_channels"`
	PacketPickup   []storage.RacePacketPickup  `json:"packet_pickup"`
	Climate        *storage.RaceClimate        `json:"climate"`
	WeatherWindows []storage.RaceWeatherWindow `json:"weather_windows"`
}

// raceItemContentInput is the content object of the item create/update bodies:
// full-replace of the item's content fields. The item's name is its identity
// on race_item_content and is not settable here.
type raceItemContentInput struct {
	DistanceKm      *float64                     `json:"distance_km"`
	StartPoint      *storage.RacePoint           `json:"start_point"`
	FinishPoint     *storage.RacePoint           `json:"finish_point"`
	TotalAscentM    *int                         `json:"total_ascent_m"`
	ElevationPoints []storage.RaceElevationPoint `json:"elevation_points"`
	AidStations     []storage.RaceAidStation     `json:"aid_stations"`
	Cutoffs         []storage.RaceCutoff         `json:"cutoffs"`
	Prizes          []storage.RacePrize          `json:"prizes"`
	Reputation      *storage.RaceReputation      `json:"reputation"`
	Photos          []storage.RacePhoto          `json:"photos"`
}

// raceEventContentDTO is the admin projection of the six content sections on a
// race row. A nil pointer means the race has never been maintained.
type raceEventContentDTO struct {
	PartitionRule  *storage.RacePartitionRule  `json:"partition_rule"`
	SignupTimeline *storage.RaceSignupTimeline `json:"signup_timeline"`
	SignupChannels []storage.RaceSignupChannel `json:"signup_channels"`
	PacketPickup   []storage.RacePacketPickup  `json:"packet_pickup"`
	Climate        *storage.RaceClimate        `json:"climate"`
	WeatherWindows []storage.RaceWeatherWindow `json:"weather_windows"`
}

func newRaceEventContentDTO(row storage.RaceCalendarEvent) *raceEventContentDTO {
	if !row.HasContent() {
		return nil
	}
	return &raceEventContentDTO{
		PartitionRule:  row.PartitionRule,
		SignupTimeline: row.SignupTimeline,
		SignupChannels: row.SignupChannels,
		PacketPickup:   row.PacketPickup,
		Climate:        row.Climate,
		WeatherWindows: row.WeatherWindows,
	}
}

// raceItemContentDTO is the admin projection of one item's content row. A nil
// pointer means the item has no content yet.
type raceItemContentDTO struct {
	DistanceKm      *float64                     `json:"distance_km"`
	StartPoint      *storage.RacePoint           `json:"start_point"`
	FinishPoint     *storage.RacePoint           `json:"finish_point"`
	TotalAscentM    *int                         `json:"total_ascent_m"`
	ElevationPoints []storage.RaceElevationPoint `json:"elevation_points"`
	AidStations     []storage.RaceAidStation     `json:"aid_stations"`
	Cutoffs         []storage.RaceCutoff         `json:"cutoffs"`
	Prizes          []storage.RacePrize          `json:"prizes"`
	Reputation      *storage.RaceReputation      `json:"reputation"`
	Photos          []storage.RacePhoto          `json:"photos"`
}

func newRaceItemContentDTO(row *storage.RaceItemContent) *raceItemContentDTO {
	if row == nil {
		return nil
	}
	return &raceItemContentDTO{
		DistanceKm:      row.DistanceKm,
		StartPoint:      row.StartPoint,
		FinishPoint:     row.FinishPoint,
		TotalAscentM:    row.TotalAscentM,
		ElevationPoints: row.ElevationPoints,
		AidStations:     row.AidStations,
		Cutoffs:         row.Cutoffs,
		Prizes:          row.Prizes,
		Reputation:      row.Reputation,
		Photos:          row.Photos,
	}
}

// validateRaceEventContent applies the cross-field rules the storage layer
// deliberately does not know about. The rules are the minimum that keeps the
// dataset honest: the partition mode's closed enum, calendar dates, non-empty
// channel entries, and the weather windows' MM-DD/percent bounds. An
// empty-summary climate object carries nothing and is treated as absent.
func validateRaceEventContent(in *raceEventContentInput) error {
	if in.PartitionRule != nil {
		if in.PartitionRule.Mode != "mixed" && in.PartitionRule.Mode != "by_item" {
			return errInvalidRaceContentInput
		}
	}
	if in.SignupTimeline != nil {
		if !isCalendarDate(in.SignupTimeline.StartAt) || !isCalendarDate(in.SignupTimeline.Deadline) {
			return errInvalidRaceContentInput
		}
		if in.SignupTimeline.LotteryResultAt != nil && !isCalendarDate(*in.SignupTimeline.LotteryResultAt) {
			return errInvalidRaceContentInput
		}
	}
	for _, ch := range in.SignupChannels {
		if strings.TrimSpace(ch.Name) == "" || strings.TrimSpace(ch.URL) == "" {
			return errInvalidRaceContentInput
		}
	}
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

// validateRaceItemContent is the item-level counterpart of
// validateRaceEventContent: a cutoff must be a race-day wall clock and a photo
// without a URL carries nothing.
func validateRaceItemContent(in *raceItemContentInput) error {
	for _, cutoff := range in.Cutoffs {
		if !isRaceClock(cutoff.CutoffAt) {
			return errInvalidRaceContentInput
		}
	}
	for _, photo := range in.Photos {
		if strings.TrimSpace(photo.URL) == "" {
			return errInvalidRaceContentInput
		}
	}
	return nil
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
