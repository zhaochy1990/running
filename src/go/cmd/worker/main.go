// Command worker runs the async-job worker: it consumes pointer messages from
// RabbitMQ and dispatches them to registered handlers, persisting state in MySQL.
//
// This main stays thin: load config, wire dependencies, run until a shutdown
// signal. All logic lives in internal/.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/zhaochy1990/stride/internal/config"
	"github.com/zhaochy1990/stride/internal/health"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/mq"
	"github.com/zhaochy1990/stride/internal/pipeline"
	"github.com/zhaochy1990/stride/internal/storage"
)

func main() {
	if err := run(); err != nil {
		slog.Error("worker exited with error", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(cfg.LogLevel)}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// --- MySQL ---
	store, err := storage.Open(cfg.MySQLDSN)
	if err != nil {
		return err
	}
	defer store.Close()
	if err := store.AutoMigrate(ctx); err != nil {
		return err
	}

	// --- RabbitMQ ---
	conn, err := mq.Dial(cfg.AMQPURL)
	if err != nil {
		return err
	}
	defer conn.Close()
	topo := mq.Topology{Work: cfg.WorkQueue, Retry: cfg.RetryQueue, Poison: cfg.PoisonQueue}
	if err := conn.DeclareTopology(topo); err != nil {
		return err
	}
	pub, err := conn.NewPublisher(topo)
	if err != nil {
		return err
	}
	defer pub.Close()
	consumer, err := conn.NewConsumer(topo, cfg.Prefetch)
	if err != nil {
		return err
	}
	defer consumer.Close()

	// --- wiring ---
	enq := job.NewStoreEnqueuer(store.Jobs(), pub)
	// Pipeline definitions land together with their step handlers (out of scope
	// for the infra phase), so the worker starts with an empty registry. The
	// worker only advances/finalizes runs (from stored steps) and never calls
	// StartPipeline, so an empty registry is sufficient here.
	orch := pipeline.New(store.Pipelines(), enq, pipeline.NewRegistry(), pipeline.WithLogger(log))
	reg := job.NewRegistry()
	registerHandlers(reg)
	policy := job.RetryPolicy{
		MaxAttempts: cfg.MaxAttempts,
		BaseBackoff: cfg.BaseBackoff,
		MaxBackoff:  cfg.MaxBackoff,
	}
	dispatcher := job.NewDispatcher(store.Jobs(), reg, pub, orch, policy, job.WithLogger(log))

	// --- health ---
	hs := health.New(cfg.HealthAddr, map[string]health.Check{
		"mysql": store.Ping,
		"rabbitmq": func(context.Context) error {
			if !conn.Healthy() {
				return errors.New("broker connection closed")
			}
			return nil
		},
	})

	log.Info("worker starting",
		"work_queue", cfg.WorkQueue,
		"prefetch", cfg.Prefetch,
		"max_attempts", cfg.MaxAttempts,
		"health_addr", cfg.HealthAddr,
		"registered_types", reg.Types(),
	)

	// --- run consumer + health server; first error or signal wins ---
	errCh := make(chan error, 2)
	go func() { errCh <- consumer.Run(ctx, dispatcher.Dispatch) }()
	go func() { errCh <- hs.Run(ctx) }()

	select {
	case <-ctx.Done():
		log.Info("shutdown signal received, draining")
		return nil
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) {
			return err
		}
		return nil
	}
}

// registerHandlers wires job handlers. Real handlers (onboarding sync, etc.) are
// out of scope for the infra phase; only the smoke handler is registered so the
// deploy pipeline can prove enqueue -> worker -> done end to end.
func registerHandlers(reg *job.Registry) {
	reg.MustRegister("hello", func(_ context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		_ = hb("greeting", 50)
		return fmt.Sprintf(`{"echo":%q}`, j.InputJSON), nil
	})
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
