package config

import (
	"testing"
	"time"
)

func mapEnv(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func requiredEnv() map[string]string {
	return map[string]string{
		"STRIDE_WORKER_MYSQL_DSN": "user:pass@tcp(mysql:3306)/stride",
		"STRIDE_WORKER_AMQP_URL":  "amqp://guest:guest@rabbit:5672/",
	}
}

func TestLoad_DefaultsAppliedWhenOnlyRequiredSet(t *testing.T) {
	cfg, err := Load(mapEnv(requiredEnv()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.WorkQueue != "stride.jobs" {
		t.Errorf("work queue default = %q", cfg.WorkQueue)
	}
	if cfg.RetryQueue != "stride.jobs.retry" {
		t.Errorf("retry queue default = %q", cfg.RetryQueue)
	}
	if cfg.PoisonQueue != "stride.jobs.poison" {
		t.Errorf("poison queue default = %q", cfg.PoisonQueue)
	}
	if cfg.MaxAttempts != 5 {
		t.Errorf("max attempts default = %d", cfg.MaxAttempts)
	}
	if cfg.BaseBackoff != 5*time.Second {
		t.Errorf("base backoff default = %v", cfg.BaseBackoff)
	}
	if cfg.MaxBackoff != 5*time.Minute {
		t.Errorf("max backoff default = %v", cfg.MaxBackoff)
	}
	if cfg.Prefetch != 1 {
		t.Errorf("prefetch default = %d", cfg.Prefetch)
	}
	if cfg.HealthAddr != ":8081" {
		t.Errorf("health addr default = %q", cfg.HealthAddr)
	}
	if cfg.LogLevel != "info" {
		t.Errorf("log level default = %q", cfg.LogLevel)
	}
}

func TestLoad_MissingRequiredFailsFast(t *testing.T) {
	for _, key := range []string{"STRIDE_WORKER_MYSQL_DSN", "STRIDE_WORKER_AMQP_URL"} {
		env := requiredEnv()
		delete(env, key)
		_, err := Load(mapEnv(env))
		if err == nil {
			t.Fatalf("missing %s: want error", key)
		}
		if !contains(err.Error(), key) {
			t.Fatalf("error should name %s, got %q", key, err.Error())
		}
	}
}

func TestLoad_OverridesFromEnv(t *testing.T) {
	env := requiredEnv()
	env["STRIDE_WORKER_WORK_QUEUE"] = "q.work"
	env["STRIDE_WORKER_MAX_ATTEMPTS"] = "3"
	env["STRIDE_WORKER_BASE_BACKOFF"] = "2s"
	env["STRIDE_WORKER_MAX_BACKOFF"] = "30s"
	env["STRIDE_WORKER_PREFETCH"] = "8"
	env["STRIDE_WORKER_LOG_LEVEL"] = "debug"

	cfg, err := Load(mapEnv(env))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.WorkQueue != "q.work" {
		t.Errorf("work queue = %q", cfg.WorkQueue)
	}
	if cfg.MaxAttempts != 3 {
		t.Errorf("max attempts = %d", cfg.MaxAttempts)
	}
	if cfg.BaseBackoff != 2*time.Second {
		t.Errorf("base backoff = %v", cfg.BaseBackoff)
	}
	if cfg.MaxBackoff != 30*time.Second {
		t.Errorf("max backoff = %v", cfg.MaxBackoff)
	}
	if cfg.Prefetch != 8 {
		t.Errorf("prefetch = %d", cfg.Prefetch)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("log level = %q", cfg.LogLevel)
	}
}

func TestLoad_InvalidDurationFails(t *testing.T) {
	env := requiredEnv()
	env["STRIDE_WORKER_BASE_BACKOFF"] = "not-a-duration"
	if _, err := Load(mapEnv(env)); err == nil {
		t.Fatal("want error for bad duration")
	}
}

func TestLoad_InvalidIntFails(t *testing.T) {
	env := requiredEnv()
	env["STRIDE_WORKER_MAX_ATTEMPTS"] = "abc"
	if _, err := Load(mapEnv(env)); err == nil {
		t.Fatal("want error for bad int")
	}
}

func TestLoad_NonPositiveMaxAttemptsFails(t *testing.T) {
	env := requiredEnv()
	env["STRIDE_WORKER_MAX_ATTEMPTS"] = "0"
	if _, err := Load(mapEnv(env)); err == nil {
		t.Fatal("want error for max attempts < 1")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
