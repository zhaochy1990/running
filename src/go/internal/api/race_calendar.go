package api

import (
	"context"
	"encoding/json"
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

// RaceCalendarStore is the persistence the admin race-calendar surface needs.
// Every method maps to exactly one endpoint need: the list reads a page of
// events, the detail additionally loads the child items and their content, and
// the mutations are split into event and item operations so the handlers stay
// thin. The item mutations carry the item's content row (one transaction per
// write, see storage.UpdateRaceCalendarItemWithContent).
type RaceCalendarStore interface {
	ListRaceCalendarEvents(ctx context.Context, f storage.RaceCalendarListFilter) ([]storage.RaceCalendarEvent, int64, error)
	GetRaceCalendarEvent(ctx context.Context, id uint64) (*storage.RaceCalendarEvent, error)
	CreateRaceCalendarEvent(ctx context.Context, row *storage.RaceCalendarEvent) error
	UpdateRaceCalendarEvent(ctx context.Context, row *storage.RaceCalendarEvent) error
	DeleteRaceCalendarEvent(ctx context.Context, id uint64) error
	ListRaceCalendarItems(ctx context.Context, eventID uint64) ([]storage.RaceCalendarItem, error)
	ListRaceItemContents(ctx context.Context, eventID uint64) ([]storage.RaceItemContent, error)
	GetRaceCalendarItem(ctx context.Context, id uint64) (*storage.RaceCalendarItem, error)
	CreateRaceCalendarItemWithContent(ctx context.Context, item *storage.RaceCalendarItem, content *storage.RaceItemContent) error
	UpdateRaceCalendarItemWithContent(ctx context.Context, item *storage.RaceCalendarItem, content *storage.RaceItemContent, set bool) error
	DeleteRaceCalendarItem(ctx context.Context, id uint64) error
	MoveRaceContent(ctx context.Context, sourceEventID, targetEventID uint64) error
}

// raceCalendarRoutes serves the administrator race-calendar management surface.
// Mounted on the parent authenticated group so the admin JWT tier can reach it;
// every handler re-checks TierAdmin so user and internal callers are refused.
type raceCalendarRoutes struct {
	store RaceCalendarStore
	log   *zap.Logger
}

func newRaceCalendarRoutes(store RaceCalendarStore, log *zap.Logger) *raceCalendarRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &raceCalendarRoutes{store: store, log: log}
}

// register mounts the admin race-calendar endpoints. The whole surface is
// read/write administrator-only; there is no public race-calendar API in this
// scope.
func (r *raceCalendarRoutes) register(rg *gin.RouterGroup) {
	if r.store == nil {
		return
	}
	rg.GET("/api/admin/races", r.list)
	rg.POST("/api/admin/races", r.create)
	rg.GET("/api/admin/races/:race_id", r.detail)
	rg.PATCH("/api/admin/races/:race_id", r.update)
	rg.DELETE("/api/admin/races/:race_id", r.delete)
	rg.POST("/api/admin/races/:race_id/items", r.createItem)
	rg.PATCH("/api/admin/races/:race_id/items/:item_id", r.updateItem)
	rg.DELETE("/api/admin/races/:race_id/items/:item_id", r.deleteItem)
	rg.POST("/api/admin/races/:race_id/move-content", r.moveContent)
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

// raceCalendarEventDTO is the admin projection of one race. race_types is
// decoded from the stored JSON array so the client never parses a JSON string.
// field_sources maps every editable field to its derived provenance
// (sync / overridden / manual) so the dashboard can render the source badge
// without knowing the origin/override encoding.
type raceCalendarEventDTO struct {
	ID           uint64               `json:"id"`
	Source       string               `json:"source"`
	Origin       string               `json:"origin"`
	Name         string               `json:"name"`
	NameCN       *string              `json:"name_cn"`
	RaceDate     string               `json:"race_date"`
	Month        int8                 `json:"month"`
	DayOfMonth   int8                 `json:"day_of_month"`
	Country      string               `json:"country"`
	Province     *string              `json:"province"`
	City         *string              `json:"city"`
	Label        *string              `json:"label"`
	RaceTypes    []string             `json:"race_types"`
	FieldSources map[string]string    `json:"field_sources"`
	ContentStale bool                 `json:"content_stale"`
	Content      *raceEventContentDTO `json:"content"`
	UpdatedAt    time.Time            `json:"updated_at"`
}

// raceCalendarItemDTO is the admin projection of one race item, including its
// content row (null when the item has none).
type raceCalendarItemDTO struct {
	ID        uint64              `json:"id"`
	Name      string              `json:"name"`
	Type      string              `json:"type"`
	StartTime *string             `json:"start_time"`
	EntryFee  *int                `json:"entry_fee"`
	Quota     *int                `json:"quota"`
	Origin    string              `json:"origin"`
	Content   *raceItemContentDTO `json:"content"`
}

// raceCalendarDetailDTO adds the child item list to the event shape.
type raceCalendarDetailDTO struct {
	raceCalendarEventDTO
	Items []raceCalendarItemDTO `json:"items"`
}

type raceCalendarListResponse struct {
	Races   []raceCalendarEventDTO `json:"races"`
	Total   int64                  `json:"total"`
	Page    int                    `json:"page"`
	PerPage int                    `json:"per_page"`
}

func newRaceCalendarEventDTO(row storage.RaceCalendarEvent) raceCalendarEventDTO {
	return raceCalendarEventDTO{
		ID:           row.ID,
		Source:       row.Source,
		Origin:       row.Origin,
		Name:         row.Name,
		NameCN:       row.NameCN,
		RaceDate:     row.RaceDate,
		Month:        row.Month,
		DayOfMonth:   row.DayOfMonth,
		Country:      row.Country,
		Province:     row.Province,
		City:         row.City,
		Label:        row.Label,
		RaceTypes:    decodeRaceTypes(row.RaceTypes),
		FieldSources: raceCalendarFieldSources(row),
		ContentStale: row.ContentStale,
		Content:      newRaceEventContentDTO(row),
		UpdatedAt:    row.UpdatedAt,
	}
}

func newRaceCalendarItemDTO(row storage.RaceCalendarItem, content *raceItemContentDTO) raceCalendarItemDTO {
	return raceCalendarItemDTO{
		ID:        row.ID,
		Name:      row.Name,
		Type:      row.Type,
		StartTime: row.StartTime,
		EntryFee:  row.EntryFee,
		Quota:     row.Quota,
		Origin:    row.Origin,
		Content:   content,
	}
}

// newRaceCalendarItemDTOs projects items and matches each with its content row
// by item name (the key race_item_content rows live on).
func newRaceCalendarItemDTOs(rows []storage.RaceCalendarItem, contents []storage.RaceItemContent) []raceCalendarItemDTO {
	byName := make(map[string]*storage.RaceItemContent, len(contents))
	for i := range contents {
		byName[contents[i].ItemName] = &contents[i]
	}
	out := make([]raceCalendarItemDTO, 0, len(rows))
	for _, row := range rows {
		var content *raceItemContentDTO
		if c, ok := byName[row.Name]; ok {
			content = newRaceItemContentDTO(c)
		}
		out = append(out, newRaceCalendarItemDTO(row, content))
	}
	return out
}

// raceCalendarEditableFields is the field-source key space the dashboard
// renders badges for.
var raceCalendarEditableFields = []string{
	"name", "name_cn", "race_date", "country", "province", "city", "label", "race_types",
}

// raceCalendarFieldSources derives every editable field's provenance:
//   - on a manual row (created by an admin, or detached by a key-field edit)
//     every field is manual;
//   - otherwise a field named in admin_overrides is overridden;
//   - the rest are synced.
func raceCalendarFieldSources(row storage.RaceCalendarEvent) map[string]string {
	overrides := make(map[string]bool, len(row.AdminOverrides))
	for _, f := range row.AdminOverrides {
		overrides[f] = true
	}
	out := make(map[string]string, len(raceCalendarEditableFields))
	for _, field := range raceCalendarEditableFields {
		switch {
		case row.Origin == storage.RaceOriginManual:
			out[field] = "manual"
		case overrides[field]:
			out[field] = "overridden"
		default:
			out[field] = "sync"
		}
	}
	return out
}

// decodeRaceTypes turns the stored JSON array into a slice; a NULL or malformed
// value degrades to an empty slice so the DTO stays well-formed.
func decodeRaceTypes(raw *string) []string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return []string{}
	}
	var out []string
	if err := json.Unmarshal([]byte(*raw), &out); err != nil {
		return []string{}
	}
	if out == nil {
		return []string{}
	}
	return out
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// list returns one page of races with the year/source/month/keyword filters.
//
//	@Summary		List the race calendar
//	@Description	Administrator only. Returns a page of races ordered by race date, filtered by optional year, source (国际田联 / 中国田协 / manual), month and keyword (matches name or name_cn).
//	@Tags			admin
//	@Param			year		query	int		false	"4-digit year"
//	@Param			month		query	int		false	"Month 1-12"
//	@Param			source		query	string	false	"Source label"
//	@Param			keyword		query	string	false	"Substring of name or name_cn"
//	@Param			page		query	int		false	"Page (1-based, default 1)"
//	@Param			per_page	query	int		false	"Page size (default 20, max 100)"
//	@Success		200			{object}	raceCalendarListResponse
//	@Failure		400			{object}	errorResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races [get]
func (r *raceCalendarRoutes) list(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	filter, ok := bindRaceListFilter(c)
	if !ok {
		return
	}
	rows, total, err := r.store.ListRaceCalendarEvents(c.Request.Context(), filter)
	if err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	dtos := make([]raceCalendarEventDTO, 0, len(rows))
	for _, row := range rows {
		dtos = append(dtos, newRaceCalendarEventDTO(row))
	}
	c.JSON(http.StatusOK, raceCalendarListResponse{
		Races: dtos, Total: total, Page: filter.Page, PerPage: filter.PerPage,
	})
}

// detail returns one race including its items.
//
//	@Summary		Get one race with its items
//	@Description	Administrator only. Returns the full event plus its child items.
//	@Tags			admin
//	@Param			race_id	path	int	true	"Race id"
//	@Success		200		{object}	raceCalendarDetailDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id} [get]
func (r *raceCalendarRoutes) detail(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	row, err := r.store.GetRaceCalendarEvent(c.Request.Context(), id)
	if err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	detail, ok := r.loadDetail(c, row)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, detail)
}

// loadDetail assembles the detail DTO (event + items + per-item content) for
// the handlers that return the full race shape.
func (r *raceCalendarRoutes) loadDetail(c *gin.Context, row *storage.RaceCalendarEvent) (raceCalendarDetailDTO, bool) {
	items, err := r.store.ListRaceCalendarItems(c.Request.Context(), row.ID)
	if err != nil {
		writeRaceCalendarError(c, r.log, err)
		return raceCalendarDetailDTO{}, false
	}
	contents, err := r.store.ListRaceItemContents(c.Request.Context(), row.ID)
	if err != nil {
		writeRaceCalendarError(c, r.log, err)
		return raceCalendarDetailDTO{}, false
	}
	return raceCalendarDetailDTO{
		raceCalendarEventDTO: newRaceCalendarEventDTO(*row),
		Items:                newRaceCalendarItemDTOs(items, contents),
	}, true
}

// raceCalendarCreateRequest is the body of POST /api/admin/races. origin and
// source are forced server-side (manual), so a caller cannot create a row the
// sync will later overwrite.
type raceCalendarCreateRequest struct {
	Name      string   `json:"name"`
	NameCN    *string  `json:"name_cn"`
	RaceDate  string   `json:"race_date"`
	Country   string   `json:"country"`
	Province  *string  `json:"province"`
	City      *string  `json:"city"`
	Label     *string  `json:"label"`
	RaceTypes []string `json:"race_types"`
}

// create adds an administrator-authored race.
//
//	@Summary		Create a race manually
//	@Description	Administrator only. Creates a race with origin=manual and source=manual; it is never touched by the sync. Fails with 409 when the (name, race_date) already exists for the manual source.
//	@Tags			admin
//	@Param			body	body		raceCalendarCreateRequest	true	"Race fields"
//	@Success		201		{object}	raceCalendarDetailDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		413		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races [post]
func (r *raceCalendarRoutes) create(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	var req raceCalendarCreateRequest
	if !bindRaceCalendarJSON(c, &req, "invalid_race") {
		return
	}
	row, ok := buildManualRace(c, req)
	if !ok {
		return
	}
	if err := r.store.CreateRaceCalendarEvent(c.Request.Context(), row); err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	c.JSON(http.StatusCreated, raceCalendarDetailDTO{
		raceCalendarEventDTO: newRaceCalendarEventDTO(*row),
		Items:                []raceCalendarItemDTO{},
	})
}

// optionalField distinguishes an absent JSON key from an explicit null so a
// PATCH can clear a nullable field (null) without also treating "not sent" as
// a clear. Set is true whenever the key was present in the body; Value is nil
// for an explicit null.
type optionalField[T any] struct {
	Set   bool
	Value *T
}

func (o *optionalField[T]) UnmarshalJSON(data []byte) error {
	o.Set = true
	if string(data) == "null" {
		o.Value = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}

// raceCalendarUpdateRequest is the body of PATCH /api/admin/races/:id. Fields
// are optional; overrides names the sync-managed fields the administrator is
// taking over and resetFields names fields to hand back to the sync (cleared
// here, refilled on the next sync). Editing name or race_date detaches the row
// (origin becomes manual). Nullable fields use optionalField so an explicit
// null clears them.
type raceCalendarUpdateRequest struct {
	Name        *string                               `json:"name"`
	NameCN      optionalField[string]                 `json:"name_cn" swaggertype:"string"`
	RaceDate    *string                               `json:"race_date"`
	Country     *string                               `json:"country"`
	Province    optionalField[string]                 `json:"province" swaggertype:"string"`
	City        optionalField[string]                 `json:"city" swaggertype:"string"`
	Label       optionalField[string]                 `json:"label" swaggertype:"string"`
	RaceTypes   *[]string                             `json:"race_types"`
	Overrides   []string                              `json:"overrides"`
	ResetFields []string                              `json:"reset_fields"`
	// Content is tri-state: absent = untouched, explicit null = clear every
	// section, object = full replace of the six sections. The same PATCH
	// carries the base fields and the content, but the dashboard sends them
	// as two independent saves.
	Content optionalField[raceEventContentInput] `json:"content" swaggertype:"object"`
}

// update applies a partial edit and merges the override markers.
//
//	@Summary		Edit a race
//	@Description	Administrator only. Applies provided fields, unions overrides into the row's admin-override set, and clears reset_fields. Editing name/race_date upgrades origin to manual so the sync no longer owns the row.
//	@Tags			admin
//	@Param			race_id	path	int							true	"Race id"
//	@Param			body	body	raceCalendarUpdateRequest	true	"Fields to update"
//	@Success		200		{object}	raceCalendarDetailDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		413		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id} [patch]
func (r *raceCalendarRoutes) update(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	var req raceCalendarUpdateRequest
	if !bindRaceCalendarJSON(c, &req, "invalid_race") {
		return
	}
	row, err := r.store.GetRaceCalendarEvent(c.Request.Context(), id)
	if err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	if !applyRaceCalendarUpdate(c, row, req) {
		return
	}
	if err := r.store.UpdateRaceCalendarEvent(c.Request.Context(), row); err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	detail, ok := r.loadDetail(c, row)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, detail)
}

// raceContentMoveRequest is the body of POST .../move-content.
type raceContentMoveRequest struct {
	TargetRaceID uint64 `json:"target_race_id"`
}

// moveContent resolves a content_stale row: it copies the six content sections
// and every item content row to the target race (409 content_conflict when the
// target already has content), then deletes the source row. 404 when either
// race is missing.
//
//	@Summary		Move a race's content to another race
//	@Description	Administrator only. Copies the content sections and item content from this race to the target race and deletes this race (with its items). 409 when the target already has content.
//	@Tags			admin
//	@Param			race_id	path	int						true	"Source race id"
//	@Param			body	body	raceContentMoveRequest	true	"Move payload"
//	@Success		204
//	@Failure		400	{object}	errorResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		409	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id}/move-content [post]
func (r *raceCalendarRoutes) moveContent(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	sourceID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	var req raceContentMoveRequest
	if !bindRaceCalendarJSON(c, &req, "invalid_request") {
		return
	}
	if req.TargetRaceID == 0 {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_request"})
		return
	}
	if err := r.store.MoveRaceContent(c.Request.Context(), sourceID, req.TargetRaceID); err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// delete removes a race and its items.
//
//	@Summary		Delete a race
//	@Description	Administrator only. Deletes the race and all its items.
//	@Tags			admin
//	@Param			race_id	path	int	true	"Race id"
//	@Success		204
//	@Failure		400	{object}	errorResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id} [delete]
func (r *raceCalendarRoutes) delete(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	if err := r.store.DeleteRaceCalendarEvent(c.Request.Context(), id); err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// raceCalendarItemCreateRequest is the body of POST .../items. Content is
// optional: absent or null = no content row.
type raceCalendarItemCreateRequest struct {
	Name      string                `json:"name"`
	Type      string                `json:"type"`
	StartTime *string               `json:"start_time"`
	EntryFee  *int                  `json:"entry_fee"`
	Quota     *int                  `json:"quota"`
	Content   *raceItemContentInput `json:"content"`
}

// createItem adds an administrator-authored item to a race.
//
//	@Summary		Add a race item
//	@Description	Administrator only. Adds an item with origin=manual; it is never regenerated by the sync.
//	@Tags			admin
//	@Param			race_id	path	int								true	"Race id"
//	@Param			body	body	raceCalendarItemCreateRequest	true	"Item fields"
//	@Success		201		{object}	raceCalendarItemDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		413		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id}/items [post]
func (r *raceCalendarRoutes) createItem(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	eventID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	if _, err := r.store.GetRaceCalendarEvent(c.Request.Context(), eventID); err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	var req raceCalendarItemCreateRequest
	if !bindRaceCalendarJSON(c, &req, "invalid_race_item") {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race_item"})
		return
	}
	itemType := normalizeRaceItemType(req.Type)
	item := &storage.RaceCalendarItem{
		RaceEventID: eventID,
		Name:        name,
		Type:        itemType,
		StartTime:   normalizeStartTime(req.StartTime),
		EntryFee:    req.EntryFee,
		Quota:       req.Quota,
		Origin:      storage.RaceOriginManual,
	}
	var content *storage.RaceItemContent
	if req.Content != nil {
		if err := validateRaceItemContent(req.Content); err != nil {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_request"})
			return
		}
		content = &storage.RaceItemContent{
			DistanceKm:      req.Content.DistanceKm,
			StartPoint:      req.Content.StartPoint,
			FinishPoint:     req.Content.FinishPoint,
			TotalAscentM:    req.Content.TotalAscentM,
			ElevationPoints: req.Content.ElevationPoints,
			AidStations:     req.Content.AidStations,
			Cutoffs:         req.Content.Cutoffs,
			Prizes:          req.Content.Prizes,
			Reputation:      req.Content.Reputation,
			Photos:          req.Content.Photos,
		}
	}
	if err := r.store.CreateRaceCalendarItemWithContent(c.Request.Context(), item, content); err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	c.JSON(http.StatusCreated, newRaceCalendarItemDTO(*item, newRaceItemContentDTO(content)))
}

// raceCalendarItemUpdateRequest is the body of PATCH .../items/:item_id.
// Content is tri-state: absent = untouched, explicit null = delete the content
// row, object = full replace.
type raceCalendarItemUpdateRequest struct {
	Name      *string                             `json:"name"`
	Type      *string                             `json:"type"`
	StartTime optionalField[string]               `json:"start_time" swaggertype:"string"`
	EntryFee  optionalField[int]                  `json:"entry_fee" swaggertype:"integer"`
	Quota     optionalField[int]                  `json:"quota" swaggertype:"integer"`
	Content   optionalField[raceItemContentInput] `json:"content" swaggertype:"object"`
}

// updateItem edits an item. Editing a sync-owned item upgrades it to manual so
// the next sync's regeneration cannot erase the administrator's change.
//
//	@Summary		Edit a race item
//	@Description	Administrator only. Applies provided fields; a sync-owned item becomes manual once edited.
//	@Tags			admin
//	@Param			race_id	path	int								true	"Race id"
//	@Param			item_id	path	int								true	"Item id"
//	@Param			body	body	raceCalendarItemUpdateRequest	true	"Fields to update"
//	@Success		200		{object}	raceCalendarItemDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		413		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id}/items/{item_id} [patch]
func (r *raceCalendarRoutes) updateItem(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	eventID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	itemID, ok := parseUintParam(c, "item_id")
	if !ok {
		return
	}
	var req raceCalendarItemUpdateRequest
	if !bindRaceCalendarJSON(c, &req, "invalid_race_item") {
		return
	}
	item, err := r.store.GetRaceCalendarItem(c.Request.Context(), itemID)
	if err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	if item.RaceEventID != eventID {
		c.JSON(http.StatusNotFound, errorResponse{Error: "race_item_not_found"})
		return
	}
	if !applyRaceItemUpdate(c, item, req) {
		return
	}
	var content *storage.RaceItemContent
	if req.Content.Set && req.Content.Value != nil {
		if err := validateRaceItemContent(req.Content.Value); err != nil {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_request"})
			return
		}
		content = &storage.RaceItemContent{
			DistanceKm:      req.Content.Value.DistanceKm,
			StartPoint:      req.Content.Value.StartPoint,
			FinishPoint:     req.Content.Value.FinishPoint,
			TotalAscentM:    req.Content.Value.TotalAscentM,
			ElevationPoints: req.Content.Value.ElevationPoints,
			AidStations:     req.Content.Value.AidStations,
			Cutoffs:         req.Content.Value.Cutoffs,
			Prizes:          req.Content.Value.Prizes,
			Reputation:      req.Content.Value.Reputation,
			Photos:          req.Content.Value.Photos,
		}
	}
	if err := r.store.UpdateRaceCalendarItemWithContent(c.Request.Context(), item, content, req.Content.Set); err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	var contentDTO *raceItemContentDTO
	if req.Content.Set {
		if req.Content.Value == nil {
			contentDTO = nil // explicit delete
		} else {
			contentDTO = newRaceItemContentDTO(content)
		}
	} else {
		// Untouched by this PATCH: read back whatever the row carries.
		contents, err := r.store.ListRaceItemContents(c.Request.Context(), item.RaceEventID)
		if err != nil {
			writeRaceCalendarError(c, r.log, err)
			return
		}
		for i := range contents {
			if contents[i].ItemName == item.Name {
				contentDTO = newRaceItemContentDTO(&contents[i])
				break
			}
		}
	}
	c.JSON(http.StatusOK, newRaceCalendarItemDTO(*item, contentDTO))
}

// deleteItem removes one item.
//
//	@Summary		Delete a race item
//	@Description	Administrator only. Deletes one item.
//	@Tags			admin
//	@Param			race_id	path	int	true	"Race id"
//	@Param			item_id	path	int	true	"Item id"
//	@Success		204
//	@Failure		400	{object}	errorResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/races/{race_id}/items/{item_id} [delete]
func (r *raceCalendarRoutes) deleteItem(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	eventID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	itemID, ok := parseUintParam(c, "item_id")
	if !ok {
		return
	}
	item, err := r.store.GetRaceCalendarItem(c.Request.Context(), itemID)
	if err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	if item.RaceEventID != eventID {
		c.JSON(http.StatusNotFound, errorResponse{Error: "race_item_not_found"})
		return
	}
	if err := r.store.DeleteRaceCalendarItem(c.Request.Context(), itemID); err != nil {
		writeRaceCalendarError(c, r.log, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// bindRaceListFilter parses and validates the list query. Page/per_page are
// clamped so a caller cannot ask for an unbounded page.
func bindRaceListFilter(c *gin.Context) (storage.RaceCalendarListFilter, bool) {
	f := storage.RaceCalendarListFilter{
		Year:    strings.TrimSpace(c.Query("year")),
		Source:  strings.TrimSpace(c.Query("source")),
		Keyword: strings.TrimSpace(c.Query("keyword")),
	}
	switch strings.TrimSpace(c.Query("content_stale")) {
	case "", "0", "false":
	case "1", "true":
		f.ContentStale = true
	default:
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_content_stale"})
		return f, false
	}
	if f.Year != "" && !isFourDigitYear(f.Year) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_year"})
		return f, false
	}
	if raw := c.Query("month"); raw != "" {
		month, err := strconv.Atoi(raw)
		if err != nil || month < 1 || month > 12 {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_month"})
			return f, false
		}
		f.Month = month
	}
	f.Page = 1
	if raw := c.Query("page"); raw != "" {
		page, err := strconv.Atoi(raw)
		if err != nil || page < 1 {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_page"})
			return f, false
		}
		f.Page = page
	}
	f.PerPage = 20
	if raw := c.Query("per_page"); raw != "" {
		perPage, err := strconv.Atoi(raw)
		if err != nil || perPage < 1 || perPage > 100 {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_per_page"})
			return f, false
		}
		f.PerPage = perPage
	}
	return f, true
}

// buildManualRace validates a create body and assembles the manual row.
func buildManualRace(c *gin.Context, req raceCalendarCreateRequest) (*storage.RaceCalendarEvent, bool) {
	name := strings.TrimSpace(req.Name)
	if name == "" || len(name) > 255 {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race"})
		return nil, false
	}
	date := strings.TrimSpace(req.RaceDate)
	if !isCalendarDate(date) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race_date"})
		return nil, false
	}
	country := strings.TrimSpace(req.Country)
	if country == "" {
		country = "CHN"
	}
	if len(country) > 8 {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race"})
		return nil, false
	}
	month, day := storage.MonthDayOf(date)
	raceTypes, ok := encodeRaceTypes(c, req.RaceTypes)
	if !ok {
		return nil, false
	}
	return &storage.RaceCalendarEvent{
		Source:     storage.RaceSourceManual,
		Origin:     storage.RaceOriginManual,
		Name:       name,
		NameCN:     normalizeOptionalString(req.NameCN),
		RaceDate:   date,
		Month:      month,
		DayOfMonth: day,
		Country:    country,
		Province:   normalizeOptionalString(req.Province),
		City:       normalizeOptionalString(req.City),
		Label:      normalizeOptionalString(req.Label),
		RaceTypes:  raceTypes,
	}, true
}

// applyRaceCalendarUpdate mutates row in place. It reports whether the handler
// may proceed (a malformed value writes 400 and returns false).
func applyRaceCalendarUpdate(c *gin.Context, row *storage.RaceCalendarEvent, req raceCalendarUpdateRequest) bool {
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len(name) > 255 {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race"})
			return false
		}
		if name != row.Name {
			row.Name = name
			row.Origin = storage.RaceOriginManual
		}
	}
	if req.RaceDate != nil {
		date := strings.TrimSpace(*req.RaceDate)
		if !isCalendarDate(date) {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race_date"})
			return false
		}
		if date != row.RaceDate {
			row.RaceDate = date
			row.Month, row.DayOfMonth = storage.MonthDayOf(date)
			row.Origin = storage.RaceOriginManual
		}
	}
	if req.NameCN.Set {
		row.NameCN = normalizeOptionalString(req.NameCN.Value)
	}
	if req.Country != nil {
		country := strings.TrimSpace(*req.Country)
		if country == "" || len(country) > 8 {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race"})
			return false
		}
		row.Country = country
	}
	if req.Province.Set {
		row.Province = normalizeOptionalString(req.Province.Value)
	}
	if req.City.Set {
		row.City = normalizeOptionalString(req.City.Value)
	}
	if req.Label.Set {
		row.Label = normalizeOptionalString(req.Label.Value)
	}
	if req.RaceTypes != nil {
		encoded, ok := encodeRaceTypes(c, *req.RaceTypes)
		if !ok {
			return false
		}
		row.RaceTypes = encoded
	}

	overrides := make(map[string]bool, len(row.AdminOverrides)+len(req.Overrides))
	for _, f := range row.AdminOverrides {
		overrides[f] = true
	}
	for _, f := range req.Overrides {
		if !storage.IsRaceCalendarOverrideable(f) {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_override_field"})
			return false
		}
		overrides[f] = true
	}
	for _, f := range req.ResetFields {
		if !storage.IsRaceCalendarOverrideable(f) {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_override_field"})
			return false
		}
		delete(overrides, f)
		clearRaceCalendarField(row, f)
	}
	row.AdminOverrides = sortedOverrideFields(overrides)

	if req.Content.Set {
		if req.Content.Value == nil {
			row.PartitionRule = nil
			row.SignupTimeline = nil
			row.SignupChannels = nil
			row.PacketPickup = nil
			row.Climate = nil
			row.WeatherWindows = nil
		} else {
			in := req.Content.Value
			if err := validateRaceEventContent(in); err != nil {
				c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_request"})
				return false
			}
			// An empty-summary climate object is normalized to absent, matching
			// the old PUT /content semantics.
			if in.Climate != nil && strings.TrimSpace(in.Climate.Summary) == "" {
				in.Climate = nil
			}
			row.PartitionRule = in.PartitionRule
			row.SignupTimeline = in.SignupTimeline
			row.SignupChannels = in.SignupChannels
			row.PacketPickup = in.PacketPickup
			row.Climate = in.Climate
			row.WeatherWindows = in.WeatherWindows
		}
		// A race whose content was just fully cleared no longer needs the
		// stale protection — there is nothing left to lose.
		if !row.HasContent() {
			row.ContentStale = false
		}
	}
	return true
}

// clearRaceCalendarField hands one sync-managed field back to the sync by
// clearing its value; the next sync refills it. name_cn has no upstream value
// for the World Athletics source, so it stays NULL there until curated again.
func clearRaceCalendarField(row *storage.RaceCalendarEvent, field string) {
	switch field {
	case "name_cn":
		row.NameCN = nil
	case "country":
		row.Country = ""
	case "province":
		row.Province = nil
	case "city":
		row.City = nil
	case "label":
		row.Label = nil
	case "race_types":
		row.RaceTypes = nil
	}
}

// applyRaceItemUpdate mutates item in place.
func applyRaceItemUpdate(c *gin.Context, item *storage.RaceCalendarItem, req raceCalendarItemUpdateRequest) bool {
	changed := false
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len(name) > 255 {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race_item"})
			return false
		}
		if name != item.Name {
			item.Name = name
			changed = true
		}
	}
	if req.Type != nil {
		item.Type = normalizeRaceItemType(*req.Type)
		changed = true
	}
	if req.StartTime.Set {
		item.StartTime = normalizeStartTime(req.StartTime.Value)
		changed = true
	}
	if req.EntryFee.Set {
		if req.EntryFee.Value != nil && *req.EntryFee.Value < 0 {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race_item"})
			return false
		}
		item.EntryFee = req.EntryFee.Value
		changed = true
	}
	if req.Quota.Set {
		if req.Quota.Value != nil && *req.Quota.Value < 0 {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race_item"})
			return false
		}
		item.Quota = req.Quota.Value
		changed = true
	}
	if changed {
		item.Origin = storage.RaceOriginManual
	}
	return true
}

// bindRaceCalendarJSON decodes a JSON body, mapping an oversized body to 413 and
// any other decode failure to 400 with the supplied error code.
func bindRaceCalendarJSON(c *gin.Context, dst any, code string) bool {
	if err := c.ShouldBindJSON(dst); err != nil {
		if isBodyTooLarge(err) {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: code + "_too_large"})
			return false
		}
		c.JSON(http.StatusBadRequest, errorResponse{Error: code})
		return false
	}
	return true
}

// parseUintParam parses a positive integer path parameter.
func parseUintParam(c *gin.Context, name string) (uint64, bool) {
	raw := c.Param(name)
	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || value == 0 {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_" + name})
		return 0, false
	}
	return value, true
}

// writeRaceCalendarError maps storage sentinels onto HTTP status codes.
func writeRaceCalendarError(c *gin.Context, log *zap.Logger, err error) {
	switch {
	case errors.Is(err, storage.ErrRaceCalendarNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "race_not_found"})
	case errors.Is(err, storage.ErrRaceCalendarConflict):
		c.JSON(http.StatusConflict, errorResponse{Error: "race_conflict"})
	case errors.Is(err, storage.ErrRaceContentConflict):
		c.JSON(http.StatusConflict, errorResponse{Error: "content_conflict"})
	default:
		if log != nil {
			log.Error("race calendar write failed", zap.Error(err))
		}
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal_error"})
	}
}

// encodeRaceTypes validates and JSON-encodes the event race-type list. A nil
// input yields NULL (no type asserted); an over-long list is a 400 rather than a
// MySQL 1406.
func encodeRaceTypes(c *gin.Context, types []string) (*string, bool) {
	if types == nil {
		return nil, true
	}
	cleaned := make([]string, 0, len(types))
	for _, t := range types {
		t = strings.TrimSpace(t)
		if t == "" || len(t) > 32 {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race_types"})
			return nil, false
		}
		cleaned = append(cleaned, t)
	}
	encoded, err := json.Marshal(cleaned)
	if err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race_types"})
		return nil, false
	}
	s := string(encoded)
	if len(s) > 255 {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_race_types"})
		return nil, false
	}
	return &s, true
}

// normalizeOptionalString trims an optional string and maps the empty string to
// NULL (the column's "not set" representation).
func normalizeOptionalString(s *string) *string {
	if s == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*s)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// normalizeRaceItemType defaults an empty item type to Unknown (the shared
// vocabulary's "source gave us nothing" token).
func normalizeRaceItemType(t string) string {
	t = strings.TrimSpace(t)
	if t == "" {
		return "Unknown"
	}
	return t
}

// normalizeStartTime trims an optional "HH:MM" and maps empty to NULL.
func normalizeStartTime(s *string) *string {
	return normalizeOptionalString(s)
}

// sortedOverrideFields returns the override names in the canonical field order,
// so the stored JSON is stable across edits.
func sortedOverrideFields(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for _, f := range storage.RaceCalendarOverrideableFields {
		if set[f] {
			out = append(out, f)
		}
	}
	return out
}

// isFourDigitYear reports whether s is exactly four digits.
func isFourDigitYear(s string) bool {
	if len(s) != 4 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// isCalendarDate reports whether s is a well-formed "2006-01-02" date.
func isCalendarDate(s string) bool {
	if len(s) != 10 {
		return false
	}
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return false
	}
	return true
}
