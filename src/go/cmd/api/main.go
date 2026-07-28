// Command api runs the HTTP API server that fronts the async-job worker
// (ADR 0012): it lets internal callers and end users create Async Jobs and
// Pipeline Runs and poll their status. It shares internal/{job,storage,pipeline}
// with the worker but runs no consumer — it holds a MySQL connection and a
// RabbitMQ publisher only.
//
// This main stays thin: load config, wire dependencies, serve until a shutdown
// signal. All logic lives in internal/.
//
//	@title						STRIDE Async-Job API
//	@version					1.0
//	@description				Create and track async jobs and pipelines for the STRIDE worker.
//	@securityDefinitions.apikey	InternalToken
//	@in							header
//	@name						X-Internal-Token
//	@description				Shared secret for server-to-server callers.
//	@securityDefinitions.apikey	BearerAuth
//	@in							header
//	@name						Authorization
//	@description				"Bearer <JWT>" for end-user callers (RS256).
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zhaochy1990/x/logger"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/api"
	"github.com/zhaochy1990/stride/internal/catalog"
	"github.com/zhaochy1990/stride/internal/config"
	"github.com/zhaochy1990/stride/internal/health"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/mq"
	"github.com/zhaochy1990/stride/internal/pipeline"
	"github.com/zhaochy1990/stride/internal/storage"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "api exited with error:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg := config.MustLoadAPI()

	log := logger.MustGetLogger(&cfg.Logger)
	defer func() { _ = log.Sync() }()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// --- MySQL (state) ---
	store, err := storage.Open(cfg.MySQL.DSN)
	if err != nil {
		return err
	}
	defer store.Close()
	if err := store.AutoMigrate(ctx); err != nil {
		return err
	}

	// --- RabbitMQ (publisher only; no consumer) ---
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

	// --- wiring ---
	enq := job.NewStoreEnqueuer(store.Jobs(), pub)
	orch := pipeline.New(store.Pipelines(), enq, catalog.PipelineRegistry(), pipeline.WithLogger(log))

	verifier, err := api.NewJWTVerifier(cfg.API.Auth.PublicKeyPath, cfg.API.Auth.Issuer, cfg.API.Auth.Audience)
	if err != nil {
		return err
	}
	authn := api.NewAuthenticator(cfg.API.InternalToken, verifier)

	svc := api.NewService(api.Config{
		Enqueuer:              enq,
		Jobs:                  store.Jobs(),
		JobsIdem:              store,
		Pipelines:             orch,
		Runs:                  store.Pipelines(),
		RunsIdem:              store,
		JobUserInitiable:      catalog.JobUserInitiable(),
		PipelineUserInitiable: catalog.PipelineUserInitiable(),
		Auth:                  authn,
		CORSOrigins:           cfg.API.CORSOrigins,
		SwaggerEnabled:        cfg.API.SwaggerEnabled,
		Health: map[string]health.Check{
			"mysql": store.Ping,
			"rabbitmq": func(context.Context) error {
				if !conn.Healthy() {
					return errors.New("broker connection closed")
				}
				return nil
			},
		},
		Logger: log,
	})

	gin.SetMode(gin.ReleaseMode)
	srv := &http.Server{Addr: cfg.API.Addr, Handler: svc.Router()}

	log.Info("api starting",
		zap.String("addr", cfg.API.Addr),
		zap.Bool("swagger_enabled", cfg.API.SwaggerEnabled),
		zap.Strings("cors_origins", cfg.API.CORSOrigins),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()

	select {
	case <-ctx.Done():
		log.Info("shutdown signal received, draining")
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutCtx)
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}
