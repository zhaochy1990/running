package api

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// TestCalibrationNetworkProxy is an opt-in loopback-only network-failure tool.
// It never fabricates calibration JSON: healthy traffic is transparently sent
// to the real test API, while a fault makes only zones connect to a closed port.
// Control routes exist only in this gated test process, never api.NewService.
func TestCalibrationNetworkProxy(t *testing.T) {
	output := os.Getenv("STRIDE_990_PROXY_CONTROL_FILE")
	if output == "" {
		t.Skip("explicit local proxy control output required")
	}
	upstream, _ := url.Parse("http://127.0.0.1:19890")
	refused, _ := url.Parse("http://127.0.0.1:1")
	healthy := httputil.NewSingleHostReverseProxy(upstream)
	failed := httputil.NewSingleHostReverseProxy(refused)
	failed.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "local upstream connection refused", http.StatusBadGateway)
	}
	var enabled atomic.Bool
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/_test/zones-failure", func(c *gin.Context) {
		var body struct {
			Enabled bool `json:"enabled"`
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024)
		if err := c.ShouldBindJSON(&body); err != nil {
			c.AbortWithStatus(http.StatusBadRequest)
			return
		}
		enabled.Store(body.Enabled)
		c.JSON(http.StatusOK, gin.H{"enabled": body.Enabled})
	})
	router.NoRoute(func(c *gin.Context) {
		if enabled.Load() && strings.HasSuffix(c.Request.URL.Path, "/stride/zones") {
			failed.ServeHTTP(c.Writer, c.Request)
			return
		}
		healthy.ServeHTTP(c.Writer, c.Request)
	})
	listener, err := net.Listen("tcp", "127.0.0.1:19891")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: router, ReadHeaderTimeout: 5 * time.Second}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	go func() { _ = server.Serve(listener) }()
	payload, _ := json.Marshal(map[string]any{"url": "http://127.0.0.1:19891", "upstream": upstream.String(), "pid": os.Getpid()})
	if err = os.MkdirAll(filepath.Dir(output), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(output, payload, 0600); err != nil {
		t.Fatal(err)
	}
	t.Log("loopback-only transparent network proxy ready; no calibration response substitution")
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	deadline := time.NewTimer(2 * time.Hour)
	defer deadline.Stop()
	for {
		select {
		case <-deadline.C:
			t.Fatal("local proxy completion timed out")
		case <-ticker.C:
			if _, err := os.Stat(output + ".done"); err == nil {
				return
			}
		}
	}
}
