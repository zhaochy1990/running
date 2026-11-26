package planeval

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
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

const brokerOperationTimeout = 10 * time.Second

// Broker publishes to the version queues and reads their depth from the
// management API — AMQP passive declares report ready messages but not the
// unacknowledged ones the cleanup gate also needs.
type Broker struct {
	mu            sync.Mutex
	operation     chan struct{}
	returns       <-chan amqp.Return
	amqpURL       string
	vhostPath     string
	managementURL string
	basicAuth     string
	log           *zap.Logger
	client        *http.Client
	transport     net.Conn
	conn          *amqp.Connection
	channel       *amqp.Channel
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
		operation:     make(chan struct{}, 1),
		amqpURL:       amqpURL,
		vhostPath:     url.PathEscape(vhost),
		managementURL: strings.TrimRight(managementURL, "/"),
		basicAuth:     "Basic " + base64.StdEncoding.EncodeToString([]byte(parsed.User.Username()+":"+password)),
		log:           log,
		client:        &http.Client{Timeout: brokerOperationTimeout, Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}},
	}
	ctx, cancel := context.WithTimeout(context.Background(), brokerOperationTimeout)
	defer cancel()
	if err := b.connect(ctx); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *Broker) connect(ctx context.Context) error {
	var transport net.Conn
	stop := func() bool { return true }
	defer func() {
		stop()
		if transport != nil && b.transport != transport {
			_ = transport.Close()
		}
	}()
	dialer := &net.Dialer{}
	conn, err := amqp.DialConfig(b.amqpURL, amqp.Config{Heartbeat: 30 * time.Second, Dial: func(network, address string) (net.Conn, error) {
		raw, err := dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		transport = raw
		stop = context.AfterFunc(ctx, func() { _ = raw.Close() })
		return raw, nil
	}})
	if err != nil {
		return fmt.Errorf("plan-eval broker dial: %w", err)
	}
	channel, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("plan-eval broker channel: %w", err)
	}
	if err := channel.Confirm(false); err != nil {
		return fmt.Errorf("plan-eval broker confirm mode: %w", err)
	}
	if !stop() {
		return ctx.Err()
	}
	b.transport, b.conn, b.channel = transport, conn, channel
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
	if b.transport != nil {
		_ = b.transport.Close()
	}
	b.transport, b.conn, b.channel, b.returns = nil, nil, nil, nil
}

// startOperation serializes access to the confirm channel so returns can be
// matched to one publish. Closing its transport interrupts blocking AMQP RPCs
// and writes, which do not honor Go contexts once they start.
func (b *Broker) startOperation(ctx context.Context) (*amqp.Channel, <-chan amqp.Return, func(), error) {
	select {
	case b.operation <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, nil, ctx.Err()
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := ctx.Err(); err != nil {
		<-b.operation
		return nil, nil, nil, err
	}
	if b.conn == nil || b.conn.IsClosed() || b.channel.IsClosed() {
		b.closeConnection()
		if err := b.connect(ctx); err != nil {
			<-b.operation
			return nil, nil, nil, err
		}
		b.log.Info("plan-eval broker reconnected")
	}
	channel, transport := b.channel, b.transport
	stop := context.AfterFunc(ctx, func() { _ = transport.Close() })
	finish := func() {
		stop()
		if ctx.Err() != nil {
			b.invalidateSession(channel)
		}
		<-b.operation
	}
	return channel, b.returns, finish, nil
}

// EnsureQueue declares the version queue idempotently (durable, not
// auto-delete: the queue outlives its Deployment).
func (b *Broker) EnsureQueue(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(ctx, brokerOperationTimeout)
	defer cancel()
	ch, _, finish, err := b.startOperation(ctx)
	if err != nil {
		return err
	}
	defer finish()
	if _, err := ch.QueueDeclare(name, true, false, false, false, amqp.Table{"x-queue-type": "classic"}); err != nil {
		return fmt.Errorf("plan-eval declare queue %s: %w", name, err)
	}
	return nil
}

// Publish sends one persistent pointer message and waits for the broker's
// confirmation. Resolving means the broker owns the message.
func (b *Broker) Publish(ctx context.Context, queue string, message ExecuteMessage) error {
	ctx, cancel := context.WithTimeout(ctx, brokerOperationTimeout)
	defer cancel()
	ch, returns, finish, err := b.startOperation(ctx)
	if err != nil {
		return err
	}
	defer finish()
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
	confirmed, err := confirm.WaitContext(ctx)
	if err != nil {
		// An indeterminate confirmation can leave a late return; never reuse its channel.
		b.invalidateSession(ch)
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

func (b *Broker) invalidateSession(channel *amqp.Channel) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.channel == channel {
		b.closeConnection()
	}
}
