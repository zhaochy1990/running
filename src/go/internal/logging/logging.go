// Package logging bridges the packages to the process-wide zap logger from
// github.com/zhaochy1990/x/logger. Default() returns that global logger, or a
// no-op logger when none has been initialized yet (e.g. in unit tests that
// never call logger.MustGetLogger), so log calls are always nil-safe.
package logging

import (
	"github.com/zhaochy1990/x/logger"
	"go.uber.org/zap"
)

// Default returns the global zap logger, or a no-op logger if unset.
func Default() *zap.Logger {
	if l := logger.L(); l != nil {
		return l
	}
	return zap.NewNop()
}
