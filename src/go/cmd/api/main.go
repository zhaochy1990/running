// Command api runs the HTTP API server that fronts the async-job worker
// (ADR 0012): it lets internal callers and end users create Async Jobs and
// Pipeline Runs and poll their status. It shares internal/{job,storage,pipeline}
// with the worker but runs no consumer — it holds a MySQL connection and a
// RabbitMQ publisher only.
//
// This main stays thin: load config, wire dependencies, serve until a shutdown
// signal. All logic lives in internal/.
//
//	@title						STRIDE API
//	@version					1.0
//	@description				HTTP API fronting the STRIDE worker: create and track async jobs and pipeline runs, and manage user profile, onboarding, and watch-provider login.
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
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zhaochy1990/x/logger"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/api"
	"github.com/zhaochy1990/stride/internal/authsvc"
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
	// user_profile + user_onboarding tables for the profile/onboarding surface
	// (ADR 0013). The worker does not need these.
	if err := store.AutoMigrateUsers(ctx); err != nil {
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

	// User/onboarding surface deps (ADR 0013).
	authNameSync := authsvc.New(cfg.API.AuthServiceURL, 5*time.Second)
	providerLogin := providerLoginAdapter{store: store, delay: watchRequestDelay}
	features := api.FeatureConfig{
		SyncDataAtOnboarding:      cfg.API.Features.SyncDataAtOnboarding,
		CoachAgentWeeklyPlanUsers: toUserSet(cfg.API.Features.CoachAgentWeeklyPlanUsers),
		CoachChatUsers:            toUserSet(cfg.API.Features.CoachChatUsers),
		CoachChatDebugUsers:       toUserSet(cfg.API.Features.CoachChatDebugUsers),
		CoachChatMaxMessageChars:  cfg.API.Features.CoachChatMaxMessageChars,
	}

	svc := api.NewService(api.Config{
		Enqueuer:              enq,
		Jobs:                  store.Jobs(),
		JobsIdem:              store,
		Pipelines:             orch,
		Runs:                  store.Pipelines(),
		RunsIdem:              store,
		JobUserInitiable:      catalog.JobUserInitiable(),
		PipelineUserInitiable: catalog.PipelineUserInitiable(),
		UserStore:             store,
		ProviderLogin:         providerLogin,
		AuthNameSync:          authNameSync,
		Features:              features,
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

	// Derive a browsable local URL from the listen address for the startup log.
	host, port, _ := net.SplitHostPort(cfg.API.Addr)
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	baseURL := fmt.Sprintf("http://%s:%s", host, port)

	log.Info("api server listening",
		zap.String("addr", cfg.API.Addr),
		zap.String("port", port),
		zap.String("url", baseURL),
		zap.Bool("swagger_enabled", cfg.API.SwaggerEnabled),
		zap.Strings("cors_origins", cfg.API.CORSOrigins),
	)
	if cfg.API.SwaggerEnabled {
		log.Info("swagger UI available", zap.String("url", baseURL+"/swagger/index.html"))
	}

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
