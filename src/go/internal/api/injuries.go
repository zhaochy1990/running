package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/zhaochy1990/stride/internal/storage"
)

// InjuryStore is the Go/MySQL persistence port for injury records.
type InjuryStore interface {
	ListInjuries(context.Context, string, string, int) (*storage.InjuryPage, error)
	CreateInjury(context.Context, *storage.InjuryRecord) (*storage.InjuryRecord, error)
	UpdateInjury(context.Context, string, string, string, string, string) (*storage.InjuryRecord, error)
	DeleteInjury(context.Context, string, string) error
}

type injuryInput struct {
	Description        string `json:"description" binding:"required"`
	RecoveryStatus     string `json:"recovery_status" binding:"required,oneof=active recovered"`
	RunningRestriction string `json:"running_restriction" binding:"required,oneof=none easy_only no_running"`
}

type injuryResponse struct {
	ID                 string `json:"id"`
	Description        string `json:"description"`
	RecoveryStatus     string `json:"recovery_status"`
	RunningRestriction string `json:"running_restriction"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
}

type injuriesResponse struct {
	Items      []injuryResponse `json:"items"`
	NextCursor *string          `json:"next_cursor"`
}

func toInjuryResponse(row *storage.InjuryRecord) injuryResponse {
	return injuryResponse{
		ID: row.ID, Description: row.Description, RecoveryStatus: row.RecoveryStatus,
		RunningRestriction: row.RunningRestriction,
		CreatedAt:          row.CreatedAt.UTC().Format(timeFormat), UpdatedAt: row.UpdatedAt.UTC().Format(timeFormat),
	}
}

const timeFormat = "2006-01-02T15:04:05Z07:00"

// listInjuries godoc
//
//	@Summary		List the current user's injury records
//	@Description	Returns active records first, then updated_at descending and id descending. Cursor pagination is opaque and limited to 50 records per page.
//	@Tags			injuries
//	@Produce		json
//	@Param			limit	query	int	false	"Page size (1-50; default 50)"
//	@Param			cursor	query	string	false	"Opaque page cursor"
//	@Success		200	{object}	injuriesResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		422	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/injuries [get]
func (u *userRoutes) listInjuries(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	store := u.injuryStore()
	if store == nil {
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "injuries unavailable"})
		return
	}
	limit := 0
	if raw := c.Query("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{Loc: []string{"query", "limit"}, Msg: "must be an integer"}}})
			return
		}
		limit = parsed
	}
	page, err := store.ListInjuries(c.Request.Context(), uid, c.Query("cursor"), limit)
	if err != nil {
		var cursorErr *storage.InjuryCursorError
		var validationErr *storage.InjuryValidationError
		switch {
		case errors.As(err, &cursorErr):
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid cursor"})
		case errors.As(err, &validationErr):
			c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{Loc: []string{"query", "limit"}, Msg: validationErr.Error()}}})
		default:
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		}
		return
	}
	items := make([]injuryResponse, len(page.Items))
	for i, item := range page.Items {
		items[i] = toInjuryResponse(item)
	}
	var next *string
	if page.NextCursor != "" {
		next = &page.NextCursor
	}
	c.JSON(http.StatusOK, injuriesResponse{Items: items, NextCursor: next})
}

// createInjury godoc
//
//	@Summary		Create an injury record
//	@Tags			injuries
//	@Accept			json
//	@Produce		json
//	@Param			body	body	injuryInput	true	"Injury record"
//	@Success		201	{object}	injuryResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		422	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/injuries [post]
func (u *userRoutes) createInjury(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	store := u.injuryStore()
	if store == nil {
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "injuries unavailable"})
		return
	}
	var in injuryInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: bindingDetail(err)})
		return
	}
	row, err := store.CreateInjury(c.Request.Context(), &storage.InjuryRecord{
		UserID: uid, Description: in.Description, RecoveryStatus: in.RecoveryStatus, RunningRestriction: in.RunningRestriction,
	})
	if err != nil {
		var validationErr *storage.InjuryValidationError
		if errors.As(err, &validationErr) {
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: validationErr.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusCreated, toInjuryResponse(row))
}

// updateInjury godoc
//
//	@Summary		Replace an injury record
//	@Tags			injuries
//	@Accept			json
//	@Produce		json
//	@Param			injuryId	path	string	true	"Injury id"
//	@Param			body	body	injuryInput	true	"Complete replacement"
//	@Success		200	{object}	injuryResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		422	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/injuries/{injuryId} [put]
func (u *userRoutes) updateInjury(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	store := u.injuryStore()
	if store == nil {
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "injuries unavailable"})
		return
	}
	var in injuryInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: bindingDetail(err)})
		return
	}
	row, err := store.UpdateInjury(c.Request.Context(), uid, c.Param("injuryId"), in.Description, in.RecoveryStatus, in.RunningRestriction)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"detail": "Injury not found"})
		return
	}
	if err != nil {
		var validationErr *storage.InjuryValidationError
		if errors.As(err, &validationErr) {
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: validationErr.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, toInjuryResponse(row))
}

// deleteInjury godoc
//
//	@Summary		Delete an injury record
//	@Tags			injuries
//	@Produce		json
//	@Param			injuryId	path	string	true	"Injury id"
//	@Success		204
//	@Failure		401	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/injuries/{injuryId} [delete]
func (u *userRoutes) deleteInjury(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	store := u.injuryStore()
	if store == nil {
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "injuries unavailable"})
		return
	}
	if err := store.DeleteInjury(c.Request.Context(), uid, c.Param("injuryId")); errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"detail": "Injury not found"})
		return
	} else if err != nil {
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.Status(http.StatusNoContent)
}

func (u *userRoutes) injuryStore() InjuryStore {
	return u.injuries
}
