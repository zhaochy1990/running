package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/storage"
)

type ManualStrengthStore interface {
	ManualStrengthByID(ctx context.Context, userID, id string) (*storage.ManualStrengthRecord, error)
	SaveManualStrength(ctx context.Context, userID, id string, write storage.ManualStrengthWrite, now time.Time) (*storage.ManualStrengthRecord, error)
}

type manualStrengthRoutes struct {
	store ManualStrengthStore
	log   *zap.Logger
}

func (m *manualStrengthRoutes) register(rg *gin.RouterGroup) {
	if m.store == nil {
		return
	}
	rg.GET("/api/:user/activities/manual-strength/:recordId", m.detail)
	rg.PUT("/api/:user/activities/manual-strength/:recordId", m.save)
}

type manualStrengthPayload struct {
	MutationID string                         `json:"mutation_id"`
	Revision   int                            `json:"revision"`
	StartedAt  *time.Time                     `json:"started_at"`
	Name       string                         `json:"name"`
	Note       string                         `json:"note"`
	Actions    []storage.ManualStrengthAction `json:"actions"`
}

type manualStrengthDTO struct {
	ID        string                         `json:"id"`
	Source    string                         `json:"source"`
	StartedAt time.Time                      `json:"started_at"`
	EndedAt   time.Time                      `json:"ended_at"`
	Name      string                         `json:"name"`
	Note      string                         `json:"note"`
	Actions   []storage.ManualStrengthAction `json:"actions"`
	Revision  int                            `json:"revision"`
}

func manualStrengthResponse(r *storage.ManualStrengthRecord) manualStrengthDTO {
	return manualStrengthDTO{
		ID: r.ID, Source: storage.ManualStrengthProvider,
		StartedAt: r.StartedAt.UTC(), EndedAt: r.EndedAt.UTC(),
		Name: r.Name, Note: r.Note, Actions: r.Actions, Revision: r.Revision,
	}
}

func manualStrengthIdentity(c *gin.Context) (user, id string, ok bool) {
	user = c.Param("user")
	caller := callerFrom(c)
	if caller.Tier != TierUser || caller.UserID != user {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return "", "", false
	}
	id = c.Param("recordId")
	if !isCanonicalUUID(id) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid record ID"})
		return "", "", false
	}
	return user, id, true
}

func isCanonicalUUID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}

// detail returns the saved athlete-entered sets for the owning user.
//
//	@Summary		Get a manual strength record
//	@Tags			activities
//	@Produce		json
//	@Param			user		path		string	true	"User ID (JWT sub)"
//	@Param			recordId	path		string	true	"Manual strength record UUID"
//	@Success		200			{object}	manualStrengthDTO
//	@Failure		400			{object}	errorResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		404			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/{user}/activities/manual-strength/{recordId} [get]
func (m *manualStrengthRoutes) detail(c *gin.Context) {
	user, id, ok := manualStrengthIdentity(c)
	if !ok {
		return
	}
	record, err := m.store.ManualStrengthByID(c.Request.Context(), user, id)
	if err != nil {
		m.log.Error("read manual strength record failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if record == nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "manual strength record not found"})
		return
	}
	c.JSON(http.StatusOK, manualStrengthResponse(record))
}

// save creates, continues, or edits the owning user's strength record.
//
//	@Summary		Save a manual strength record
//	@Description	Send started_at for a live session and omit it for a historical edit. Retries reuse mutation_id and revision. A concurrent revision returns 409.
//	@Tags			activities
//	@Accept			json
//	@Produce		json
//	@Param			user		path		string					true	"User ID (JWT sub)"
//	@Param			recordId	path		string					true	"Client-generated UUID of the record"
//	@Param			body		body		manualStrengthPayload	true	"Record, base revision and mutation UUID"
//	@Success		200			{object}	manualStrengthDTO
//	@Failure		400			{object}	errorResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		404			{object}	errorResponse
//	@Failure		409			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/{user}/activities/manual-strength/{recordId} [put]
func (m *manualStrengthRoutes) save(c *gin.Context) {
	user, id, ok := manualStrengthIdentity(c)
	if !ok {
		return
	}
	var payload manualStrengthPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid manual strength record"})
		return
	}
	now := time.Now().UTC()
	write, validationError := payload.validate(now)
	if validationError != "" {
		c.JSON(http.StatusBadRequest, errorResponse{Error: validationError})
		return
	}
	record, err := m.store.SaveManualStrength(c.Request.Context(), user, id, write, now)
	switch {
	case errors.Is(err, storage.ErrManualStrengthNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: err.Error()})
	case errors.Is(err, storage.ErrManualStrengthConflict):
		c.JSON(http.StatusConflict, errorResponse{Error: err.Error()})
	case err != nil:
		m.log.Error("save manual strength record failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
	default:
		c.JSON(http.StatusOK, manualStrengthResponse(record))
	}
}

func (p manualStrengthPayload) validate(now time.Time) (storage.ManualStrengthWrite, string) {
	var write storage.ManualStrengthWrite
	if !isCanonicalUUID(p.MutationID) || p.Revision < 0 || (p.Revision == 0 && p.StartedAt == nil) {
		return write, "invalid mutation ID, revision or start time"
	}
	if p.StartedAt != nil {
		if p.StartedAt.UTC().Year() < 1000 || p.StartedAt.After(now.Add(5*time.Minute)) {
			return write, "invalid training start time"
		}
		write.StartedAt = p.StartedAt.UTC()
	}
	if strings.TrimSpace(p.Name) == "" || utf8.RuneCountInString(p.Name) > 120 {
		return write, "training name must be 1–120 characters"
	}
	if utf8.RuneCountInString(p.Note) > 2000 || len(p.Actions) == 0 {
		return write, "a training record needs at least one action and a note of at most 2000 characters"
	}
	for _, action := range p.Actions {
		if strings.TrimSpace(action.Name) == "" || utf8.RuneCountInString(action.Name) > 120 || len(action.Sets) == 0 {
			return write, "each action needs a name of 1–120 characters and at least one set"
		}
		for _, set := range action.Sets {
			switch set.LoadUnit {
			case "kg", "lb", "bodyweight":
			default:
				return write, "invalid load unit"
			}
			if utf8.RuneCountInString(set.Load) > 120 || (set.LoadUnit == "bodyweight" && set.Load != "") {
				return write, "invalid load"
			}
			if set.Quantity <= 0 || set.Quantity > 9007199254740991 || (set.QuantityUnit != "reps" && set.QuantityUnit != "seconds") {
				return write, "set quantity must be a positive integer in reps or seconds"
			}
		}
	}
	write.MutationID = p.MutationID
	write.Revision = p.Revision
	write.Name = p.Name
	write.Note = p.Note
	write.Actions = p.Actions
	return write, ""
}
