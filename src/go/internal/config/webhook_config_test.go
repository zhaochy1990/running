package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAPIWebhookConfigFromEnv(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	if err := os.WriteFile(path, []byte(`
logger: {format: json, service-name: s, level: info}
mysql: {dsn: "d@tcp(h:3306)/db"}
amqp: {url: "amqp://u"}
queues: {work: w, retry: r, poison: p}
api:
  addr: ":8080"
  internal-token: "t"
  auth: {issuer: i, audience: a, public-key-path: /dev/null}
webhook:
  enqueue-enabled: false
  coros-client: ""
  coros-secret: ""
`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("STRIDE_WORKER_WEBHOOK_COROS_CLIENT", "cli-1")
	t.Setenv("STRIDE_WORKER_WEBHOOK_COROS_SECRET", "sec-1")
	t.Setenv("STRIDE_WORKER_WEBHOOK_ENQUEUE_ENABLED", "true")
	cfg := MustLoadAPIFrom(path)
	if cfg.Webhook.CorosClient != "cli-1" || cfg.Webhook.CorosSecret != "sec-1" {
		t.Fatalf("coros creds not overridden by env: %+v", cfg.Webhook)
	}
	if !cfg.Webhook.EnqueueEnabled {
		t.Fatal("enqueue-enabled not overridden by env")
	}
}
