// Package httplog provides a shared gin request-logging middleware so every HTTP
// surface in this module (cmd/api and the worker's health server) logs one line
// per request in a consistent format.
package httplog

import (
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// Middleware logs one line per request with basic info: method, path, status,
// latency, client IP and response size (plus query and gin errors when present).
// Register it before gin.Recovery so a recovered panic still logs its final 500.
// Level scales with status: 5xx->Error, 4xx->Warn, else Info. Stacktraces are
// suppressed so a development-mode base logger does not dump a stack on every
// 4xx/5xx access line.
func Middleware(log *zap.Logger) gin.HandlerFunc {
	rlog := log.WithOptions(zap.AddStacktrace(zapcore.FatalLevel + 1))
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		query := c.Request.URL.RawQuery

		c.Next()

		size := c.Writer.Size()
		if size < 0 {
			size = 0
		}
		fields := []zap.Field{
			zap.String("method", c.Request.Method),
			zap.String("path", path),
			zap.Int("status", c.Writer.Status()),
			zap.Duration("latency", time.Since(start)),
			zap.String("ip", c.ClientIP()),
			zap.Int("bytes", size),
		}
		if query != "" {
			fields = append(fields, zap.String("query", query))
		}
		if len(c.Errors) > 0 {
			fields = append(fields, zap.String("errors", c.Errors.String()))
		}

		switch status := c.Writer.Status(); {
		case status >= 500:
			rlog.Error("request", fields...)
		case status >= 400:
			rlog.Warn("request", fields...)
		default:
			rlog.Info("request", fields...)
		}
	}
}
