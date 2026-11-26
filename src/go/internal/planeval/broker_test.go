package planeval

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPlanEval_QueueDepthFailsClosed(t *testing.T) {
	for _, body := range []string{`{}`, `{"type":"classic","messages_ready":null,"messages_unacknowledged":0}`, `{"type":"quorum","messages_ready":0,"messages_unacknowledged":0}`, `{"type":"classic","messages_ready":-1,"messages_unacknowledged":0}`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("disable_stats") != "true" || r.URL.Query().Get("enable_queue_totals") != "true" {
				t.Error("cleanup used sampled stats")
			}
			_, _ = w.Write([]byte(body))
		}))
		broker := &Broker{managementURL: server.URL, vhostPath: "%2F", client: server.Client()}
		_, err := broker.QueueDepth(context.Background(), "test")
		server.Close()
		if err == nil {
			t.Fatalf("unknown depth accepted as idle: %s", body)
		}
	}
}
