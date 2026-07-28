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
	"os"
	"os/signal"
	"syscall"

	"github.com/zhaochy1990/x/logger"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/config"
	"github.com/zhaochy1990/stride/internal/handlers/watchsync"
	"github.com/zhaochy1990/stride/internal/health"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/mq"
	"github.com/zhaochy1990/stride/internal/pipeline"
	"github.com/zhaochy1990/stride/internal/provider/coros"
	"github.com/zhaochy1990/stride/internal/storage"
)

func main() {
	if err := run(); err != nil {
		// logger may not be up yet if config/log init failed; use the global
		// (a no-op until MustGetLogger runs) and also print to stderr.
		fmt.Fprintln(os.Stderr, "worker exited with error:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg := config.MustLoad()

	log := logger.MustGetLogger(&cfg.Logger)
	defer func() { _ = log.Sync() }()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// --- MySQL ---
	store, err := storage.Open(cfg.MySQL.DSN)
	if err != nil {
		return err
	}
	defer store.Close()
	if err := store.AutoMigrate(ctx); err != nil {
		return err
	}
	// Watch-domain tables (activities/health/credentials/cursor) for the sync handler.
	if err := store.AutoMigrateWatch(ctx); err != nil {
		return err
	}

	// --- RabbitMQ ---
	conn, err := mq.Dial(cfg.AMQP.URL)
	if err != nil {
		return err
	}
	defer conn.Close()
	topo := mq.Topology{Work: cfg.Queues.Work, Retry: cfg.Queues.Retry, Poison: cfg.Queues.Poison}
	if err := conn.DeclareTopology(topo); err != nil {
		return err
	}
	pub, err := conn.NewPublisher(topo)
	if err != nil {
		return err
	}
	defer pub.Close()
	consumer, err := conn.NewConsumer(topo, cfg.Runtime.Prefetch)
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
	// COROS watch-sync provider (writes to the same canonical MySQL store).
	watchProvider := coros.New(store, coros.NewStorageCredentialStore(store))
	registerHandlers(reg, watchProvider)
	policy := job.RetryPolicy{
		MaxAttempts: cfg.Retry.MaxAttempts,
		BaseBackoff: cfg.Retry.BaseBackoff,
		MaxBackoff:  cfg.Retry.MaxBackoff,
	}
	dispatcher := job.NewDispatcher(store.Jobs(), reg, pub, orch, policy, job.WithLogger(log))

	// --- health ---
	hs := health.New(cfg.Runtime.HealthAddr, map[string]health.Check{
		"mysql": store.Ping,
		"rabbitmq": func(context.Context) error {
			if !conn.Healthy() {
				return errors.New("broker connection closed")
			}
			return nil
		},
	})

	log.Info("worker starting",
		zap.String("work_queue", cfg.Queues.Work),
		zap.Int("prefetch", cfg.Runtime.Prefetch),
		zap.Int("max_attempts", cfg.Retry.MaxAttempts),
		zap.String("health_addr", cfg.Runtime.HealthAddr),
		zap.Strings("registered_types", reg.Types()),
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

// registerHandlers wires job handlers. `hello` is the deploy smoke handler;
// `watch_sync` runs a user's COROS watch-data sync (ADR 0011).
func registerHandlers(reg *job.Registry, watchProvider watchsync.Provider) {
	reg.MustRegister("hello", func(_ context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		_ = hb("greeting", 50)
		return fmt.Sprintf(`{"echo":%q}`, j.InputJSON), nil
	})
	reg.MustRegister(watchsync.JobType, watchsync.New(watchProvider))
}
