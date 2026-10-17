// roadmap.go is the product-roadmap surface (devops#551, contract per
// devops#515's resolution): the user-side read + vote endpoints and the
// administrator feature-maintenance endpoints.
//
//	User:  GET    /api/roadmap                        (single-shot full list, no paging)
//	       POST   /api/roadmap/features/:id/vote      (idempotent; backlog only)
//	       DELETE /api/roadmap/features/:id/vote      (idempotent)
//	Admin: GET    /api/admin/roadmap/features         (?status= filter, live votes)
//	       POST   /api/admin/roadmap/features         (defaults to draft)
//	       PATCH  /api/admin/roadmap/features/:id     (fields + status in one entry)
//	       DELETE /api/admin/roadmap/features/:id     (draft/backlog only)
//
// Vote counts are live COUNTs — the feature row never carries a count column;
// only the →released transition freezes votes_snapshot (a historical fact
// that account erasure never rolls back).
package api

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// roadmapNewWindow is the is_new derivation window: a backlog feature created
// within the last 7 Shanghai calendar days renders the「新」badge.
const roadmapNewWindow = 7 * 24 * time.Hour

// ─────────────────────────────────────────────────────────────────────────────
// Dependency. A narrow port so the api package stays free of GORM. Satisfied
// by *storage.Store.
// ─────────────────────────────────────────────────────────────────────────────

// RoadmapStore is the persistence the roadmap endpoints need.
type RoadmapStore interface {
	ListRoadmapFeatures(ctx context.Context, status string) ([]storage.RoadmapFeature, error)
	GetRoadmapFeature(ctx context.Context, id uint64) (*storage.RoadmapFeature, error)
	CreateRoadmapFeature(ctx context.Context, row *storage.RoadmapFeature) error
	UpdateRoadmapFeature(ctx context.Context, row *storage.RoadmapFeature, releasing bool) error
	DeleteRoadmapFeature(ctx context.Context, id uint64) error
	RoadmapVoteCounts(ctx context.Context) (map[uint64]uint64, error)
	RoadmapVoteIDsByUser(ctx context.Context, userID string) ([]uint64, error)
	AddRoadmapVote(ctx context.Context, userID string, featureID uint64) error
	RemoveRoadmapVote(ctx context.Context, userID string, featureID uint64) error
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type roadmapRoutes struct {
	store RoadmapStore
	log   *zap.Logger
}

func newRoadmapRoutes(store RoadmapStore, log *zap.Logger) *roadmapRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &roadmapRoutes{store: store, log: log}
}

// registerUser mounts the user-tier surface. User-only (rejectAdminCaller
// group): the admin tier manages features through the admin surface below.
func (r *roadmapRoutes) registerUser(rg *gin.RouterGroup) {
	if r.store == nil {
		return
	}
	rg.GET("/api/roadmap", r.userList)
	rg.POST("/api/roadmap/features/:id/vote", r.vote)
	rg.DELETE("/api/roadmap/features/:id/vote", r.unvote)
}

// registerAdmin mounts the administrator surface on the parent authenticated
// group; every handler re-checks TierAdmin so user and internal callers are
// refused (same pattern as the race-calendar admin tab).
func (r *roadmapRoutes) registerAdmin(rg *gin.RouterGroup) {
	if r.store == nil {
		return
	}
	rg.GET("/api/admin/roadmap/features", r.adminList)
	rg.POST("/api/admin/roadmap/features", r.adminCreate)
	rg.PATCH("/api/admin/roadmap/features/:id", r.adminPatch)
	rg.DELETE("/api/admin/roadmap/features/:id", r.adminDelete)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

// roadmapSummaryDTO is the GET /api/roadmap summary block.
type roadmapSummaryDTO struct {
	MyVotes       int `json:"my_votes"`
	TotalVotes    int `json:"total_votes"`
	ReleasedCount int `json:"released_count"`
}

// roadmapBacklogItem is one votable idea; voted mirrors the caller's own vote.
type roadmapBacklogItem struct {
	ID          uint64 `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Category    string `json:"category"`
	IsNew       bool   `json:"is_new"`
	Votes       uint64 `json:"votes"`
	Voted       bool   `json:"voted"`
}

// roadmapAcceptedItem is one scheduled idea; votes stay live.
type roadmapAcceptedItem struct {
	ID          uint64 `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Category    string `json:"category"`
	PlannedNote string `json:"planned_note"`
	Votes       uint64 `json:"votes"`
}

// roadmapReleasedItem is one shipped feature; the vote number is the frozen
// release-time snapshot, never the live count.
type roadmapReleasedItem struct {
	ID            uint64 `json:"id"`
	Title         string `json:"title"`
	Description   string `json:"description"`
	ReleasedAt    string `json:"released_at"`
	VotesSnapshot uint64 `json:"votes_snapshot"`
}

// roadmapResponse is the GET /api/roadmap body: one shot, all three sections,
// drafts never appear.
type roadmapResponse struct {
	Summary  roadmapSummaryDTO     `json:"summary"`
	Backlog  []roadmapBacklogItem  `json:"backlog"`
	Accepted []roadmapAcceptedItem `json:"accepted"`
	Released []roadmapReleasedItem `json:"released"`
}

// roadmapAdminFeatureDTO is one feature as the admin list/mutation renders it:
// every stored field plus the live vote count.
type roadmapAdminFeatureDTO struct {
	ID            uint64  `json:"id"`
	Title         string  `json:"title"`
	Description   string  `json:"description"`
	Category      string  `json:"category"`
	Status        string  `json:"status"`
	PlannedNote   string  `json:"planned_note"`
	ReleasedAt    *string `json:"released_at"`
	VotesSnapshot uint64  `json:"votes_snapshot"`
	Votes         uint64  `json:"votes"`
	CreatedAt     string  `json:"created_at"`
	UpdatedAt     string  `json:"updated_at"`
}

type roadmapAdminListResponse struct {
	Features []roadmapAdminFeatureDTO `json:"features"`
}

// roadmapVoteResponse is the POST/DELETE vote body: the resulting state after
// the idempotent operation.
type roadmapVoteResponse struct {
	FeatureID uint64 `json:"feature_id"`
	Voted     bool   `json:"voted"`
}

// ─────────────────────────────────────────────────────────────────────────────
// User handlers
// ─────────────────────────────────────────────────────────────────────────────

// userList serves GET /api/roadmap — the full list in one shot (<100 rows, no
// paging): summary + the three status groups, drafts never shown. Backlog
// sorts by live votes desc (newer created_at wins ties), accepted by
// planned_note asc with empty values sinking, released by released_at desc.
//
//	@Summary		List the product roadmap
//	@Description	Returns the summary plus backlog/accepted/released features with live votes, the caller's voted flags and derived is_new badges. No pagination.
//	@Tags			roadmap
//	@Produce		json
//	@Success		200	{object}	roadmapResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/roadmap [get]
func (r *roadmapRoutes) userList(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	feats, err := r.store.ListRoadmapFeatures(c.Request.Context(), "")
	if err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	counts, err := r.store.RoadmapVoteCounts(c.Request.Context())
	if err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	myIDs, err := r.store.RoadmapVoteIDsByUser(c.Request.Context(), uid)
	if err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	voted := make(map[uint64]bool, len(myIDs))
	for _, id := range myIDs {
		voted[id] = true
	}

	today := timefmt.ShanghaiToday()
	resp := roadmapResponse{
		Backlog:  make([]roadmapBacklogItem, 0),
		Accepted: make([]roadmapAcceptedItem, 0),
		Released: make([]roadmapReleasedItem, 0),
	}
	for i := range feats {
		f := &feats[i]
		switch f.Status {
		case storage.RoadmapStatusBacklog:
			resp.Backlog = append(resp.Backlog, roadmapBacklogItem{
				ID: f.ID, Title: f.Title, Description: f.Description, Category: f.Category,
				IsNew: today.Sub(timefmt.ShanghaiDay(f.CreatedAt)) <= roadmapNewWindow,
				Votes: counts[f.ID], Voted: voted[f.ID],
			})
		case storage.RoadmapStatusAccepted:
			resp.Accepted = append(resp.Accepted, roadmapAcceptedItem{
				ID: f.ID, Title: f.Title, Description: f.Description, Category: f.Category,
				PlannedNote: f.PlannedNote, Votes: counts[f.ID],
			})
		case storage.RoadmapStatusReleased:
			resp.Released = append(resp.Released, roadmapReleasedItem{
				ID: f.ID, Title: f.Title, Description: f.Description,
				ReleasedAt:    f.ReleasedAt.In(timefmt.Shanghai).Format(time.RFC3339),
				VotesSnapshot: f.VotesSnapshot,
			})
		} // draft: never leaves the admin surface
	}

	// Backlog: votes desc, tie → newer feature first.
	sort.SliceStable(resp.Backlog, func(i, j int) bool {
		a, b := resp.Backlog[i], resp.Backlog[j]
		if a.Votes != b.Votes {
			return a.Votes > b.Votes
		}
		return a.ID > b.ID
	})
	// Accepted: planned_note asc, empty sinks to the bottom.
	sort.SliceStable(resp.Accepted, func(i, j int) bool {
		a, b := resp.Accepted[i].PlannedNote, resp.Accepted[j].PlannedNote
		if (a == "") != (b == "") {
			return b == ""
		}
		if a != b {
			return a < b
		}
		return resp.Accepted[i].ID < resp.Accepted[j].ID
	})
	// Released: newest launch first (released_at is always set on release).
	sort.SliceStable(resp.Released, func(i, j int) bool {
		return resp.Released[i].ReleasedAt > resp.Released[j].ReleasedAt
	})

	total := 0
	for _, n := range counts {
		total += int(n)
	}
	resp.Summary = roadmapSummaryDTO{
		MyVotes: len(myIDs), TotalVotes: total, ReleasedCount: len(resp.Released),
	}
	c.JSON(http.StatusOK, resp)
}

// vote serves POST /api/roadmap/features/:id/vote — idempotent: a repeat vote
// is a no-op 200; only backlog features are votable (409 not_votable
// otherwise); a missing id is 404.
//
//	@Summary		Vote for a roadmap feature
//	@Description	Records the caller's vote on one backlog feature; repeats are idempotent 200s.
//	@Tags			roadmap
//	@Produce		json
//	@Param			id	path	int	true	"Feature id"
//	@Success		200	{object}	roadmapVoteResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		409	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/roadmap/features/{id}/vote [post]
func (r *roadmapRoutes) vote(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	f, err := r.store.GetRoadmapFeature(c.Request.Context(), id)
	if err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	if f.Status != storage.RoadmapStatusBacklog {
		c.JSON(http.StatusConflict, errorResponse{Error: "not_votable"})
		return
	}
	if err := r.store.AddRoadmapVote(c.Request.Context(), uid, id); err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, roadmapVoteResponse{FeatureID: id, Voted: true})
}

// unvote serves DELETE /api/roadmap/features/:id/vote — idempotent: an absent
// vote is still a 200 (feature existence is not even required).
//
//	@Summary		Withdraw a roadmap vote
//	@Description	Removes the caller's vote on one feature; withdrawing a non-existent vote is an idempotent 200.
//	@Tags			roadmap
//	@Produce		json
//	@Param			id	path	int	true	"Feature id"
//	@Success		200	{object}	roadmapVoteResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/roadmap/features/{id}/vote [delete]
func (r *roadmapRoutes) unvote(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	if err := r.store.RemoveRoadmapVote(c.Request.Context(), uid, id); err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, roadmapVoteResponse{FeatureID: id, Voted: false})
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin handlers
// ─────────────────────────────────────────────────────────────────────────────

// roadmapFeatureCreateRequest is the POST body: title required, everything
// else optional; status defaults to draft. planned_note is deliberately
// absent — it arrives via PATCH when the feature is scheduled.
type roadmapFeatureCreateRequest struct {
	Title       string `json:"title" binding:"required,max=128"`
	Description string `json:"description" binding:"max=1024"`
	Category    string `json:"category" binding:"max=32"`
	Status      string `json:"status" binding:"max=16"`
}

// roadmapFeaturePatchRequest is the PATCH body: every field optional (absent =
// unchanged); status is the one-way transition input (forward only, skipping
// allowed; →released writes released_at + freezes the vote snapshot).
type roadmapFeaturePatchRequest struct {
	Title       *string `json:"title" binding:"omitempty,max=128"`
	Description *string `json:"description" binding:"omitempty,max=1024"`
	Category    *string `json:"category" binding:"omitempty,max=32"`
	PlannedNote *string `json:"planned_note" binding:"omitempty,max=32"`
	Status      *string `json:"status" binding:"omitempty,max=16"`
}

// adminList serves GET /api/admin/roadmap/features?status= — full list
// including drafts, each row carrying its live vote count, no paging.
//
//	@Summary		List roadmap features (admin)
//	@Description	Returns every feature (drafts included) with live vote counts, optionally filtered by status.
//	@Tags			roadmap-admin
//	@Produce		json
//	@Param			status	query	string	false	"Status filter (draft|backlog|accepted|released)"
//	@Success		200		{object}	roadmapAdminListResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/roadmap/features [get]
func (r *roadmapRoutes) adminList(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	status := c.Query("status")
	if status != "" && !storage.IsRoadmapFeatureStatus(status) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_status"})
		return
	}
	feats, err := r.store.ListRoadmapFeatures(c.Request.Context(), status)
	if err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	counts, err := r.store.RoadmapVoteCounts(c.Request.Context())
	if err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	resp := roadmapAdminListResponse{Features: make([]roadmapAdminFeatureDTO, 0, len(feats))}
	for i := range feats {
		resp.Features = append(resp.Features, roadmapAdminFeature(&feats[i], counts))
	}
	c.JSON(http.StatusOK, resp)
}

// adminCreate serves POST /api/admin/roadmap/features — defaults to draft.
// Creating straight into released applies the same server-side side effects
// as the PATCH transition (released_at=now, snapshot=0 — a fresh feature has
// no votes yet).
//
//	@Summary		Create a roadmap feature (admin)
//	@Description	Creates one feature; status defaults to draft.
//	@Tags			roadmap-admin
//	@Accept			json
//	@Produce		json
//	@Param			body	body	roadmapFeatureCreateRequest	true	"Feature"
//	@Success		201		{object}	roadmapAdminFeatureDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/roadmap/features [post]
func (r *roadmapRoutes) adminCreate(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	var body roadmapFeatureCreateRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	status := body.Status
	if status == "" {
		status = storage.RoadmapStatusDraft
	}
	if !storage.IsRoadmapFeatureStatus(status) {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_status"})
		return
	}
	row := &storage.RoadmapFeature{
		Title: body.Title, Description: body.Description, Category: body.Category,
		Status: status,
	}
	if status == storage.RoadmapStatusReleased {
		now := time.Now().UTC()
		row.ReleasedAt = &now
	}
	if err := r.store.CreateRoadmapFeature(c.Request.Context(), row); err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	c.JSON(http.StatusCreated, roadmapAdminFeature(row, nil))
}

// adminPatch serves PATCH /api/admin/roadmap/features/:id — the single entry
// for generic fields and the status transition. Status only moves forward
// (skipping levels allowed, draft→released included); the released hop is
// server-side decorated with released_at=now and the frozen vote snapshot; a
// backward move is 422 invalid_transition.
//
//	@Summary		Update a roadmap feature (admin)
//	@Description	Applies partial field updates and/or a one-way status transition; →released freezes the vote snapshot.
//	@Tags			roadmap-admin
//	@Accept			json
//	@Produce		json
//	@Param			id		path	int							true	"Feature id"
//	@Param			body	body	roadmapFeaturePatchRequest	true	"Fields"
//	@Success		200		{object}	roadmapAdminFeatureDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/roadmap/features/{id} [patch]
func (r *roadmapRoutes) adminPatch(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	var body roadmapFeaturePatchRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	row, err := r.store.GetRoadmapFeature(c.Request.Context(), id)
	if err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	if body.Title != nil {
		row.Title = *body.Title
	}
	if body.Description != nil {
		row.Description = *body.Description
	}
	if body.Category != nil {
		row.Category = *body.Category
	}
	if body.PlannedNote != nil {
		row.PlannedNote = *body.PlannedNote
	}
	releasing := false
	if body.Status != nil && *body.Status != row.Status {
		if !storage.IsRoadmapFeatureStatus(*body.Status) {
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_status"})
			return
		}
		if !storage.RoadmapCanTransition(row.Status, *body.Status) {
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_transition"})
			return
		}
		releasing = *body.Status == storage.RoadmapStatusReleased
		row.Status = *body.Status
	}
	if err := r.store.UpdateRoadmapFeature(c.Request.Context(), row, releasing); err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	counts, err := r.store.RoadmapVoteCounts(c.Request.Context())
	if err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	c.JSON(http.StatusOK, roadmapAdminFeature(row, counts))
}

// adminDelete serves DELETE /api/admin/roadmap/features/:id — only draft and
// backlog rows are deletable; accepted/released rows are preserved history
// (422 not_deletable).
//
//	@Summary		Delete a roadmap feature (admin)
//	@Description	Deletes a draft or backlog feature (its votes go with it); accepted/released rows are kept.
//	@Tags			roadmap-admin
//	@Param			id	path	int	true	"Feature id"
//	@Success		204	{object}	nil
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		422	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/roadmap/features/{id} [delete]
func (r *roadmapRoutes) adminDelete(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	row, err := r.store.GetRoadmapFeature(c.Request.Context(), id)
	if err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	if row.Status != storage.RoadmapStatusDraft && row.Status != storage.RoadmapStatusBacklog {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "not_deletable"})
		return
	}
	if err := r.store.DeleteRoadmapFeature(c.Request.Context(), id); err != nil {
		writeRoadmapError(c, r.log, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// roadmapAdminFeature renders the admin projection of one row; counts may be
// nil (create response — a fresh row has no votes anyway).
func roadmapAdminFeature(f *storage.RoadmapFeature, counts map[uint64]uint64) roadmapAdminFeatureDTO {
	dto := roadmapAdminFeatureDTO{
		ID: f.ID, Title: f.Title, Description: f.Description, Category: f.Category,
		Status: f.Status, PlannedNote: f.PlannedNote,
		VotesSnapshot: f.VotesSnapshot,
		CreatedAt:     f.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:     f.UpdatedAt.UTC().Format(time.RFC3339),
	}
	if f.ReleasedAt != nil {
		s := f.ReleasedAt.UTC().Format(time.RFC3339)
		dto.ReleasedAt = &s
	}
	if counts != nil {
		dto.Votes = counts[f.ID]
	}
	return dto
}

// writeRoadmapError maps storage sentinels onto the API's status codes.
func writeRoadmapError(c *gin.Context, log *zap.Logger, err error) {
	switch {
	case errors.Is(err, storage.ErrRoadmapFeatureNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "feature_not_found"})
	default:
		log.Error("roadmap: storage error", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "storage_error"})
	}
}
