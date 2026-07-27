// Package config loads the worker's configuration from environment variables
// (12-factor). Required secrets fail fast if missing; everything else has a
// sensible default. See docs/adr/0002 for the delivery model (git-ignored .env).
package config

import (
	"fmt"
	"strconv"
	"time"
)

// Config is the fully-resolved worker configuration.
type Config struct {
	// Secrets (required).
	MySQLDSN string
	AMQPURL  string

	// RabbitMQ topology.
	WorkQueue   string
	RetryQueue  string
	PoisonQueue string

	// Retry policy.
	MaxAttempts int
	BaseBackoff time.Duration
	MaxBackoff  time.Duration

	// Runtime.
	Prefetch   int
	HealthAddr string
	LogLevel   string
}

// Getenv reads an environment variable; inject os.Getenv in production, a map in tests.
type Getenv func(string) string

// Load resolves configuration from getenv, applying defaults and validating.
func Load(getenv Getenv) (Config, error) {
	cfg := Config{
		WorkQueue:   def(getenv, "STRIDE_WORKER_WORK_QUEUE", "stride.jobs"),
		RetryQueue:  def(getenv, "STRIDE_WORKER_RETRY_QUEUE", "stride.jobs.retry"),
		PoisonQueue: def(getenv, "STRIDE_WORKER_POISON_QUEUE", "stride.jobs.poison"),
		HealthAddr:  def(getenv, "STRIDE_WORKER_HEALTH_ADDR", ":8081"),
		LogLevel:    def(getenv, "STRIDE_WORKER_LOG_LEVEL", "info"),
	}

	var err error
	if cfg.MySQLDSN, err = required(getenv, "STRIDE_WORKER_MYSQL_DSN"); err != nil {
		return Config{}, err
	}
	if cfg.AMQPURL, err = required(getenv, "STRIDE_WORKER_AMQP_URL"); err != nil {
		return Config{}, err
	}
	if cfg.MaxAttempts, err = intDef(getenv, "STRIDE_WORKER_MAX_ATTEMPTS", 5); err != nil {
		return Config{}, err
	}
	if cfg.MaxAttempts < 1 {
		return Config{}, fmt.Errorf("config: STRIDE_WORKER_MAX_ATTEMPTS must be >= 1, got %d", cfg.MaxAttempts)
	}
	if cfg.BaseBackoff, err = durDef(getenv, "STRIDE_WORKER_BASE_BACKOFF", 5*time.Second); err != nil {
		return Config{}, err
	}
	if cfg.MaxBackoff, err = durDef(getenv, "STRIDE_WORKER_MAX_BACKOFF", 5*time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.Prefetch, err = intDef(getenv, "STRIDE_WORKER_PREFETCH", 1); err != nil {
		return Config{}, err
	}
	if cfg.Prefetch < 1 {
		return Config{}, fmt.Errorf("config: STRIDE_WORKER_PREFETCH must be >= 1, got %d", cfg.Prefetch)
	}
	return cfg, nil
}

func def(getenv Getenv, key, fallback string) string {
	if v := getenv(key); v != "" {
		return v
	}
	return fallback
}

func required(getenv Getenv, key string) (string, error) {
	v := getenv(key)
	if v == "" {
		return "", fmt.Errorf("config: %s is required but not set", key)
	}
	return v, nil
}

func intDef(getenv Getenv, key string, fallback int) (int, error) {
	v := getenv(key)
	if v == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("config: %s must be an integer: %w", key, err)
	}
	return n, nil
}

func durDef(getenv Getenv, key string, fallback time.Duration) (time.Duration, error) {
	v := getenv(key)
	if v == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("config: %s must be a duration (e.g. 5s, 2m): %w", key, err)
	}
	return d, nil
}
