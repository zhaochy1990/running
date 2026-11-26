package planeval

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.uber.org/zap"
)

func TestPlanEval_BrokerCancellationInterruptsHandshake(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	broker := &Broker{
		operation: make(chan struct{}, 1),
		amqpURL:   "amqp://guest:guest@" + listener.Addr().String() + "/",
		log:       zap.NewNop(),
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- broker.EnsureQueue(ctx, "unused") }()
	transport, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	cancel()
	select {
	case err := <-result:
		if err == nil || broker.Healthy() || len(broker.operation) != 0 {
			t.Fatalf("canceled broker connection retained: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("broker operation kept waiting for the AMQP handshake")
	}
}

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
