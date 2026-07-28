package syncconfig

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeYAML(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "config.sync.yml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatalf("write yaml: %v", err)
	}
	return p
}

const baseYAML = `
logger:
  format: console
  service-name: stride-sync
  level: info
mysql:
  dsn: "user:pass@tcp(127.0.0.1:3306)/stride"
sync:
  jobs: 4
  request-delay: 500ms
`

func TestLoad(t *testing.T) {
	cfg := MustLoadFrom(writeYAML(t, baseYAML))
	if cfg.MySQL.DSN == "" {
		t.Error("dsn not loaded")
	}
	if cfg.Sync.Jobs != 4 {
		t.Errorf("jobs = %d, want 4", cfg.Sync.Jobs)
	}
	if cfg.Sync.RequestDelay != 500*time.Millisecond {
		t.Errorf("request-delay = %v, want 500ms", cfg.Sync.RequestDelay)
	}
}

func TestEnvOverridesNestedKey(t *testing.T) {
	t.Setenv("STRIDE_SYNC_MYSQL_DSN", "envuser:envpass@tcp(db:3306)/stride")
	t.Setenv("STRIDE_SYNC_SYNC_JOBS", "8")
	cfg := MustLoadFrom(writeYAML(t, baseYAML))
	if cfg.MySQL.DSN != "envuser:envpass@tcp(db:3306)/stride" {
		t.Errorf("env did not override dsn: %q", cfg.MySQL.DSN)
	}
	if cfg.Sync.Jobs != 8 {
		t.Errorf("env did not override jobs: %d", cfg.Sync.Jobs)
	}
}

func TestValidationPanicsWithoutDSN(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("expected panic when mysql.dsn is empty (required)")
		}
	}()
	MustLoadFrom(writeYAML(t, `
logger: {format: console, service-name: stride-sync, level: info}
mysql:
  dsn: ""
sync:
  jobs: 4
  request-delay: 500ms
`))
}
