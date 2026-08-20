// Package mq is the RabbitMQ transport: topology declaration, a publisher with
// confirms, and a consumer with manual ack. Topology (ADR 0001):
//
//	work   queue  (stride.jobs)         — consumers read here
//	retry  queue  (stride.jobs.retry)   — per-message TTL; dead-letters back to work
//	poison queue  (stride.jobs.poison)  — terminal dead jobs
//
// The retry queue's dead-letter-exchange is the default exchange ("") with a
// dead-letter-routing-key of the work queue, so an expired retry message
// reappears on the work queue after its backoff.
package mq

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
)

// Topology names the three queues.
type Topology struct {
	Work   string
	Retry  string
	Poison string
}

// encodeMessage serializes a pointer message to JSON.
func encodeMessage(m job.Message) ([]byte, error) {
	return json.Marshal(m)
}

// decodeMessage parses a pointer message from a delivery body.
func decodeMessage(b []byte) (job.Message, error) {
	var m job.Message
	if err := json.Unmarshal(b, &m); err != nil {
		return job.Message{}, fmt.Errorf("mq: decode message: %w", err)
	}
	if m.JobID == "" {
		return job.Message{}, fmt.Errorf("mq: message missing job_id")
	}
	return m, nil
}

// expirationMillis renders a backoff delay as a RabbitMQ per-message TTL string
// (integer milliseconds). A non-positive delay yields "0" (expire immediately).
func expirationMillis(d time.Duration) string {
	ms := d.Milliseconds()
	if ms < 0 {
		ms = 0
	}
	return fmt.Sprintf("%d", ms)
}
