package planeval

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.uber.org/zap"
)

// QueueName is the execution queue of one agent version. One version, one
// durable queue, reused by every task on that version.
func QueueName(agentVersion string) string { return "plan.eval.execute." + agentVersion }

// ExecuteMessageSchemaVersion is the only message format this service emits.
const ExecuteMessageSchemaVersion = 1

// ExecuteMessage is the pointer message on a version queue: the format
// version and the execution ID, nothing else. The frozen inputs are fetched
// from the internal API (mirrors the TS worker's codec).
type ExecuteMessage struct {
	SchemaVersion       int    `json:"schema_version"`
	SnapshotExecutionID string `json:"snapshot_execution_id"`
}

// QueueDepth is a queue's ready and unacknowledged message counts.
type QueueDepth struct {
	Ready   int `json:"ready"`
	Unacked int `json:"unacked"`
}

// Broker publishes to the version queues and reads their depth from the
// management API — AMQP passive declares report ready messages but not the
// unacknowledged ones the cleanup gate also needs.
type Broker struct {
	mu             sync.Mutex
	publishMu      sync.Mutex
	returns        <-chan amqp.Return
	amqpURL        string
	vhostPath      string
	managementURL  string
	basicAuth      string
	log            *zap.Logger
	client         *http.Client
	conn           *amqp.Connection
	channel        *amqp.Channel
	publishTimeout time.Duration
}

// NewBroker connects to the broker. The management credentials are the user
// embedded in the AMQP URL, and the vhost is the URL's path ("/" by default).
func NewBroker(amqpURL, managementURL string, log *zap.Logger) (*Broker, error) {
	parsed, err := url.Parse(amqpURL)
	if err != nil {
		return nil, fmt.Errorf("plan-eval amqp-url: %w", err)
	}
	if parsed.User == nil {
		return nil, errors.New("plan-eval amqp-url must carry the broker user")
	}
	password, _ := parsed.User.Password()
	vhost := "/"
	if trimmed := strings.TrimPrefix(parsed.Path, "/"); trimmed != "" {
		vhost = trimmed
	}
	b := &Broker{
		amqpURL:        amqpURL,
		vhostPath:      url.PathEscape(vhost),
		managementURL:  strings.TrimRight(managementURL, "/"),
		basicAuth:      "Basic " + base64.StdEncoding.EncodeToString([]byte(parsed.User.Username()+":"+password)),
		log:            log,
		client:         &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}},
		publishTimeout: 10 * time.Second,
	}
	if err := b.connect(); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *Broker) connect() error {
	conn, err := amqp.DialConfig(b.amqpURL, amqp.Config{Heartbeat: 30 * time.Second})
	if err != nil {
		return fmt.Errorf("plan-eval broker dial: %w", err)
	}
	channel, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("plan-eval broker channel: %w", err)
	}
	if err := channel.Confirm(false); err != nil {
		_ = channel.Close()
		_ = conn.Close()
		return fmt.Errorf("plan-eval broker confirm mode: %w", err)
	}
	b.conn, b.channel = conn, channel
	b.returns = channel.NotifyReturn(make(chan amqp.Return, 1))
	return nil
}

// Healthy reports whether the publishing connection is up.
func (b *Broker) Healthy() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.conn != nil && !b.conn.IsClosed()
}

// Close releases the connection.
func (b *Broker) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closeConnection()
}

func (b *Broker) closeConnection() {
	if b.conn != nil {
		_ = b.conn.CloseDeadline(time.Now().Add(time.Second))
	}
	b.conn, b.channel = nil, nil
}

// session returns a confirm channel, redialing if the previous one died.
func (b *Broker) session() (*amqp.Channel, <-chan amqp.Return, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.conn == nil || b.conn.IsClosed() || b.channel.IsClosed() {
		b.closeConnection()
		if err := b.connect(); err != nil {
			return nil, nil, err
		}
		b.log.Info("plan-eval broker reconnected")
	}
	return b.channel, b.returns, nil
}

// EnsureQueue declares the version queue idempotently (durable, not
// auto-delete: the queue outlives its Deployment).
func (b *Broker) EnsureQueue(name string) error {
	ch, _, err := b.session()
	if err != nil {
		return err
	}
	if _, err := ch.QueueDeclare(name, true, false, false, false, amqp.Table{"x-queue-type": "classic"}); err != nil {
		return fmt.Errorf("plan-eval declare queue %s: %w", name, err)
	}
	return nil
}

// Publish sends one persistent pointer message and waits for the broker's
// confirmation. Resolving means the broker owns the message.
func (b *Broker) Publish(ctx context.Context, queue string, message ExecuteMessage) error {
	b.publishMu.Lock()
	defer b.publishMu.Unlock()
	ch, returns, err := b.session()
	if err != nil {
		return err
	}
	body, err := json.Marshal(message)
	if err != nil {
		return err
	}
	confirm, err := ch.PublishWithDeferredConfirmWithContext(ctx, "", queue, true, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		Timestamp:    time.Now(),
		Body:         body,
	})
	if err != nil {
		return fmt.Errorf("plan-eval publish to %s: %w", queue, err)
	}
	confirmationContext, cancel := context.WithTimeout(ctx, b.publishTimeout)
	defer cancel()
	confirmed, err := confirm.WaitContext(confirmationContext)
	if err != nil {
		// An indeterminate confirmation can leave a late return; never reuse its channel.
		b.mu.Lock()
		b.closeConnection()
		b.mu.Unlock()
		return fmt.Errorf("plan-eval publish to %s: wait for broker confirmation: %w", queue, err)
	}
	select {
	case returned, ok := <-returns:
		if !ok {
			return fmt.Errorf("plan-eval publish to %s: channel closed", queue)
		}
		return fmt.Errorf("plan-eval publish to %s: unroutable (%s)", queue, returned.ReplyText)
	default:
	}
	if !confirmed {
		return fmt.Errorf("plan-eval publish to %s: broker nacked the message", queue)
	}
	return nil
}

// QueueDepth reads the queue from the management API. A queue that does not
// exist (never declared) has depth zero.
func (b *Broker) QueueDepth(ctx context.Context, queue string) (QueueDepth, error) {
	endpoint := fmt.Sprintf("%s/api/queues/%s/%s", b.managementURL, b.vhostPath, url.PathEscape(queue)) + "?disable_stats=true&enable_queue_totals=true"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return QueueDepth{}, err
	}
	req.Header.Set("Authorization", b.basicAuth)
	resp, err := b.client.Do(req)
	if err != nil {
		return QueueDepth{}, fmt.Errorf("plan-eval rabbit management: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return QueueDepth{}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return QueueDepth{}, fmt.Errorf("plan-eval rabbit management: %s for queue %s", resp.Status, queue)
	}
	var body struct {
		Type                   string `json:"type"`
		MessagesReady          *int   `json:"messages_ready"`
		MessagesUnacknowledged *int   `json:"messages_unacknowledged"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return QueueDepth{}, fmt.Errorf("plan-eval rabbit management: %w", err)
	}
	if body.Type != "classic" || body.MessagesReady == nil || body.MessagesUnacknowledged == nil || *body.MessagesReady < 0 || *body.MessagesUnacknowledged < 0 {
		return QueueDepth{}, fmt.Errorf("plan-eval rabbit management: queue %s has unsupported type or unavailable totals", queue)
	}
	return QueueDepth{Ready: *body.MessagesReady, Unacked: *body.MessagesUnacknowledged}, nil
}
