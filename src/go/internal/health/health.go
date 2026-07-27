// Package health exposes a tiny HTTP liveness/readiness endpoint. The worker has
// no ingress, so a Docker HEALTHCHECK curls /healthz to detect a wedged consumer
// (broker or DB connectivity lost) and restart the container (ADR 0002).
package health

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// Check reports the health of one dependency; nil means healthy.
type Check func(ctx context.Context) error

// Server serves /healthz, running all registered checks.
type Server struct {
	addr   string
	checks map[string]Check
}

// New builds a health Server bound to addr with the given named checks.
func New(addr string, checks map[string]Check) *Server {
	return &Server{addr: addr, checks: checks}
}

// Handler returns the /healthz http.Handler (exposed for testing).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()

		results := make(map[string]string, len(s.checks))
		healthy := true
		for name, check := range s.checks {
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
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": statusText(healthy),
			"checks": results,
		})
	})
	return mux
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
