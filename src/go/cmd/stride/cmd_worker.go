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
	"github.com/zhaochy1990/stride/internal/cos"
	"github.com/zhaochy1990/stride/internal/handlers/competitioncalendar"
	"github.com/zhaochy1990/stride/internal/handlers/compute"
	racehandler "github.com/zhaochy1990/stride/internal/handlers/racedetection"
	"github.com/zhaochy1990/stride/internal/handlers/routethumbnails"
	"github.com/zhaochy1990/stride/internal/handlers/watchsync"
	"github.com/zhaochy1990/stride/internal/health"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/mq"
	"github.com/zhaochy1990/stride/internal/pipeline"
	"github.com/zhaochy1990/stride/internal/racedetection"
	"github.com/zhaochy1990/stride/internal/registry"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/worldathletics"
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

	raceClassifier, err := newRaceClassifier(cfg.RaceDetection)
	if err != nil {
		return err
	}

	// Route-thumbnail bucket. An incomplete config yields an inert client rather
	// than a boot failure — the handler skips itself and reports why.
	cosClient := cos.NewClient(cos.Config{
		SecretID:  cfg.COS.SecretID,
		SecretKey: cfg.COS.SecretKey,
		Bucket:    cfg.COS.Bucket,
		Region:    cfg.COS.Region,
		BaseURL:   cfg.COS.BaseURL,
	})

	// World Athletics GraphQL client for the competition_calendar_sync pipeline.
	waClient := worldathletics.New(worldathletics.Config{
		Endpoint: cfg.WorldAthletics.Endpoint,
		APIKey:   cfg.WorldAthletics.APIKey,
		Timeout:  cfg.WorldAthletics.Timeout,
	})

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
	// competition_calendar table written by the competition_calendar_sync pipeline.
	if err := store.AutoMigrateCompetitionCalendar(ctx); err != nil {
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
	registerHandlers(reg, resolve, store, racedetection.New(raceClassifier), cfg.RaceDetection.MaxConcurrency, cosClient, waClient, competitioncalendar.Config{
		Client:                waClient,
		Store:                 store,
		CompetitionGroupID:    cfg.WorldAthletics.CompetitionGroupID,
		CompetitionSubgroupID: cfg.WorldAthletics.CompetitionSubgroupID,
		DefaultSeasons:        cfg.WorldAthletics.Seasons,
	})
	policy := job.RetryPolicy{
		MaxAttempts: cfg.Retry.MaxAttempts,
		BaseBackoff: cfg.Retry.BaseBackoff,
		MaxBackoff:  cfg.Retry.MaxBackoff,
	}
	dispatcher := job.NewDispatcher(store.Jobs(), reg, pub, orch, policy, job.WithLogger(log), job.WithLease(cfg.Runtime.ClaimLease))

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
		zap.String("version", appVersion()),
		zap.String("work_queue", cfg.Queues.Work),
		zap.Int("prefetch", cfg.Runtime.Prefetch),
		zap.Int("max_attempts", cfg.Retry.MaxAttempts),
		zap.String("health_addr", cfg.Runtime.HealthAddr),
		zap.Strings("registered_types", reg.Types()),
	)

	// --- run consumer + health server; first error or signal wins ---
	consumerErr := make(chan error, 1)
	healthErr := make(chan error, 1)
	go func() { consumerErr <- consumer.Run(ctx, dispatcher.Dispatch) }()
	go func() { healthErr <- hs.Run(ctx) }()

	// Reclaim jobs stranded by a dead worker: once at boot so a crashed
	// predecessor's in-flight work is picked up promptly, then on the cadence.
	// The lease CAS makes this safe to run on every replica.
	reclaim := func() {
		n, err := dispatcher.ReclaimStale(ctx, cfg.Runtime.ClaimLease)
		if err != nil {
			log.Warn("stale-running reclaim failed", zap.Error(err))
		} else if n > 0 {
			log.Info("reclaimed stale running jobs", zap.Int("count", n))
		}
	}
	go func() {
		reclaim()
		t := time.NewTicker(cfg.Runtime.ReclaimInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				reclaim()
			}
		}
	}()

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
		// SIGTERM: ctx is cancelled, so the in-flight handler unwinds. Wait for
		// the consumer to finish recording its requeue/terminal state before
		// closing the broker connection — otherwise the delivery is dropped and a
		// `running` job is stranded until the next lease reclaim.
		log.Info("shutdown signal received, draining")
		drainCtx, cancel := context.WithTimeout(context.Background(), cfg.Runtime.DrainTimeout)
		defer cancel()
		select {
		case err := <-consumerErr:
			if err != nil && !errors.Is(err, context.Canceled) {
				log.Warn("consumer exited during drain", zap.Error(err))
			}
			log.Info("drained in-flight work")
		case <-drainCtx.Done():
			log.Warn("drain timed out; in-flight jobs will be reclaimed by lease")
		}
		return nil
	case err := <-consumerErr:
		if err != nil && !errors.Is(err, context.Canceled) {
			return err
		}
		return nil
	case err := <-healthErr:
		if err != nil && !errors.Is(err, context.Canceled) {
			return err
		}
		return nil
	}
}

func newRaceClassifier(cfg config.RaceDetection) (racedetection.Classifier, error) {
	return racedetection.NewClassifier(racedetection.ProviderConfig{
		APIKind: cfg.APIKind, Endpoint: cfg.Endpoint, APIKey: cfg.APIKey,
		Model: cfg.Model, Timeout: cfg.Timeout,
	})
}

// registerHandlers wires job handlers. `hello` is the deploy smoke handler;
// `watch_sync` runs a user's watch-data sync (ADR 0011); `calibration` computes
// the athlete baseline and `compute` derives load/PMC/PBs from synced data,
// mode-aware (ADR 0020); `route_thumbnails` renders outdoor activities into
// route PNGs in COS, with `route_thumbnails_backfill` doing the all-history scan;
// `competition_calendar_sync` mirrors the World Athletics calendar (ccConfig),
// preceded by `fetch_wa_api_key` key discovery (waClient).
func registerHandlers(reg *job.Registry, resolve watchsync.Resolver, store *storage.Store, raceDetector *racedetection.Detector, raceConcurrency int, cosClient *cos.Client, waClient *worldathletics.Client, ccConfig competitioncalendar.Config) {
	reg.MustRegister("hello", func(_ context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		_ = hb("greeting", 50)
		return fmt.Sprintf(`{"echo":%q}`, j.InputJSON), nil
	})
	reg.MustRegister(watchsync.JobType, watchsync.New(resolve, store, watchJobs))
	reg.MustRegister(racehandler.JobType, racehandler.New(store, raceDetector, raceConcurrency))
	reg.MustRegister(racehandler.BackfillJobType, racehandler.NewBackfill(store, raceDetector, raceConcurrency))
	reg.MustRegister(compute.CalibrationJobType, compute.NewCalibration(store))
	reg.MustRegister(compute.ComputeJobType, compute.NewCompute(store))
	reg.MustRegister(compute.AbilityJobType, compute.NewAbility(store))
	// Both thumbnail job types share one handler: the candidate query already
	// selects only activities lacking a thumbnail, so the backfill needs no
	// different behaviour — only its own catalog entry to be triggered on demand.
	reg.MustRegister(routethumbnails.JobType, routethumbnails.New(store, cosClient))
	reg.MustRegister(routethumbnails.BackfillJobType, routethumbnails.New(store, cosClient))
	// competition_calendar_sync pipeline: discover the current WA API key (so a
	// rotation self-heals), then mirror the calendar with the discovered or the
	// configured key.
	reg.MustRegister(competitioncalendar.KeyJobType, competitioncalendar.NewKeyFetcher(waClient, competitioncalendar.DefaultSitePageURL))
	reg.MustRegister(competitioncalendar.JobType, competitioncalendar.New(ccConfig))
}
