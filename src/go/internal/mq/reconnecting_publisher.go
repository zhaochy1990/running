package mq

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
)

const (
	defaultReconnectDelay    = time.Second
	defaultMaxReconnectDelay = 30 * time.Second
)

type publisherSession interface {
	Healthy() bool
	Close() error
	PublishWork(context.Context, job.Message) error
	PublishRetry(context.Context, job.Message, time.Duration) error
	PublishPoison(context.Context, job.Message) error
}

type amqpPublisherSession struct {
	conn *Conn
	pub  *Publisher
}

func (s *amqpPublisherSession) Healthy() bool { return s.conn.Healthy() && s.pub.Healthy() }

func (s *amqpPublisherSession) Close() error {
	return errors.Join(s.pub.Close(), s.conn.Close())
}

func (s *amqpPublisherSession) PublishWork(ctx context.Context, m job.Message) error {
	return s.pub.PublishWork(ctx, m)
}

func (s *amqpPublisherSession) PublishRetry(ctx context.Context, m job.Message, delay time.Duration) error {
	return s.pub.PublishRetry(ctx, m, delay)
}

func (s *amqpPublisherSession) PublishPoison(ctx context.Context, m job.Message) error {
	return s.pub.PublishPoison(ctx, m)
}

// ReconnectingPublisher replaces its AMQP connection and channel after a
// disconnect. A failed publish is returned to the caller rather than retried,
// because a lost publisher confirm makes the broker outcome ambiguous.
type ReconnectingPublisher struct {
	mu       sync.RWMutex
	session  publisherSession
	dial     func() (publisherSession, error)
	minDelay time.Duration
	maxDelay time.Duration
	stop     chan struct{}
	done     chan struct{}
	close    sync.Once
}

// NewReconnectingPublisher connects to RabbitMQ and keeps the publisher
// connection alive until Close is called.
func NewReconnectingPublisher(url string, topo Topology) (*ReconnectingPublisher, error) {
	dial := func() (publisherSession, error) {
		conn, err := Dial(url)
		if err != nil {
			return nil, err
		}
		if err := conn.DeclareTopology(topo); err != nil {
			_ = conn.Close()
			return nil, err
		}
		pub, err := conn.NewPublisher(topo)
		if err != nil {
			_ = conn.Close()
			return nil, err
		}
		return &amqpPublisherSession{conn: conn, pub: pub}, nil
	}
	return newReconnectingPublisher(dial, defaultReconnectDelay, defaultMaxReconnectDelay)
}

func newReconnectingPublisher(dial func() (publisherSession, error), minDelay, maxDelay time.Duration) (*ReconnectingPublisher, error) {
	session, err := dial()
	if err != nil {
		return nil, fmt.Errorf("mq: create publisher session: %w", err)
	}
	p := &ReconnectingPublisher{
		session:  session,
		dial:     dial,
		minDelay: minDelay,
		maxDelay: maxDelay,
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
	go p.reconnectLoop()
	return p, nil
}

// Healthy reports whether the current publisher session can accept messages.
func (p *ReconnectingPublisher) Healthy() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.session != nil && p.session.Healthy()
}

// Close stops reconnection and closes the current publisher session.
func (p *ReconnectingPublisher) Close() error {
	p.close.Do(func() { close(p.stop) })
	<-p.done
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.session == nil {
		return nil
	}
	err := p.session.Close()
	p.session = nil
	return err
}

func (p *ReconnectingPublisher) PublishWork(ctx context.Context, m job.Message) error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.session == nil {
		return errors.New("mq: publisher closed")
	}
	return p.session.PublishWork(ctx, m)
}

func (p *ReconnectingPublisher) PublishRetry(ctx context.Context, m job.Message, delay time.Duration) error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.session == nil {
		return errors.New("mq: publisher closed")
	}
	return p.session.PublishRetry(ctx, m, delay)
}

func (p *ReconnectingPublisher) PublishPoison(ctx context.Context, m job.Message) error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.session == nil {
		return errors.New("mq: publisher closed")
	}
	return p.session.PublishPoison(ctx, m)
}

func (p *ReconnectingPublisher) reconnectLoop() {
	defer close(p.done)
	delay := p.minDelay
	for {
		if !p.wait(delay) {
			return
		}
		if p.Healthy() {
			delay = p.minDelay
			continue
		}
		session, err := p.dial()
		if err != nil {
			delay = min(delay*2, p.maxDelay)
			continue
		}
		select {
		case <-p.stop:
			_ = session.Close()
			return
		default:
		}
		p.mu.Lock()
		old := p.session
		p.session = session
		p.mu.Unlock()
		if old != nil {
			_ = old.Close()
		}
		delay = p.minDelay
	}
}

func (p *ReconnectingPublisher) wait(delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-p.stop:
		return false
	}
}
