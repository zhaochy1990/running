// onboarding_sync.go is the first-sync session endpoint set (devops#1006,
// epic devops#1004 T02): POST /api/users/me/onboarding/sync atomically creates
// or claims the caller's session for their current watch binding, and GET
// /api/users/me/onboarding/sync serves the strictly read-only readiness view.
//
// Gating follows the epic's rollout contract: the sync-data-at-onboarding
// master switch AND the new onboarding-sync-session rollout switch must both
// be on (turning the master off keeps the original disable semantics), the
// caller must be a user-tier JWT ("me" only — a client can never name another
// user, window, or concurrency), and the user must have a bound provider.
// Window sizes and stage dispatch are server decisions; the only client input
// is the optional retry flag.
package api

import (
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/onboardingsync"
	"github.com/zhaochy1990/stride/internal/storage"
)

// OnboardingSyncService is the session orchestration the handlers call.
// Satisfied by *onboardingsync.Service.
type OnboardingSyncService interface {
	CreateOrClaim(ctx context.Context, userID, provider string) (*storage.OnboardingSyncSession, error)
	Retry(ctx context.Context, userID string) (*storage.OnboardingSyncSession, error)
	View(ctx context.Context, userID string) (*onboardingsync.View, error)
}

// onboardingSyncRoutes mounts the two endpoints. It reuses the user-tier auth
// group (rejectAdminCaller) — internal/admin tiers have no "me".
type onboardingSyncRoutes struct {
	svc      OnboardingSyncService
	provider ProviderResolver
	features FeatureConfig
	log      *zap.Logger
}

// ProviderResolver resolves the caller's bound watch provider (the capability
// gate). Satisfied by UserStore (ProviderForUser).
type ProviderResolver interface {
	ProviderForUser(ctx context.Context, userID string) (string, bool, error)
}

func newOnboardingSyncRoutes(svc OnboardingSyncService, provider ProviderResolver, features FeatureConfig, log *zap.Logger) *onboardingSyncRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &onboardingSyncRoutes{svc: svc, provider: provider, features: features, log: log}
}

func (o *onboardingSyncRoutes) register(rg *gin.RouterGroup) {
	rg.POST("/api/users/me/onboarding/sync", o.postSync)
	rg.GET("/api/users/me/onboarding/sync", o.getSync)
}

// gate enforces the shared switch contract. Reports false after writing the
// error response.
func (o *onboardingSyncRoutes) gate(c *gin.Context) bool {
	if o.svc == nil {
		// Wired off entirely (no session service in this deployment).
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "onboarding_sync_unavailable"})
		return false
	}
	if !o.features.SyncDataAtOnboarding {
		// Master switch off: the original disable semantics (the entry point
		// does not exist for the client).
		c.JSON(http.StatusForbidden, errorResponse{Error: "sync_disabled"})
		return false
	}
	if !o.features.OnboardingSyncSession {
		c.JSON(http.StatusForbidden, errorResponse{Error: "onboarding_sync_not_enabled"})
		return false
	}
	return true
}

// onboardingSyncPostInput is the only client input: an explicit retry of the
// same session's unfinished work. No user, window, or concurrency fields —
// those are server-owned.
type onboardingSyncPostInput struct {
	Retry bool `json:"retry"`
}

// postSync godoc
//
//	@Summary		Create or claim the current user's first-sync session
//	@Description	Atomically creates (or, for a repeat request on the same watch binding, claims) the caller's first-sync session and durably records its stage dispatch intent. Returns shell_ready=true ONLY when the session and its reliable dispatch records are persisted. Concurrent clients on the same binding always resolve to the same session; a rebind supersedes the old session. An in-flight legacy full sync is adopted (waited on and reconciled), never duplicated. body {"retry":true} re-dispatches only unfinished work of the existing session — successfully fetched ranges are reused, never re-pulled. Requires the sync master switch and the onboarding-sync-session rollout switch.
//	@Tags			onboarding
//	@Accept			json
//	@Produce		json
//	@Param			body	body		onboardingSyncPostInput	false	"Optional retry flag"
//	@Success		200		{object}	onboardingsync.View
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/onboarding/sync [post]
func (o *onboardingSyncRoutes) postSync(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	if !o.gate(c) {
		return
	}
	var in onboardingSyncPostInput
	if err := c.ShouldBindJSON(&in); err != nil && !errors.Is(err, io.EOF) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}
	ctx := c.Request.Context()

	provider, found, err := o.provider.ProviderForUser(ctx, uid)
	if err != nil {
		o.log.Error("onboarding sync provider lookup failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if !found || provider == "" {
		// Capability gate: no bound watch → the session entry is not usable.
		// Profile-only onboarding completion stays on its own path.
		c.JSON(http.StatusConflict, errorResponse{Error: "no_watch_provider"})
		return
	}

	if in.Retry {
		_, err = o.svc.Retry(ctx, uid)
		if errors.Is(err, onboardingsync.ErrNoSession) {
			// Retry with no session yet is just a create.
			_, err = o.svc.CreateOrClaim(ctx, uid, provider)
		}
	} else {
		_, err = o.svc.CreateOrClaim(ctx, uid, provider)
	}
	if err != nil {
		o.log.Error("onboarding sync create/claim failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	view, err := o.svc.View(ctx, uid)
	if err != nil {
		o.log.Error("onboarding sync view failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, view)
}

// getSync godoc
//
//	@Summary		Get the current user's first-sync session status (read-only)
//	@Description	Serves the caller's session view: state, shell_ready, per-stage target/scanned/observed ranges with gaps, and the derived readiness flags (recent_data etc. are derived from reported coverage, never asserted). Strictly read-only: no sync, no recomputation, no self-healing writes. 404 before the first POST.
//	@Tags			onboarding
//	@Produce		json
//	@Success		200	{object}	onboardingsync.View
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/onboarding/sync [get]
func (o *onboardingSyncRoutes) getSync(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	if !o.gate(c) {
		return
	}
	view, err := o.svc.View(c.Request.Context(), uid)
	if errors.Is(err, onboardingsync.ErrNoSession) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "no_session"})
		return
	}
	if err != nil {
		o.log.Error("onboarding sync view failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, view)
}
