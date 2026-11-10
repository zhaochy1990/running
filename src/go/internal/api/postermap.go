// postermap.go is the share-poster map-layer proxy (devops#943 spike plan B,
// devops#944): the miniprogram composes the track (pace-gradient paths + start
// /end markers, already GCJ-02) and POSTs it here because the Tencent LBS
// static-map key is a secret that must never ship inside the miniprogram
// bundle. The handler validates the spec, adds the key, fetches the PNG from
// the provider, and streams the bytes back.
//
//	POST /api/users/me/poster/map  (default-deny user tier)
//
// While the key is absent (STRIDE_WORKER_TENCENT_LBS_API_KEY unset — the key
// application is in flight) the endpoint stays mounted and answers
// 503 map_proxy_not_configured so the miniprogram can degrade the poster's
// map layer to a placeholder instead of guessing. That is deliberate: a clear
// error beats an unmounted 404 for a client that must render a fallback.
package api

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/tencentlbs"
)

// PosterMapFetcher is the static-map port the poster proxy consumes,
// satisfied by *tencentlbs.Client. Nil (or a client without a key) keeps the
// endpoint answering 503 map_proxy_not_configured.
type PosterMapFetcher interface {
	Configured() bool
	FetchStaticMap(ctx context.Context, req tencentlbs.StaticMapRequest) ([]byte, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type posterMapRoutes struct {
	fetch PosterMapFetcher
	log   *zap.Logger
}

func newPosterMapRoutes(fetch PosterMapFetcher, log *zap.Logger) *posterMapRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &posterMapRoutes{fetch: fetch, log: log}
}

func (p *posterMapRoutes) register(rg *gin.RouterGroup) {
	rg.POST("/api/users/me/poster/map", p.staticMap)
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

// staticMap serves POST /api/users/me/poster/map — the authenticated user
// tier's static-map proxy: validate the composition, forward it with the
// server-held key, stream the provider's PNG back.
//
//	@Summary		Poster static map proxy
//	@Description	Composes a Tencent LBS static map for the share poster: the body carries GCJ-02 track paths (pace-gradient colored, white casing) and start/end markers plus the size/scale; the API adds the server-held key, derives center+zoom from the track bbox, and streams the provider's PNG back. While the Tencent LBS key is unconfigured the endpoint answers 503 map_proxy_not_configured and the miniprogram degrades the map layer to a placeholder.
//	@Tags			activities
//	@Accept			json
//	@Produce		png
//	@Param			body	body	tencentlbs.StaticMapRequest	true	"Static map composition"
//	@Success		200		{string}	binary	"PNG image bytes"
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		502		{object}	errorResponse
//	@Failure		503		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/poster/map [post]
func (p *posterMapRoutes) staticMap(c *gin.Context) {
	if _, ok := requireUser(c); !ok {
		return
	}
	// Key not landed yet (application in flight): the miniprogram needs one
	// stable, unmistakable signal to fall back to the placeholder map layer.
	if p.fetch == nil || !p.fetch.Configured() {
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "map_proxy_not_configured"})
		return
	}
	var body tencentlbs.StaticMapRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_map_request") {
		return
	}
	// Provider-limit validation happens here, not only inside the client, so
	// client mistakes answer 400 (not a 502 that would read as upstream
	// trouble).
	if err := body.Validate(); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_map_request"})
		return
	}
	png, err := p.fetch.FetchStaticMap(c.Request.Context(), body)
	if err != nil {
		p.log.Warn("poster map proxy upstream failed", zapErr(err))
		c.JSON(http.StatusBadGateway, errorResponse{Error: "map_proxy_upstream_error"})
		return
	}
	c.Data(http.StatusOK, "image/png", png)
}
