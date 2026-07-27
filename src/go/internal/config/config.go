// Package config loads the worker's configuration with github.com/zhaochy1990/x
// viper loader: a YAML file supplies non-secret defaults, and STRIDE_WORKER_*
// environment variables override any key (secrets like the MySQL DSN and AMQP
// URL are supplied only via env). Validation uses validator/v10 struct tags.
// See docs/adr/0002.
package config

import (
	"os"
	"time"

	"github.com/zhaochy1990/x/logger"
	xviper "github.com/zhaochy1990/x/viper"
)

// EnvPrefix is prepended (with an underscore) to every override env var, and
// "-"/"." in a key become "_". So queues.work -> STRIDE_WORKER_QUEUES_WORK,
// retry.max-attempts -> STRIDE_WORKER_RETRY_MAX_ATTEMPTS, mysql.dsn ->
// STRIDE_WORKER_MYSQL_DSN.
const EnvPrefix = "STRIDE_WORKER"

// DefaultConfigFile is used when neither an explicit path nor CONFIG_PATH is set.
const DefaultConfigFile = "config.yml"

// Config is the fully-resolved worker configuration.
type Config struct {
	Logger  logger.LoggerConfig `mapstructure:"logger"`
	MySQL   MySQL               `mapstructure:"mysql"`
	AMQP    AMQP                `mapstructure:"amqp"`
	Queues  Queues              `mapstructure:"queues"`
	Retry   Retry               `mapstructure:"retry"`
	Runtime Runtime             `mapstructure:"runtime"`
}

// MySQL holds the datastore connection (secret; env-only).
type MySQL struct {
	DSN string `mapstructure:"dsn" validate:"required"`
}

// AMQP holds the broker connection (secret; env-only).
type AMQP struct {
	URL string `mapstructure:"url" validate:"required"`
}

// Queues names the three RabbitMQ queues.
type Queues struct {
	Work   string `mapstructure:"work" validate:"required"`
	Retry  string `mapstructure:"retry" validate:"required"`
	Poison string `mapstructure:"poison" validate:"required"`
}

// Retry is the bounded-retry + backoff policy.
type Retry struct {
	MaxAttempts int           `mapstructure:"max-attempts" validate:"min=1"`
	BaseBackoff time.Duration `mapstructure:"base-backoff" validate:"required"`
	MaxBackoff  time.Duration `mapstructure:"max-backoff" validate:"required"`
}

// Runtime holds process-level knobs.
type Runtime struct {
	Prefetch   int    `mapstructure:"prefetch" validate:"min=1"`
	HealthAddr string `mapstructure:"health-addr" validate:"required"`
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
