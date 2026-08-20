// Package syncconfig loads the stride-sync tool's configuration via the
// github.com/zhaochy1990/x viper loader: a YAML file supplies non-secret
// defaults and STRIDE_SYNC_* env vars override any key (the MySQL DSN is a
// secret, supplied via env). Validation uses validator/v10. Mirrors the worker's
// internal/config (ADR 0002) but for the sync binary.
package syncconfig

import (
	"os"
	"time"

	"github.com/zhaochy1990/x/logger"
	xviper "github.com/zhaochy1990/x/viper"
)

// EnvPrefix is prepended (with an underscore) to every override env var; "-"/"."
// in a key become "_". So mysql.dsn -> STRIDE_SYNC_MYSQL_DSN,
// sync.request-delay -> STRIDE_SYNC_SYNC_REQUEST_DELAY.
const EnvPrefix = "STRIDE_SYNC"

// DefaultConfigFile is used when neither an explicit path nor CONFIG_PATH is set.
const DefaultConfigFile = "config.sync.yml"

// Config is the fully-resolved sync-tool configuration.
type Config struct {
	Logger logger.LoggerConfig `mapstructure:"logger"`
	MySQL  MySQL               `mapstructure:"mysql"`
	Sync   Sync                `mapstructure:"sync"`
}

// MySQL holds the datastore connection (secret; env-only).
type MySQL struct {
	DSN string `mapstructure:"dsn" validate:"required"`
}

// Sync holds sync-run knobs.
type Sync struct {
	Jobs         int           `mapstructure:"jobs" validate:"min=1"`
	RequestDelay time.Duration `mapstructure:"request-delay" validate:"min=0"`
}

// MustLoad resolves the config path (explicit CONFIG_PATH env, else
// DefaultConfigFile) and loads it, panicking on any error (fail-fast at boot).
func MustLoad() *Config {
	path := os.Getenv("CONFIG_PATH")
	if path == "" {
		path = DefaultConfigFile
	}
	return MustLoadFrom(path)
}

// MustLoadFrom loads configuration from an explicit YAML path (used by tests).
func MustLoadFrom(path string) *Config {
	var cfg Config
	xviper.MustLoadConfig(EnvPrefix, path, &cfg)
	return &cfg
}
