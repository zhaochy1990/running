// feedback.go is the user-feedback surface (devops#552, contract per
// devops#519's resolution): image upload, the user thread endpoints, and the
// administrator queue.
//
//	User:  POST   /api/users/me/feedback-images          (multipart, ≤10MB, image/*)
//	       POST   /api/users/me/feedbacks                (submit)
//	       GET    /api/users/me/feedbacks                (session list, no paging)
//	       GET    /api/users/me/feedbacks/:id            (thread; read-clears unread)
//	       POST   /api/users/me/feedbacks/:id/replies    (follow-up; closed → 409)
//	Admin: GET    /api/admin/feedbacks                   (?type=&status=&adopted=)
//	       GET    /api/admin/feedbacks/:id               (full thread)
//	       POST   /api/admin/feedbacks/:id/replies       (official reply; open→replied)
//	       PATCH  /api/admin/feedbacks/:id               (status=closed, adopted_feature_id)
//
// UGC machine moderation (msgSecCheck / mediaCheckAsync + the wxa push
// callback) was removed by product decision (devops#608); the legacy
// mod_text/mod_images columns stay in MySQL as dead columns.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// feedbackImageMaxBytes is the per-image cap (devops#519: 单张 10MB).
const feedbackImageMaxBytes = 10 << 20

// maxFeedbackUploadBody bounds the multipart envelope around one ≤10MB image.
const maxFeedbackUploadBody = feedbackImageMaxBytes + (1 << 20)

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies. Narrow ports so the api package stays free of GORM and COS.
// ─────────────────────────────────────────────────────────────────────────────

// FeedbackStore is the persistence the feedback surface needs.
type FeedbackStore interface {
	CreateFeedback(ctx context.Context, row *storage.Feedback) error
	ListFeedbacksByUser(ctx context.Context, userID string) ([]storage.Feedback, error)
	GetFeedback(ctx context.Context, userID string, id uint64) (*storage.Feedback, error)
	GetFeedbackByID(ctx context.Context, id uint64) (*storage.Feedback, error)
	FeedbackUnreadCounts(ctx context.Context, userID string) (map[uint64]int64, error)
	LastFeedbackReplies(ctx context.Context, feedbackIDs []uint64) (map[uint64]storage.FeedbackReply, error)
	ListFeedbackReplies(ctx context.Context, feedbackID uint64) ([]storage.FeedbackReply, error)
	CreateFeedbackReply(ctx context.Context, row *storage.FeedbackReply) error
	CreateAdminFeedbackReply(ctx context.Context, row *storage.FeedbackReply) error
	MarkFeedbackRepliesRead(ctx context.Context, feedbackID uint64) error
	PatchFeedbackAdmin(ctx context.Context, id uint64, close bool, adoptedFeatureID *uint64) (*storage.Feedback, error)
	ListFeedbacksAdmin(ctx context.Context, filter storage.FeedbackFilter) ([]storage.FeedbackWithUser, error)
	// UserDisplayName attributes a row to its submitter on the admin surface.
	UserDisplayName(ctx context.Context, userID string) (string, error)
}

// FeedbackImages is the bucket surface the upload endpoint and the URL
// builder need (deletion goes through the erasure flow's COSObjectDeleter).
// Satisfied by *cos.Client.
type FeedbackImages interface {
	Upload(ctx context.Context, key string, r io.Reader, contentType string) error
	PublicURL(key string) string
	Configured() bool
}

// RoadmapFeatureGetter validates adopted_feature_id against the P1 roadmap
// table (devops#552: adopted 依赖 P1 的 roadmap 表与端点校验). Satisfied by
// *storage.Store via the RoadmapStore port.
type RoadmapFeatureGetter interface {
	GetRoadmapFeature(ctx context.Context, id uint64) (*storage.RoadmapFeature, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type feedbackRoutes struct {
	store   FeedbackStore
	images  FeedbackImages
	roadmap RoadmapFeatureGetter
	log     *zap.Logger
}

func newFeedbackRoutes(store FeedbackStore, images FeedbackImages, roadmap RoadmapFeatureGetter, log *zap.Logger) *feedbackRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &feedbackRoutes{store: store, images: images, roadmap: roadmap, log: log}
}

// registerUser mounts the user-tier thread endpoints (default-deny group: the
// admin tier must not ride a user's feedback session).
func (f *feedbackRoutes) registerUser(rg *gin.RouterGroup) {
	if f.store == nil {
		return
	}
	rg.POST("/api/users/me/feedbacks", f.create)
	rg.GET("/api/users/me/feedbacks", f.list)
	rg.GET("/api/users/me/feedbacks/:id", f.detail)
	rg.POST("/api/users/me/feedbacks/:id/replies", f.reply)
}

// registerAdmin mounts the administrator surface on the authenticated parent;
// every handler re-checks TierAdmin (same pattern as the roadmap admin tab).
func (f *feedbackRoutes) registerAdmin(rg *gin.RouterGroup) {
	if f.store == nil {
		return
	}
	rg.GET("/api/admin/feedbacks", f.adminList)
	rg.GET("/api/admin/feedbacks/:id", f.adminDetail)
	rg.POST("/api/admin/feedbacks/:id/replies", f.adminReply)
	rg.PATCH("/api/admin/feedbacks/:id", f.adminPatch)
}

// registerUpload mounts POST /api/users/me/feedback-images on the bare engine:
// the shared authenticated group caps bodies at 1 MiB, far below the 10MB
// image contract, so this route carries its own chain (bigger body cap → auth
// → user-tier guard).
func (f *feedbackRoutes) registerUpload(r *gin.Engine, auth *Authenticator) {
	if f.store == nil {
		return
	}
	r.POST("/api/users/me/feedback-images", limitBody(maxFeedbackUploadBody), auth.middleware(), rejectAdminCaller, f.upload)
}

// ─────────────────────────────────────────────────────────────────────────────
// Image upload
// ─────────────────────────────────────────────────────────────────────────────

// feedbackImageExt maps a sniffed content type to a storage extension; the
// closed vocabulary of image formats we accept (png/jpg/webp/gif/bmp).
func feedbackImageExt(contentType string) (string, bool) {
	switch contentType {
	case "image/png":
		return "png", true
	case "image/jpeg":
		return "jpg", true
	case "image/webp":
		return "webp", true
	case "image/gif":
		return "gif", true
	case "image/bmp":
		return "bmp", true
	}
	return "", false
}

// upload serves POST /api/users/me/feedback-images — single-file multipart
// (`file`), ≤10MB, image/* sniffed, stored at feedback/<userUUID>/<uuid>.<ext>
// in the public bucket (devops#519: uuid key + public read is the accepted
// lightweight privacy model).
//
//	@Summary		Upload one feedback image
//	@Description	Stores a single image (multipart field `file`, ≤10MB, image/*) in COS at feedback/<userUUID>/<uuid>.<ext> and returns its object key.
//	@Tags			feedback
//	@Accept			multipart/form-data
//	@Produce		json
//	@Param			file	formData	file	true	"Image file"
//	@Success		200		{object}	feedbackImageUploadResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		413		{object}	errorResponse
//	@Failure		415		{object}	errorResponse
//	@Failure		503		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/feedback-images [post]
func (f *feedbackRoutes) upload(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	if f.images == nil || !f.images.Configured() {
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "cos_not_configured"})
		return
	}
	file, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_file"})
		return
	}
	if file.Size > feedbackImageMaxBytes {
		c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: "image_too_large"})
		return
	}
	src, err := file.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_file"})
		return
	}
	defer func() { _ = src.Close() }()

	// Sniff the first 512 bytes, then re-splice them in front of the stream so
	// the uploader sees the whole file.
	head := make([]byte, 512)
	n, err := io.ReadFull(src, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_file"})
		return
	}
	contentType := http.DetectContentType(head[:n])
	ext, ok := feedbackImageExt(contentType)
	if !ok {
		c.JSON(http.StatusUnsupportedMediaType, errorResponse{Error: "unsupported_image_type"})
		return
	}
	key := "feedback/" + uid + "/" + uuid.NewString() + "." + ext
	if err := f.images.Upload(c.Request.Context(), key, io.MultiReader(bytes.NewReader(head[:n]), src), contentType); err != nil {
		f.log.Error("feedback: cos upload failed", zapErr(err))
		c.JSON(http.StatusBadGateway, errorResponse{Error: "upload_failed"})
		return
	}
	c.JSON(http.StatusOK, feedbackImageUploadResponse{CosKey: key})
}

// feedbackImageUploadResponse is the POST /api/users/me/feedback-images body.
type feedbackImageUploadResponse struct {
	CosKey string `json:"cos_key"`
}

// ─────────────────────────────────────────────────────────────────────────────
// User handlers
// ─────────────────────────────────────────────────────────────────────────────

// feedbackCreateRequest is the POST /api/users/me/feedbacks body.
type feedbackCreateRequest struct {
	Type          string   `json:"type" binding:"required,max=16"`
	Content       string   `json:"content" binding:"required,max=1000"`
	Images        []string `json:"images" binding:"omitempty,max=9,dive,max=256"`
	ClientVersion string   `json:"client_version" binding:"max=32"`
}

// feedbackReplyRequest is the follow-up reply body (user and admin).
type feedbackReplyRequest struct {
	Content string `json:"content" binding:"required,max=1000"`
}

// feedbackLastReplyDTO is the list preview line: the newest reply or null.
type feedbackLastReplyDTO struct {
	Author    string `json:"author"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

// feedbackItemDTO is one session-list row (devops#519 shape).
type feedbackItemDTO struct {
	ID               uint64                `json:"id"`
	Type             string                `json:"type"`
	Content          string                `json:"content"`
	Images           []string              `json:"images"`
	Status           string                `json:"status"`
	AdoptedFeatureID *uint64               `json:"adopted_feature_id"`
	CreatedAt        string                `json:"created_at"`
	LastReply        *feedbackLastReplyDTO `json:"last_reply"`
	Unread           bool                  `json:"unread"`
}

// feedbackListResponse is the GET /api/users/me/feedbacks body: no paging,
// total_unread feeds the「我的」tab badge.
type feedbackListResponse struct {
	TotalUnread int64             `json:"total_unread"`
	Items       []feedbackItemDTO `json:"items"`
}

// feedbackReplyDTO is one thread turn.
type feedbackReplyDTO struct {
	ID        uint64 `json:"id"`
	Author    string `json:"author"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

// feedbackDetailResponse is the GET /api/users/me/feedbacks/:id body; image
// URLs are built server-side from the public bucket.
type feedbackDetailResponse struct {
	Feedback feedbackDetailDTO  `json:"feedback"`
	Replies  []feedbackReplyDTO `json:"replies"`
}

// feedbackDetailDTO is the owner's view of the feedback row; keys stay
// server-side, the user only sees direct URLs.
type feedbackDetailDTO struct {
	ID               uint64   `json:"id"`
	Type             string   `json:"type"`
	Content          string   `json:"content"`
	ImageURLs        []string `json:"image_urls"`
	Status           string   `json:"status"`
	AdoptedFeatureID *uint64  `json:"adopted_feature_id"`
	CreatedAt        string   `json:"created_at"`
}

// create serves POST /api/users/me/feedbacks — validates the image keys belong
// to the caller, then persists.
//
//	@Summary		Submit a feedback
//	@Description	Creates one feedback (bug|suggestion) with optional image keys (≤9, must be yours).
//	@Tags			feedback
//	@Accept			json
//	@Produce		json
//	@Param			body	body	feedbackCreateRequest	true	"Feedback"
//	@Success		201	{object}	feedbackItemDTO
//	@Failure		400	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		422	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/feedbacks [post]
func (f *feedbackRoutes) create(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var body feedbackCreateRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	if !storage.IsFeedbackType(body.Type) {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_type"})
		return
	}
	prefix := "feedback/" + uid + "/"
	for _, key := range body.Images {
		if !strings.HasPrefix(key, prefix) {
			c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden_image"})
			return
		}
	}

	row := &storage.Feedback{
		UserID: uid, Type: body.Type, Content: body.Content,
		ClientVersion: body.ClientVersion, Status: storage.FeedbackStatusOpen,
	}
	if len(body.Images) > 0 {
		encoded, err := json.Marshal(body.Images)
		if err != nil {
			f.log.Error("feedback: encode images", zapErr(err))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "storage_error"})
			return
		}
		v := string(encoded)
		row.Images = &v
	}
	if err := f.store.CreateFeedback(c.Request.Context(), row); err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	c.JSON(http.StatusCreated, feedbackItemDTO{
		ID: row.ID, Type: row.Type, Content: row.Content,
		Images: imageKeys(row.Images), Status: row.Status,
		AdoptedFeatureID: row.AdoptedFeatureID,
		CreatedAt:        row.CreatedAt.UTC().Format(time.RFC3339),
	})
}

// list serves GET /api/users/me/feedbacks — the unpaginated session list with
// the top-level unread total and each thread's newest reply.
//
//	@Summary		List my feedbacks
//	@Description	Returns the caller's feedback threads newest-first (no paging) with total_unread and last_reply previews.
//	@Tags			feedback
//	@Produce		json
//	@Success		200	{object}	feedbackListResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/feedbacks [get]
func (f *feedbackRoutes) list(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	rows, err := f.store.ListFeedbacksByUser(c.Request.Context(), uid)
	if err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	ids := make([]uint64, len(rows))
	for i := range rows {
		ids[i] = rows[i].ID
	}
	unread, err := f.store.FeedbackUnreadCounts(c.Request.Context(), uid)
	if err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	lasts, err := f.store.LastFeedbackReplies(c.Request.Context(), ids)
	if err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	resp := feedbackListResponse{Items: make([]feedbackItemDTO, 0, len(rows))}
	for i := range rows {
		row := &rows[i]
		item := feedbackItemDTO{
			ID: row.ID, Type: row.Type, Content: row.Content,
			Images:           imageKeys(row.Images),
			Status:           row.Status,
			AdoptedFeatureID: row.AdoptedFeatureID,
			CreatedAt:        row.CreatedAt.UTC().Format(time.RFC3339),
			Unread:           unread[row.ID] > 0,
		}
		if last, ok := lasts[row.ID]; ok {
			item.LastReply = &feedbackLastReplyDTO{
				Author: last.Author, Content: last.Content,
				CreatedAt: last.CreatedAt.UTC().Format(time.RFC3339),
			}
		}
		resp.TotalUnread += unread[row.ID]
		resp.Items = append(resp.Items, item)
	}
	c.JSON(http.StatusOK, resp)
}

// detail serves GET /api/users/me/feedbacks/:id — the full thread; reading it
// batch-clears the admin unread rows (读即清).
//
//	@Summary		Feedback thread detail
//	@Description	Returns the thread with server-built image URLs; clears the unread admin replies as a side effect.
//	@Tags			feedback
//	@Produce		json
//	@Param			id	path	int	true	"Feedback id"
//	@Success		200	{object}	feedbackDetailResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/feedbacks/{id} [get]
func (f *feedbackRoutes) detail(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	row, err := f.store.GetFeedback(c.Request.Context(), uid, id)
	if err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	replies, err := f.store.ListFeedbackReplies(c.Request.Context(), id)
	if err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	if err := f.store.MarkFeedbackRepliesRead(c.Request.Context(), id); err != nil {
		// 读即清 is best-effort: a failed clear must not hide the thread.
		f.log.Error("feedback: clear unread failed", zap.Uint64("feedback_id", id), zapErr(err))
	}
	c.JSON(http.StatusOK, feedbackDetailResponse{
		Feedback: feedbackDetailDTO{
			ID: row.ID, Type: row.Type, Content: row.Content,
			ImageURLs:        f.imageURLs(imageKeys(row.Images)),
			Status:           row.Status,
			AdoptedFeatureID: row.AdoptedFeatureID,
			CreatedAt:        row.CreatedAt.UTC().Format(time.RFC3339),
		},
		Replies: feedbackReplyDTOs(replies),
	})
}

// reply serves POST /api/users/me/feedbacks/:id/replies — a follow-up; closed
// threads refuse (409 feedback_closed).
//
//	@Summary		Follow up on a feedback
//	@Description	Appends a user reply to the thread; closed feedbacks answer 409 feedback_closed.
//	@Tags			feedback
//	@Accept			json
//	@Produce		json
//	@Param			id		path	int						true	"Feedback id"
//	@Param			body	body	feedbackReplyRequest	true	"Reply"
//	@Success		201		{object}	feedbackReplyDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/feedbacks/{id}/replies [post]
func (f *feedbackRoutes) reply(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	row, err := f.store.GetFeedback(c.Request.Context(), uid, id)
	if err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	if row.Status == storage.FeedbackStatusClosed {
		c.JSON(http.StatusConflict, errorResponse{Error: "feedback_closed"})
		return
	}
	var body feedbackReplyRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	reply := &storage.FeedbackReply{
		FeedbackID: id, Author: storage.FeedbackAuthorUser, Content: body.Content,
	}
	if err := f.store.CreateFeedbackReply(c.Request.Context(), reply); err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	c.JSON(http.StatusCreated, feedbackReplyDTO{
		ID: reply.ID, Author: reply.Author, Content: reply.Content,
		CreatedAt: reply.CreatedAt.UTC().Format(time.RFC3339),
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin handlers
// ─────────────────────────────────────────────────────────────────────────────

// feedbackAdminUserDTO identifies the submitter on the admin surface.
type feedbackAdminUserDTO struct {
	Name   string `json:"name"`
	UserID string `json:"user_id"`
}

// feedbackAdminDTO is one row as the admin list/detail renders it: the full
// row plus image URLs.
type feedbackAdminDTO struct {
	ID               uint64               `json:"id"`
	Type             string               `json:"type"`
	Content          string               `json:"content"`
	Images           []string             `json:"images"`
	ImageURLs        []string             `json:"image_urls"`
	ClientVersion    string               `json:"client_version"`
	Status           string               `json:"status"`
	AdoptedFeatureID *uint64              `json:"adopted_feature_id"`
	User             feedbackAdminUserDTO `json:"user"`
	CreatedAt        string               `json:"created_at"`
	UpdatedAt        string               `json:"updated_at"`
}

type feedbackAdminListResponse struct {
	Items []feedbackAdminDTO `json:"items"`
}

type feedbackAdminDetailResponse struct {
	Feedback feedbackAdminDTO   `json:"feedback"`
	Replies  []feedbackReplyDTO `json:"replies"`
}

// adminList serves GET /api/admin/feedbacks with the filters.
//
//	@Summary		List feedbacks (admin)
//	@Description	Newest-first feedback queue with user attribution; filterable by type, status and adopted state.
//	@Tags			feedback-admin
//	@Produce		json
//	@Param			type		query	string	false	"bug|suggestion"
//	@Param			status		query	string	false	"open|replied|closed"
//	@Param			adopted		query	string	false	"true|false"
//	@Success		200			{object}	feedbackAdminListResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		422			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/feedbacks [get]
func (f *feedbackRoutes) adminList(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	filter := storage.FeedbackFilter{
		Type:   c.Query("type"),
		Status: c.Query("status"),
	}
	if filter.Type != "" && !storage.IsFeedbackType(filter.Type) {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_type"})
		return
	}
	if filter.Status != "" && !storage.IsFeedbackStatus(filter.Status) {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_status"})
		return
	}
	switch c.Query("adopted") {
	case "":
	case "true":
		t := true
		filter.Adopted = &t
	case "false":
		fv := false
		filter.Adopted = &fv
	default:
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_adopted"})
		return
	}
	rows, err := f.store.ListFeedbacksAdmin(c.Request.Context(), filter)
	if err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	items := make([]feedbackAdminDTO, 0, len(rows))
	for i := range rows {
		items = append(items, f.feedbackAdminView(&rows[i].Feedback, rows[i].UserName))
	}
	c.JSON(http.StatusOK, feedbackAdminListResponse{Items: items})
}

// adminDetail serves GET /api/admin/feedbacks/:id — the full thread.
//
//	@Summary		Feedback thread (admin)
//	@Description	Returns the full thread with server-built image URLs.
//	@Tags			feedback-admin
//	@Produce		json
//	@Param			id	path	int	true	"Feedback id"
//	@Success		200	{object}	feedbackAdminDetailResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/feedbacks/{id} [get]
func (f *feedbackRoutes) adminDetail(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	row, err := f.store.GetFeedbackByID(c.Request.Context(), id)
	if err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	replies, err := f.store.ListFeedbackReplies(c.Request.Context(), id)
	if err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	name := f.userName(c.Request.Context(), row.UserID)
	c.JSON(http.StatusOK, feedbackAdminDetailResponse{
		Feedback: f.feedbackAdminView(row, name),
		Replies:  feedbackReplyDTOs(replies),
	})
}

// adminReply serves POST /api/admin/feedbacks/:id/replies — the official line
// (never moderated); while the thread is still open it flips to replied in the
// same transaction.
//
//	@Summary		Reply to a feedback (admin)
//	@Description	Posts the official reply (signed STRIDE 团队 at render time); an open thread automatically becomes replied.
//	@Tags			feedback-admin
//	@Accept			json
//	@Produce		json
//	@Param			id		path	int						true	"Feedback id"
//	@Param			body	body	feedbackReplyRequest	true	"Reply"
//	@Success		201		{object}	feedbackReplyDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/feedbacks/{id}/replies [post]
func (f *feedbackRoutes) adminReply(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	if _, err := f.store.GetFeedbackByID(c.Request.Context(), id); err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	var body feedbackReplyRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	reply := &storage.FeedbackReply{
		FeedbackID: id, Author: storage.FeedbackAuthorAdmin, Content: body.Content,
	}
	if err := f.store.CreateAdminFeedbackReply(c.Request.Context(), reply); err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	c.JSON(http.StatusCreated, feedbackReplyDTO{
		ID: reply.ID, Author: reply.Author, Content: reply.Content,
		CreatedAt: reply.CreatedAt.UTC().Format(time.RFC3339),
	})
}

// feedbackAdminPatchRequest tags which fields the PATCH body carried; the raw
// map separates "absent" from an explicit null on adopted_feature_id (a null
// is a clear attempt and must fail the one-way rule, not silently no-op).
type feedbackAdminPatchRequest struct {
	close           bool
	adopted         *uint64
	adoptedPresent  bool
	adoptedClearing bool
}

// adminPatch serves PATCH /api/admin/feedbacks/:id — only status=closed and
// the one-way adopted_feature_id; adopted must reference an existing roadmap
// feature (devops#552: adopted 依赖 P1 端点校验).
//
//	@Summary		Patch a feedback (admin)
//	@Description	Closes the thread (status only accepts closed) and/or adopts it onto a roadmap feature id; adopted_feature_id is one-way and can never be moved or cleared.
//	@Tags			feedback-admin
//	@Accept			json
//	@Produce		json
//	@Param			id		path	int		true	"Feedback id"
//	@Param			body	body	object	true	"{\"status\":\"closed\"} and/or {\"adopted_feature_id\":123}"
//	@Success		200		{object}	feedbackAdminDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/feedbacks/{id} [patch]
func (f *feedbackRoutes) adminPatch(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	// A raw map separates "absent" from an explicit null on
	// adopted_feature_id: null is a clear attempt and must fail the one-way
	// rule rather than silently no-op.
	raw := map[string]json.RawMessage{}
	if err := c.ShouldBindJSON(&raw); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_body"})
		return
	}
	var patch feedbackAdminPatchRequest
	for key := range raw {
		if key != "status" && key != "adopted_feature_id" {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_body"})
			return
		}
	}
	if v, ok := raw["status"]; ok {
		var status string
		if err := json.Unmarshal(v, &status); err != nil || status != storage.FeedbackStatusClosed {
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_status"})
			return
		}
		patch.close = true
	}
	if v, ok := raw["adopted_feature_id"]; ok {
		patch.adoptedPresent = true
		if string(v) == "null" {
			patch.adoptedClearing = true
		} else if err := json.Unmarshal(v, &patch.adopted); err != nil {
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_adopted_feature"})
			return
		}
	}
	if len(raw) == 0 {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_body"})
		return
	}
	if patch.adoptedClearing {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "adopted_immutable"})
		return
	}
	if patch.adopted != nil && f.roadmap != nil {
		if _, err := f.roadmap.GetRoadmapFeature(c.Request.Context(), *patch.adopted); err != nil {
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "adopted_feature_invalid"})
			return
		}
	}
	row, err := f.store.PatchFeedbackAdmin(c.Request.Context(), id, patch.close, patch.adopted)
	if err != nil {
		writeFeedbackError(c, f.log, err)
		return
	}
	c.JSON(http.StatusOK, f.feedbackAdminView(row, f.userName(c.Request.Context(), row.UserID)))
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// imageKeys decodes the images JSON column; a NULL column renders [].
func imageKeys(encoded *string) []string {
	out := []string{}
	if encoded == nil {
		return out
	}
	if err := json.Unmarshal([]byte(*encoded), &out); err != nil {
		return []string{}
	}
	return out
}

// imageURLs builds public direct URLs for the given keys.
func (f *feedbackRoutes) imageURLs(keys []string) []string {
	urls := []string{}
	if f.images == nil {
		return urls
	}
	for _, key := range keys {
		urls = append(urls, f.images.PublicURL(key))
	}
	return urls
}

// feedbackAdminView renders the admin projection of one row.
func (f *feedbackRoutes) feedbackAdminView(row *storage.Feedback, name string) feedbackAdminDTO {
	return feedbackAdminDTO{
		ID: row.ID, Type: row.Type, Content: row.Content,
		Images:           imageKeys(row.Images),
		ImageURLs:        f.imageURLs(imageKeys(row.Images)),
		ClientVersion:    row.ClientVersion,
		Status:           row.Status,
		AdoptedFeatureID: row.AdoptedFeatureID,
		User:             feedbackAdminUserDTO{Name: name, UserID: row.UserID},
		CreatedAt:        row.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:        row.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

// feedbackReplyDTOs projects the thread rows.
func feedbackReplyDTOs(rows []storage.FeedbackReply) []feedbackReplyDTO {
	out := make([]feedbackReplyDTO, 0, len(rows))
	for i := range rows {
		out = append(out, feedbackReplyDTO{
			ID: rows[i].ID, Author: rows[i].Author, Content: rows[i].Content,
			CreatedAt: rows[i].CreatedAt.UTC().Format(time.RFC3339),
		})
	}
	return out
}

// userName resolves a display name for the admin surface; the lookup failing
// renders an empty name, never a failed request.
func (f *feedbackRoutes) userName(ctx context.Context, userID string) string {
	name, err := f.store.UserDisplayName(ctx, userID)
	if err != nil {
		f.log.Error("feedback: resolve display name failed", zap.String("user_id", userID), zapErr(err))
		return ""
	}
	return name
}

// writeFeedbackError maps storage sentinels onto the API's status codes.
func writeFeedbackError(c *gin.Context, log *zap.Logger, err error) {
	switch {
	case errors.Is(err, storage.ErrFeedbackNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "feedback_not_found"})
	case errors.Is(err, storage.ErrFeedbackAdoptedImmutable):
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "adopted_immutable"})
	default:
		log.Error("feedback: storage error", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "storage_error"})
	}
}
