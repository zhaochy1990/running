package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const validYAML = `
logger:
  format: json
  service-name: stride-worker
  level: info
mysql:
  dsn: "file-dsn@tcp(h:3306)/db"
amqp:
  url: "amqp://guest:guest@h:5672/"
queues:
  work: stride.jobs
  retry: stride.jobs.retry
  poison: stride.jobs.poison
retry:
  max-attempts: 5
  base-backoff: 5s
  max-backoff: 5m
runtime:
  prefetch: 1
  health-addr: ":8081"
`

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write temp config: %v", err)
	}
	return path
}

func TestMustLoadFrom_FileValues(t *testing.T) {
	cfg := MustLoadFrom(writeConfig(t, validYAML))

	if cfg.MySQL.DSN != "file-dsn@tcp(h:3306)/db" {
		t.Errorf("dsn = %q", cfg.MySQL.DSN)
	}
	if cfg.Queues.Work != "stride.jobs" || cfg.Queues.Poison != "stride.jobs.poison" {
		t.Errorf("queues = %+v", cfg.Queues)
	}
	if cfg.Retry.MaxAttempts != 5 {
		t.Errorf("max attempts = %d", cfg.Retry.MaxAttempts)
	}
	if cfg.Retry.BaseBackoff != 5*time.Second || cfg.Retry.MaxBackoff != 5*time.Minute {
		t.Errorf("backoff = %v/%v", cfg.Retry.BaseBackoff, cfg.Retry.MaxBackoff)
	}
	if cfg.Runtime.Prefetch != 1 || cfg.Runtime.HealthAddr != ":8081" {
		t.Errorf("runtime = %+v", cfg.Runtime)
	}
	if cfg.Logger.Level != "info" || cfg.Logger.Format != "json" {
		t.Errorf("logger = %+v", cfg.Logger)
	}
}

func TestMustLoadFrom_EnvOverridesFileAndSecret(t *testing.T) {
	// Secret comes from env; a non-secret key is overridden too.
	t.Setenv("STRIDE_WORKER_MYSQL_DSN", "env-dsn@tcp(prod:3306)/stride")
	t.Setenv("STRIDE_WORKER_RETRY_MAX_ATTEMPTS", "9")
	t.Setenv("STRIDE_WORKER_QUEUES_WORK", "q.work.override")

	cfg := MustLoadFrom(writeConfig(t, validYAML))

	if cfg.MySQL.DSN != "env-dsn@tcp(prod:3306)/stride" {
		t.Fatalf("env did not override secret dsn: %q", cfg.MySQL.DSN)
	}
	if cfg.Retry.MaxAttempts != 9 {
		t.Fatalf("env did not override max-attempts: %d", cfg.Retry.MaxAttempts)
	}
	if cfg.Queues.Work != "q.work.override" {
		t.Fatalf("env did not override queues.work: %q", cfg.Queues.Work)
	}
}

func TestMustLoadFrom_SecretViaEnvOnly(t *testing.T) {
	// mysql.dsn/amqp.url empty in file; env supplies them -> valid.
	body := `
mysql:
  dsn: ""
amqp:
  url: ""
queues: {work: w, retry: r, poison: p}
retry: {max-attempts: 3, base-backoff: 1s, max-backoff: 10s}
runtime: {prefetch: 1, health-addr: ":8081"}
`
	t.Setenv("STRIDE_WORKER_MYSQL_DSN", "d")
	t.Setenv("STRIDE_WORKER_AMQP_URL", "amqp://x")
	cfg := MustLoadFrom(writeConfig(t, body))
	if cfg.MySQL.DSN != "d" || cfg.AMQP.URL != "amqp://x" {
		t.Fatalf("secrets not sourced from env: %+v", cfg)
	}
}

func TestMustLoadFrom_MissingRequiredPanics(t *testing.T) {
	// Empty dsn and no env override -> validator "required" fails -> panic.
	body := `
mysql: {dsn: ""}
amqp: {url: "amqp://x"}
queues: {work: w, retry: r, poison: p}
retry: {max-attempts: 3, base-backoff: 1s, max-backoff: 10s}
runtime: {prefetch: 1, health-addr: ":8081"}
`
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for missing required mysql.dsn")
		}
	}()
	_ = MustLoadFrom(writeConfig(t, body))
}

func TestMustLoadFrom_MissingFilePanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for missing config file")
		}
	}()
	_ = MustLoadFrom(filepath.Join(t.TempDir(), "does-not-exist.yml"))
}
