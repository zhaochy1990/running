// Package health exposes a tiny HTTP liveness/readiness endpoint. The worker has
// no ingress, so a Docker HEALTHCHECK curls /health to detect a wedged consumer
// (broker or DB connectivity lost) and restart the container (ADR 0002). It is
// built on gin like every other HTTP surface in this module (no exception).
package health

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// Check reports the health of one dependency; nil means healthy.
type Check func(ctx context.Context) error

// Server serves /health, running all registered checks.
type Server struct {
	addr   string
	checks map[string]Check
}

// New builds a health Server bound to addr with the given named checks.
func New(addr string, checks map[string]Check) *Server {
	return &Server{addr: addr, checks: checks}
}

// Endpoint returns a gin handler that runs all checks and reports 200 (all ok)
// or 503 (any failing). Exposed so another gin server (e.g. cmd/api) can mount
// the same liveness logic on its own engine.
func Endpoint(checks map[string]Check) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
		defer cancel()

		results := make(map[string]string, len(checks))
		healthy := true
		for name, check := range checks {
			if err := check(ctx); err != nil {
				results[name] = err.Error()
				healthy = false
			} else {
				results[name] = "ok"
			}
		}

		status := http.StatusOK
		if !healthy {
			status = http.StatusServiceUnavailable
		}
		c.JSON(status, gin.H{"status": statusText(healthy), "checks": results})
	}
}

// Handler returns the /health http.Handler (a gin engine; exposed for testing).
func (s *Server) Handler() http.Handler {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.GET("/health", Endpoint(s.checks))
	return r
}

func statusText(healthy bool) string {
	if healthy {
		return "ok"
	}
	return "unhealthy"
}

// Run serves until ctx is cancelled, then shuts down gracefully.
func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{Addr: s.addr, Handler: s.Handler()}
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()

	select {
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutCtx)
	case err := <-errCh:
		return err
	}
}
