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
	Logger        logger.LoggerConfig `mapstructure:"logger"`
	MySQL         MySQL               `mapstructure:"mysql"`
	AMQP          AMQP                `mapstructure:"amqp"`
	Queues        Queues              `mapstructure:"queues"`
	Retry         Retry               `mapstructure:"retry"`
	Runtime       Runtime             `mapstructure:"runtime"`
	RaceDetection RaceDetection       `mapstructure:"race-detection"`
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
	// DataDir is the athlete data root used only for the file-based provider-
	// binding fallback (registry.ProviderName). Empty is fine — the MySQL
	// binding is primary and an absent file resolves to the default provider.
	DataDir string `mapstructure:"data-dir"`
}

// RaceDetection configures the independent activity classifier. The API key is
// required at worker boot and should be supplied through
// STRIDE_WORKER_RACE_DETECTION_API_KEY.
type RaceDetection struct {
	Endpoint       string        `mapstructure:"endpoint" validate:"required,url"`
	APIKey         string        `mapstructure:"api-key" validate:"required"`
	Model          string        `mapstructure:"model" validate:"required"`
	Timeout        time.Duration `mapstructure:"timeout" validate:"required"`
	MaxConcurrency int           `mapstructure:"max-concurrency" validate:"min=1"`
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

// --- cmd/api configuration ---------------------------------------------------
//
// The HTTP API is a separate binary (ADR 0012) with its own required fields, so
// it loads its own struct rather than reusing Config (whose required MySQL/AMQP/
// queue/retry/runtime fields the worker validates). Both binaries read the same
// config.yml and the same STRIDE_WORKER_* env namespace; the worker ignores the
// api: section and the API ignores retry:/runtime:.

// APIConfig is the fully-resolved configuration for the HTTP API server.
type APIConfig struct {
	Logger logger.LoggerConfig `mapstructure:"logger"`
	MySQL  MySQL               `mapstructure:"mysql"`
	AMQP   AMQP                `mapstructure:"amqp"`
	Queues Queues              `mapstructure:"queues"`
	API    API                 `mapstructure:"api"`
}

// API holds the HTTP API server knobs.
type API struct {
	// Addr is the listen address, e.g. ":8080".
	Addr string `mapstructure:"addr" validate:"required"`
	// CORSOrigins is the allow-list of browser origins (direct-browser tier).
	CORSOrigins []string `mapstructure:"cors-origins"`
	// InternalToken authenticates the server-to-server tier (X-Internal-Token).
	// Secret; supply via STRIDE_WORKER_API_INTERNAL_TOKEN, never commit.
	InternalToken string `mapstructure:"internal-token" validate:"required"`
	// SwaggerEnabled gates the /swagger UI + spec (off in prod, ADR 0012).
	SwaggerEnabled bool    `mapstructure:"swagger-enabled"`
	Auth           APIAuth `mapstructure:"auth"`
	// AuthServiceURL is the in-house auth-service origin used to mirror a user's
	// display name (ADR 0013). Empty disables the best-effort write-back.
	AuthServiceURL string `mapstructure:"auth-service-url"`
	// Features are the config-driven flags echoed in GET /api/users/me/profile,
	// mirroring the Python server config (ADR 0013).
	Features APIFeatures `mapstructure:"features"`
}

// APIFeatures are the onboarding/coach feature flags returned in the profile
// response. sync-data-at-onboarding is a global bool; the coach-*-users lists
// are per-user allow-lists (membership = flag true). Mirrors the Python
// stride_server config; kept in sync manually during coexistence (ADR 0013).
type APIFeatures struct {
	SyncDataAtOnboarding      bool     `mapstructure:"sync-data-at-onboarding"`
	CoachAgentWeeklyPlanUsers []string `mapstructure:"coach-agent-weekly-plan-users"`
	CoachChatUsers            []string `mapstructure:"coach-chat-users"`
	CoachChatDebugUsers       []string `mapstructure:"coach-chat-debug-users"`
	CoachChatMaxMessageChars  int      `mapstructure:"coach-chat-max-message-chars"`
}

// APIAuth configures RS256 verification of end-user JWTs (direct-browser tier).
// Issuer/audience/public key MUST match the in-house auth-service that the Azure
// stack uses, since the browser presents that same token (ADR 0012).
type APIAuth struct {
	Issuer        string `mapstructure:"issuer" validate:"required"`
	Audience      string `mapstructure:"audience" validate:"required"`
	PublicKeyPath string `mapstructure:"public-key-path" validate:"required"`
}

// MustLoadAPI loads the API configuration, panicking on any error (fail-fast).
func MustLoadAPI() *APIConfig {
	path := os.Getenv("CONFIG_PATH")
	if path == "" {
		path = DefaultConfigFile
	}
	return MustLoadAPIFrom(path)
}

// MustLoadAPIFrom loads API configuration from an explicit YAML path (tests).
func MustLoadAPIFrom(path string) *APIConfig {
	var cfg APIConfig
	xviper.MustLoadConfig(EnvPrefix, path, &cfg)
	return &cfg
}
