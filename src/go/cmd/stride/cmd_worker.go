// Subcommand `stride worker`: the async-job worker. It consumes pointer messages
// from RabbitMQ and dispatches them to registered handlers, persisting state in
// MySQL. This stays thin: load config, wire dependencies, run until a shutdown
// signal. All logic lives in internal/.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/zhaochy1990/x/logger"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/config"
	"github.com/zhaochy1990/stride/internal/handlers/compute"
	"github.com/zhaochy1990/stride/internal/handlers/watchsync"
	"github.com/zhaochy1990/stride/internal/health"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/mq"
	"github.com/zhaochy1990/stride/internal/pipeline"
	"github.com/zhaochy1990/stride/internal/registry"
	"github.com/zhaochy1990/stride/internal/storage"
)

// heartbeatInterval is how often the worker logs a liveness heartbeat with its
// running dispatch counters.
const heartbeatInterval = 30 * time.Second

func newWorkerCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "worker",
		Short: "Run the async-job worker (consumes RabbitMQ, persists MySQL)",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runWorker()
		},
	}
}

func runWorker() error {
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
	consumer, err := conn.NewConsumer(topo, cfg.Runtime.Prefetch, mq.WithConsumerLogger(log))
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
	// Resolve each user's watch provider (COROS/Garmin) via the registry: MySQL
	// credential binding first, file-based config.json fallback (ADR 0010/0011).
	resolve := func(ctx context.Context, user string) (watchsync.Provider, error) {
		name, err := registry.Resolve(ctx, store, cfg.Runtime.DataDir, user)
		if err != nil {
			return nil, err
		}
		return registry.Build(name, store, watchRequestDelay)
	}
	registerHandlers(reg, resolve, store)
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
	}, health.WithLogger(log))

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

	// Periodic liveness heartbeat with running dispatch counters.
	started := time.Now()
	go func() {
		t := time.NewTicker(heartbeatInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s := dispatcher.Stats()
				log.Info("worker heartbeat",
					zap.Duration("uptime", time.Since(started).Round(time.Second)),
					zap.Int64("started", s.Started),
					zap.Int64("completed", s.Completed),
					zap.Int64("failed", s.Failed),
				)
			}
		}
	}()

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
// `watch_sync` runs a user's watch-data sync (ADR 0011); `calibration` computes
// the athlete baseline and `compute` derives load/PMC/PBs from synced data,
// mode-aware (ADR 0020).
func registerHandlers(reg *job.Registry, resolve watchsync.Resolver, store *storage.Store) {
	reg.MustRegister("hello", func(_ context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		_ = hb("greeting", 50)
		return fmt.Sprintf(`{"echo":%q}`, j.InputJSON), nil
	})
	reg.MustRegister(watchsync.JobType, watchsync.New(resolve, store, watchJobs))
	reg.MustRegister(compute.CalibrationJobType, compute.NewCalibration(store))
	reg.MustRegister(compute.ComputeJobType, compute.NewCompute(store))
}
