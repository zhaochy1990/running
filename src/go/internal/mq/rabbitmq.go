package mq

import (
	"context"
	"fmt"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
)

// Conn wraps a RabbitMQ connection and hands out publishers/consumers.
type Conn struct {
	conn *amqp.Connection
}

// Dial opens a connection to the broker.
func Dial(url string) (*Conn, error) {
	c, err := amqp.Dial(url)
	if err != nil {
		return nil, fmt.Errorf("mq: dial: %w", err)
	}
	return &Conn{conn: c}, nil
}

// Healthy reports whether the connection is still open.
func (c *Conn) Healthy() bool { return c.conn != nil && !c.conn.IsClosed() }

// Close closes the connection (and all its channels).
func (c *Conn) Close() error {
	if c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// DeclareTopology idempotently declares the work, retry, and poison queues. The
// retry queue dead-letters expired messages back onto the work queue.
func (c *Conn) DeclareTopology(t Topology) error {
	ch, err := c.conn.Channel()
	if err != nil {
		return fmt.Errorf("mq: channel: %w", err)
	}
	defer ch.Close()

	if _, err := ch.QueueDeclare(t.Work, true, false, false, false, nil); err != nil {
		return fmt.Errorf("mq: declare work queue: %w", err)
	}
	if _, err := ch.QueueDeclare(t.Poison, true, false, false, false, nil); err != nil {
		return fmt.Errorf("mq: declare poison queue: %w", err)
	}
	// Retry queue: expired messages dead-letter to the default exchange with the
	// work queue as routing key -> they reappear on the work queue after backoff.
	retryArgs := amqp.Table{
		"x-dead-letter-exchange":    "",
		"x-dead-letter-routing-key": t.Work,
	}
	if _, err := ch.QueueDeclare(t.Retry, true, false, false, false, retryArgs); err != nil {
		return fmt.Errorf("mq: declare retry queue: %w", err)
	}
	return nil
}

// --- Publisher (job.Publisher) ------------------------------------------

// Publisher publishes pointer messages with publisher confirms. Safe for
// concurrent use; publishes are serialized so each confirm is awaited.
type Publisher struct {
	mu   sync.Mutex
	ch   *amqp.Channel
	topo Topology
}

// NewPublisher opens a channel in confirm mode.
func (c *Conn) NewPublisher(t Topology) (*Publisher, error) {
	ch, err := c.conn.Channel()
	if err != nil {
		return nil, fmt.Errorf("mq: publisher channel: %w", err)
	}
	if err := ch.Confirm(false); err != nil {
		_ = ch.Close()
		return nil, fmt.Errorf("mq: enable confirms: %w", err)
	}
	return &Publisher{ch: ch, topo: t}, nil
}

// Close closes the publisher channel.
func (p *Publisher) Close() error { return p.ch.Close() }

// PublishWork publishes onto the work queue.
func (p *Publisher) PublishWork(ctx context.Context, m job.Message) error {
	return p.publish(ctx, p.topo.Work, m, "")
}

// PublishRetry publishes onto the retry queue with a per-message TTL (backoff).
func (p *Publisher) PublishRetry(ctx context.Context, m job.Message, delay time.Duration) error {
	return p.publish(ctx, p.topo.Retry, m, expirationMillis(delay))
}

// PublishPoison publishes onto the poison (dead-letter) queue.
func (p *Publisher) PublishPoison(ctx context.Context, m job.Message) error {
	return p.publish(ctx, p.topo.Poison, m, "")
}

func (p *Publisher) publish(ctx context.Context, routingKey string, m job.Message, expiration string) error {
	body, err := encodeMessage(m)
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	dc, err := p.ch.PublishWithDeferredConfirmWithContext(ctx, "", routingKey, false, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		Timestamp:    time.Now().UTC(),
		Expiration:   expiration,
		Body:         body,
	})
	if err != nil {
		return fmt.Errorf("mq: publish to %s: %w", routingKey, err)
	}
	ok, err := dc.WaitContext(ctx)
	if err != nil {
		return fmt.Errorf("mq: await confirm for %s: %w", routingKey, err)
	}
	if !ok {
		return fmt.Errorf("mq: broker nacked publish to %s", routingKey)
	}
	return nil
}

// --- Consumer ------------------------------------------------------------

// HandleFunc processes one decoded message. Returning nil acks the delivery;
// returning an error nacks it with requeue (transient infra fault -> redeliver).
type HandleFunc func(ctx context.Context, m job.Message) error

// Consumer reads the work queue with manual ack and a bounded prefetch.
type Consumer struct {
	ch       *amqp.Channel
	topo     Topology
	prefetch int
	log      *zap.Logger
}

// ConsumerOption configures a Consumer.
type ConsumerOption func(*Consumer)

// WithConsumerLogger sets the structured logger used for per-message logs.
func WithConsumerLogger(l *zap.Logger) ConsumerOption {
	return func(c *Consumer) { c.log = l }
}

// NewConsumer opens a channel with the given prefetch (QoS).
func (c *Conn) NewConsumer(t Topology, prefetch int, opts ...ConsumerOption) (*Consumer, error) {
	ch, err := c.conn.Channel()
	if err != nil {
		return nil, fmt.Errorf("mq: consumer channel: %w", err)
	}
	if err := ch.Qos(prefetch, 0, false); err != nil {
		_ = ch.Close()
		return nil, fmt.Errorf("mq: set qos: %w", err)
	}
	con := &Consumer{ch: ch, topo: t, prefetch: prefetch, log: logging.Default()}
	for _, o := range opts {
		o(con)
	}
	return con, nil
}

// Close closes the consumer channel.
func (c *Consumer) Close() error { return c.ch.Close() }

// Run consumes the work queue until ctx is cancelled or the delivery channel
// closes (connection drop). A malformed message is rejected without requeue
// (it can never be decoded); handler errors are nacked with requeue.
func (c *Consumer) Run(ctx context.Context, handle HandleFunc) error {
	deliveries, err := c.ch.Consume(c.topo.Work, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("mq: consume: %w", err)
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case d, ok := <-deliveries:
			if !ok {
				return fmt.Errorf("mq: delivery channel closed")
			}
			c.handleDelivery(ctx, d, handle)
		}
	}
}

func (c *Consumer) handleDelivery(ctx context.Context, d amqp.Delivery, handle HandleFunc) {
	m, err := decodeMessage(d.Body)
	if err != nil {
		// Undecodable message: reject without requeue so it doesn't loop forever.
		c.log.Warn("rejecting undecodable message", zap.Int("bytes", len(d.Body)), zap.Error(err))
		_ = d.Reject(false)
		return
	}
	c.log.Info("message received", zap.String("job_id", m.JobID), zap.String("user_id", m.UserID))
	if err := handle(ctx, m); err != nil {
		// Infra fault: requeue for redelivery when the fault clears.
		c.log.Warn("message handler faulted, requeueing", zap.String("job_id", m.JobID), zap.Error(err))
		_ = d.Nack(false, true)
		return
	}
	_ = d.Ack(false)
}
