package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// LegalDocumentStore is the compliance-declaration persistence the API needs.
// Every method maps to exactly one endpoint need: the list surfaces deliberately
// fetch metadata only (no Markdown body), and the body is loaded for the single
// version a reader opened.
type LegalDocumentStore interface {
	ListCurrentLegalDocuments(ctx context.Context) ([]storage.LegalDocument, error)
	ListLegalDocumentDrafts(ctx context.Context) ([]storage.LegalDocument, error)
	GetCurrentLegalDocument(ctx context.Context, docType string) (*storage.LegalDocument, error)
	ListLegalDocumentVersions(ctx context.Context, docType string) ([]storage.LegalDocument, error)
	GetLegalDocument(ctx context.Context, id string) (*storage.LegalDocument, error)
	CreateLegalDocumentDraft(ctx context.Context, docType, title, content, createdBy string) (*storage.LegalDocument, error)
	UpdateLegalDocumentDraft(ctx context.Context, id, title, content string) (*storage.LegalDocument, error)
	PublishLegalDocument(ctx context.Context, id string) (*storage.LegalDocument, error)
	DeleteLegalDocumentDraft(ctx context.Context, id string) error
}

// legalDocumentRoutes serves the compliance-declaration surface in two halves:
// a fully public read-only half the app calls before login, and an
// administrator-only half the Admin Dashboard 声明维护 tab drives.
type legalDocumentRoutes struct {
	store LegalDocumentStore
	log   *zap.Logger
}

func newLegalDocumentRoutes(store LegalDocumentStore, log *zap.Logger) *legalDocumentRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &legalDocumentRoutes{store: store, log: log}
}

// registerPublic mounts the unauthenticated reads straight on the engine: the
// declarations must be readable before a user has an account, and their content
// is public by definition. Only published versions are ever reachable here —
// drafts are served exclusively by the admin routes below.
func (l *legalDocumentRoutes) registerPublic(r *gin.Engine) {
	if l.store == nil {
		return
	}
	r.GET("/api/declarations", l.listPublished)
	r.GET("/api/declarations/:doc_type", l.getPublished)
}

// registerAdmin mounts the administrator surface on the parent authenticated
// group (not the default-deny child group) because the admin JWT tier has to
// reach it; each handler re-checks TierAdmin so user and internal callers cannot
// publish a declaration.
func (l *legalDocumentRoutes) registerAdmin(rg *gin.RouterGroup) {
	if l.store == nil {
		return
	}
	rg.GET("/api/admin/declarations", l.adminList)
	rg.GET("/api/admin/declarations/:doc_type/versions", l.adminVersions)
	rg.GET("/api/admin/declarations/versions/:id", l.adminDetail)
	rg.POST("/api/admin/declarations/:doc_type/draft", l.adminCreateDraft)
	rg.PATCH("/api/admin/declarations/versions/:id", l.adminUpdateDraft)
	rg.POST("/api/admin/declarations/versions/:id/publish", l.adminPublish)
	rg.DELETE("/api/admin/declarations/versions/:id", l.adminDeleteDraft)
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

// legalDocumentMeta is one version without its Markdown body.
type legalDocumentMeta struct {
	ID          string     `json:"id"`
	DocType     string     `json:"doc_type"`
	Version     int        `json:"version"`
	Title       string     `json:"title"`
	Status      string     `json:"status"`
	EffectiveAt *time.Time `json:"effective_at,omitempty"`
	PublishedAt *time.Time `json:"published_at,omitempty"`
	CreatedBy   string     `json:"created_by"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

func newLegalDocumentMeta(row storage.LegalDocument) legalDocumentMeta {
	return legalDocumentMeta{
		ID: row.ID, DocType: row.DocType, Version: row.Version, Title: row.Title,
		Status: row.Status, EffectiveAt: row.EffectiveAt, PublishedAt: row.PublishedAt,
		CreatedBy: row.CreatedBy, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}

func newLegalDocumentMetas(rows []storage.LegalDocument) []legalDocumentMeta {
	metas := make([]legalDocumentMeta, 0, len(rows))
	for _, row := range rows {
		metas = append(metas, newLegalDocumentMeta(row))
	}
	return metas
}

// legalDocumentBody is one version including its Markdown source.
type legalDocumentBody struct {
	legalDocumentMeta
	ContentMarkdown string `json:"content_markdown"`
}

func newLegalDocumentBody(row storage.LegalDocument) legalDocumentBody {
	return legalDocumentBody{
		legalDocumentMeta: newLegalDocumentMeta(row),
		ContentMarkdown:   row.ContentMarkdown,
	}
}

// publicDeclarationMeta is the public projection of a version: only the fields
// the public contract exposes (title / version / effective_at / updated_at).
// It is deliberately narrower than legalDocumentMeta rather than a shared struct
// with omitempty tags, so the admin-only columns — the row id, the created_by
// administrator identity, created_at — cannot reach an unauthenticated caller
// even if the admin DTO later grows.
type publicDeclarationMeta struct {
	Version     int        `json:"version"`
	Title       string     `json:"title"`
	EffectiveAt *time.Time `json:"effective_at,omitempty"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

func newPublicDeclarationMeta(row storage.LegalDocument) publicDeclarationMeta {
	return publicDeclarationMeta{
		Version:     row.Version,
		Title:       row.Title,
		EffectiveAt: row.EffectiveAt,
		UpdatedAt:   row.UpdatedAt,
	}
}

// publicDeclarationBody is the full body served to the app before login.
type publicDeclarationBody struct {
	DocType string `json:"doc_type"`
	publicDeclarationMeta
	ContentMarkdown string `json:"content_markdown"`
}

// publicDeclarationEntry is one of the five declaration types on the public
// list. Current is nil when the type has never been published, so the client can
// tell "not yet live" apart from "no such declaration".
type publicDeclarationEntry struct {
	DocType string                 `json:"doc_type"`
	Current *publicDeclarationMeta `json:"current"`
}

// adminDeclarationEntry adds the in-progress draft, if any, to the public shape.
type adminDeclarationEntry struct {
	DocType string             `json:"doc_type"`
	Current *legalDocumentMeta `json:"current"`
	Draft   *legalDocumentMeta `json:"draft"`
}

type publicDeclarationsResponse struct {
	Declarations []publicDeclarationEntry `json:"declarations"`
}

type adminDeclarationsResponse struct {
	Declarations []adminDeclarationEntry `json:"declarations"`
}

type legalDocumentVersionsResponse struct {
	DocType  string              `json:"doc_type"`
	Versions []legalDocumentMeta `json:"versions"`
}

// legalDocumentDraftRequest is the body of the draft create/edit endpoints. The
// title is capped at the column width (varchar(255)) so an over-long title is a
// 400 here rather than a MySQL 1406 that would surface as a 500. The body needs
// no cap of its own: the authenticated group already caps request bodies at
// maxRequestBytes, and that case is mapped to 413 by bindDraftRequest.
type legalDocumentDraftRequest struct {
	Title           string `json:"title" binding:"required,max=255"`
	ContentMarkdown string `json:"content_markdown" binding:"required"`
}

// bindDraftRequest decodes a draft body, distinguishing "payload too large" (413,
// the limitBody cap) from "malformed or invalid" (400). Reports whether the
// handler may proceed; it writes the error response itself when it may not.
func bindDraftRequest(c *gin.Context) (legalDocumentDraftRequest, bool) {
	var req legalDocumentDraftRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		if isBodyTooLarge(err) {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: "declaration_too_large"})
			return req, false
		}
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_declaration"})
		return req, false
	}
	return req, true
}

// ─── Public handlers ─────────────────────────────────────────────────────────

// listPublished returns the live version metadata of all five declaration types.
// Types with no published version come back with current=null rather than being
// omitted, so the app always sees the full set.
//
//	@Summary		List the currently effective declarations
//	@Description	Returns metadata (not the body) of the currently effective version of each declaration type. Public: no authentication. Drafts are never exposed.
//	@Tags			declarations
//	@Success		200	{object}	publicDeclarationsResponse
//	@Router			/api/declarations [get]
func (l *legalDocumentRoutes) listPublished(c *gin.Context) {
	rows, err := l.store.ListCurrentLegalDocuments(c.Request.Context())
	if err != nil {
		writeLegalDocumentError(c, l.log, err)
		return
	}
	current := make(map[string]storage.LegalDocument, len(rows))
	for _, row := range rows {
		current[row.DocType] = row
	}
	entries := make([]publicDeclarationEntry, 0, len(storage.LegalDocumentTypes))
	for _, docType := range storage.LegalDocumentTypes {
		entry := publicDeclarationEntry{DocType: docType}
		if row, ok := current[docType]; ok {
			meta := newPublicDeclarationMeta(row)
			entry.Current = &meta
		}
		entries = append(entries, entry)
	}
	c.JSON(http.StatusOK, publicDeclarationsResponse{Declarations: entries})
}

// getPublished returns the full Markdown of a type's currently effective
// version. A declaration that exists but is not published yet reads as 404 —
// the same answer as one that does not exist, which is what keeps a draft from
// leaking through its own 404-vs-200 shape.
//
//	@Summary		Get the currently effective declaration body
//	@Description	Returns the Markdown body and metadata of the currently effective version. Public: no authentication. Returns 404 when the type has no published version, 400 for an unknown doc_type.
//	@Tags			declarations
//	@Param			doc_type	path	string	true	"Declaration type (user_agreement, privacy_policy, child_protection, personal_info_collection, third_party_sharing)"
//	@Success		200			{object}	publicDeclarationBody
//	@Failure		400			{object}	errorResponse
//	@Failure		404			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Router			/api/declarations/{doc_type} [get]
func (l *legalDocumentRoutes) getPublished(c *gin.Context) {
	docType := c.Param("doc_type")
	if !storage.IsLegalDocumentType(docType) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_doc_type"})
		return
	}
	row, err := l.store.GetCurrentLegalDocument(c.Request.Context(), docType)
	if err != nil {
		writeLegalDocumentError(c, l.log, err)
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "declaration_not_found"})
		return
	}
	c.JSON(http.StatusOK, publicDeclarationBody{
		DocType:               row.DocType,
		publicDeclarationMeta: newPublicDeclarationMeta(*row),
		ContentMarkdown:       row.ContentMarkdown,
	})
}

// ─── Admin handlers ──────────────────────────────────────────────────────────

// adminList returns all five declaration types with their live version and, when
// one exists, the draft in progress. The list is driven by the canonical type
// list, so a deployment whose table is still empty shows all five rows ready to
// fill in.
//
//	@Summary		List declaration types with current version and draft
//	@Description	Administrator only. Returns all five declaration types; current/draft are null when absent.
//	@Tags			admin
//	@Success		200	{object}	adminDeclarationsResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/declarations [get]
func (l *legalDocumentRoutes) adminList(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	ctx := c.Request.Context()
	current, err := l.store.ListCurrentLegalDocuments(ctx)
	if err != nil {
		writeLegalDocumentError(c, l.log, err)
		return
	}
	drafts, err := l.store.ListLegalDocumentDrafts(ctx)
	if err != nil {
		writeLegalDocumentError(c, l.log, err)
		return
	}
	currentByType := make(map[string]storage.LegalDocument, len(current))
	for _, row := range current {
		currentByType[row.DocType] = row
	}
	draftByType := make(map[string]storage.LegalDocument, len(drafts))
	for _, row := range drafts {
		draftByType[row.DocType] = row
	}
	entries := make([]adminDeclarationEntry, 0, len(storage.LegalDocumentTypes))
	for _, docType := range storage.LegalDocumentTypes {
		entry := adminDeclarationEntry{DocType: docType}
		if row, ok := currentByType[docType]; ok {
			meta := newLegalDocumentMeta(row)
			entry.Current = &meta
		}
		if row, ok := draftByType[docType]; ok {
			meta := newLegalDocumentMeta(row)
			entry.Draft = &meta
		}
		entries = append(entries, entry)
	}
	c.JSON(http.StatusOK, adminDeclarationsResponse{Declarations: entries})
}

// adminVersions returns a type's full version history, newest first.
//
//	@Summary		List the version history of a declaration type
//	@Description	Administrator only. Returns every version (draft and published) of the type, newest first, without bodies.
//	@Tags			admin
//	@Param			doc_type	path	string	true	"Declaration type"
//	@Success		200			{object}	legalDocumentVersionsResponse
//	@Failure		400			{object}	errorResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/declarations/{doc_type}/versions [get]
func (l *legalDocumentRoutes) adminVersions(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	docType := c.Param("doc_type")
	if !storage.IsLegalDocumentType(docType) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_doc_type"})
		return
	}
	rows, err := l.store.ListLegalDocumentVersions(c.Request.Context(), docType)
	if err != nil {
		writeLegalDocumentError(c, l.log, err)
		return
	}
	c.JSON(http.StatusOK, legalDocumentVersionsResponse{DocType: docType, Versions: newLegalDocumentMetas(rows)})
}

// adminDetail returns one version including its Markdown body, for any status.
//
//	@Summary		Get one declaration version with its body
//	@Description	Administrator only. Returns a single version (draft or published) including the Markdown source.
//	@Tags			admin
//	@Param			id	path	string	true	"Version UUID"
//	@Success		200	{object}	legalDocumentBody
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/declarations/versions/{id} [get]
func (l *legalDocumentRoutes) adminDetail(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	row, err := l.store.GetLegalDocument(c.Request.Context(), c.Param("id"))
	if err != nil {
		writeLegalDocumentError(c, l.log, err)
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "declaration_not_found"})
		return
	}
	c.JSON(http.StatusOK, newLegalDocumentBody(*row))
}

// adminCreateDraft appends the next version of the type as a draft. A second
// draft for the same type is a 409: the version list must never be ambiguous
// about which one is about to be published.
//
//	@Summary		Create a new declaration draft
//	@Description	Administrator only. Allocates the next version number for the type and stores it as a draft. Returns 409 when the type already has a draft.
//	@Tags			admin
//	@Param			doc_type	path		string						true	"Declaration type"
//	@Param			body		body		legalDocumentDraftRequest	true	"Draft title and Markdown body"
//	@Success		201			{object}	legalDocumentBody
//	@Failure		400			{object}	errorResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		409			{object}	errorResponse
//	@Failure		413			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/declarations/{doc_type}/draft [post]
func (l *legalDocumentRoutes) adminCreateDraft(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	docType := c.Param("doc_type")
	if !storage.IsLegalDocumentType(docType) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_doc_type"})
		return
	}
	req, ok := bindDraftRequest(c)
	if !ok {
		return
	}
	createdBy := callerFrom(c).UserID
	row, err := l.store.CreateLegalDocumentDraft(c.Request.Context(), docType, req.Title, req.ContentMarkdown, createdBy)
	if err != nil {
		writeLegalDocumentError(c, l.log, err)
		return
	}
	c.JSON(http.StatusCreated, newLegalDocumentBody(*row))
}

// adminUpdateDraft rewrites a draft in place. Published versions reject the
// write with 409 — the compliance record stays byte-identical to what users saw.
//
//	@Summary		Edit a declaration draft
//	@Description	Administrator only. Replaces the title and Markdown body of an unpublished draft. Returns 409 for a published version.
//	@Tags			admin
//	@Param			id		path		string						true	"Version UUID"
//	@Param			body	body		legalDocumentDraftRequest	true	"New title and Markdown body"
//	@Success		200		{object}	legalDocumentBody
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		413		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/declarations/versions/{id} [patch]
func (l *legalDocumentRoutes) adminUpdateDraft(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	req, ok := bindDraftRequest(c)
	if !ok {
		return
	}
	row, err := l.store.UpdateLegalDocumentDraft(c.Request.Context(), c.Param("id"), req.Title, req.ContentMarkdown)
	if err != nil {
		writeLegalDocumentError(c, l.log, err)
		return
	}
	c.JSON(http.StatusOK, newLegalDocumentBody(*row))
}

// adminPublish makes a draft live immediately. There is no future-dated
// effective_at: publishing stamps effective_at with the publish instant.
//
//	@Summary		Publish a declaration draft
//	@Description	Administrator only. Publishes the draft immediately: it becomes the currently effective version and effective_at/published_at are stamped with the publish time. Irreversible; subsequent edits require a new draft. Returns 409 when the version is already published.
//	@Tags			admin
//	@Param			id	path		string	true	"Version UUID"
//	@Success		200	{object}	legalDocumentBody
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		409	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/declarations/versions/{id}/publish [post]
func (l *legalDocumentRoutes) adminPublish(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	row, err := l.store.PublishLegalDocument(c.Request.Context(), c.Param("id"))
	if err != nil {
		writeLegalDocumentError(c, l.log, err)
		return
	}
	c.JSON(http.StatusOK, newLegalDocumentBody(*row))
}

// adminDeleteDraft discards an unpublished draft. Published versions are never
// deletable.
//
//	@Summary		Delete a declaration draft
//	@Description	Administrator only. Deletes an unpublished draft. Returns 409 for a published version, which is permanently retained.
//	@Tags			admin
//	@Param			id	path	string	true	"Version UUID"
//	@Success		204
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		409	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/declarations/versions/{id} [delete]
func (l *legalDocumentRoutes) adminDeleteDraft(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	if err := l.store.DeleteLegalDocumentDraft(c.Request.Context(), c.Param("id")); err != nil {
		writeLegalDocumentError(c, l.log, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// requireAdmin writes the 403 and reports whether the caller may proceed. These
// routes are mounted on the authenticated group so the admin tier can reach
// them; this guard is what keeps user and internal callers out.
func requireAdmin(c *gin.Context) bool {
	if callerFrom(c).Tier == TierAdmin {
		return true
	}
	c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
	return false
}

// writeLegalDocumentError maps storage sentinels onto the API's status codes.
func writeLegalDocumentError(c *gin.Context, log *zap.Logger, err error) {
	switch {
	case errors.Is(err, storage.ErrLegalDocumentNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "declaration_not_found"})
	case errors.Is(err, storage.ErrLegalDraftExists):
		c.JSON(http.StatusConflict, errorResponse{Error: "declaration_draft_exists"})
	case errors.Is(err, storage.ErrLegalDocumentImmutable):
		c.JSON(http.StatusConflict, errorResponse{Error: "declaration_published"})
	case errors.Is(err, storage.ErrLegalDocumentConflict):
		c.JSON(http.StatusConflict, errorResponse{Error: "declaration_conflict"})
	case errors.Is(err, storage.ErrInvalidLegalDocument):
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_declaration"})
	default:
		log.Error("legal document request failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
	}
}
