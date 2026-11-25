// Subcommand `stride plan-eval`: the training-plan evaluation API (devops#1055).
// An internal administrator service that freezes inputs for a published Coach
// Agent version, hands them to that version's worker over RabbitMQ and judges
// the artifacts with frozen checks. It owns a dedicated MySQL database and
// never touches the production user database. Stays thin: load config, wire
// dependencies, serve until a shutdown signal. All logic lives in internal/.
package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/spf13/cobra"
	"github.com/zhaochy1990/x/logger"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/api"
	"github.com/zhaochy1990/stride/internal/config"
	"github.com/zhaochy1990/stride/internal/health"
	"github.com/zhaochy1990/stride/internal/planeval"
	"github.com/zhaochy1990/stride/internal/storage"
)

func newPlanEvalCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "plan-eval",
		Short: "Run the training-plan evaluation API (admin + eval-worker surfaces)",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runPlanEval()
		},
	}
}

func runPlanEval() error {
	cfg := config.MustLoadPlanEval()
	eval := cfg.PlanEval

	log := logger.MustGetLogger(&cfg.Logger)
	defer func() { _ = log.Sync() }()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The dedicated plan-eval database: provisioned if absent, then its own
	// schema is migrated at boot.
	if err := storage.EnsurePlanEvalDatabase(eval.MySQLDSN); err != nil {
		return err
	}
	store, err := storage.Open(eval.MySQLDSN)
	if err != nil {
		return err
	}
	defer store.Close()
	if err := store.AutoMigratePlanEval(ctx); err != nil {
		return err
	}

	secrets, err := planeval.NewSecretKey(eval.SecretKey)
	if err != nil {
		return err
	}
	broker, err := planeval.NewBroker(eval.AMQPURL, eval.RabbitManagementURL, log)
	if err != nil {
		return err
	}
	defer broker.Close()
	deployer, err := planeval.NewDeployer(eval.Deployer, planeval.KubernetesOptions{
		ImageRepository: eval.WorkerImageRepository,
		PullSecret:      eval.WorkerPullSecret,
		WorkerAPIURL:    eval.WorkerAPIURL,
		WorkerAMQPURL:   eval.WorkerAMQPURL,
		WorkerToken:     eval.WorkerToken,
		Namespace:       eval.KubernetesNamespace,
	})
	if err != nil {
		return err
	}

	svc := planeval.NewService(store, broker, deployer, secrets, planeval.Config{
		AgentVersions:      eval.AgentVersions,
		LeaseTTL:           eval.LeaseTTL,
		RuleTimeout:        eval.RuleTimeout,
		RuleMemoryLimit:    planeval.DefaultRuleMemoryLimit,
		EvaluateSweepEvery: eval.EvaluateSweepInterval,
	}, log)
	if err := svc.SeedPresetFile(ctx, eval.PresetSnapshotPath); err != nil {
		return err
	}

	// Same RS256 key and issuer as stride-api; only the admin audience is
	// admitted — this service has no end-user routes.
	verifier, err := api.NewJWTVerifier(eval.Auth.PublicKeyPath, eval.Auth.Issuer, "", eval.Auth.AdminAudience)
	if err != nil {
		return err
	}
	adminAuth := api.NewAuthenticator("", verifier).RequireAdmin()

	evaluatorDone := make(chan struct{})
	go func() {
		defer close(evaluatorDone)
		svc.RunEvaluator(ctx)
	}()

	gin.SetMode(gin.ReleaseMode)
	router := svc.Router(adminAuth, api.AdminCallerID, eval.WorkerToken, health.Endpoint(map[string]health.Check{
		"mysql": store.Ping,
	}), log)
	srv := &http.Server{Addr: eval.Addr, Handler: router, ReadHeaderTimeout: 10 * time.Second}

	host, port, _ := net.SplitHostPort(eval.Addr)
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	log.Info("plan-eval api server listening",
		zap.String("version", appVersion()),
		zap.String("addr", eval.Addr),
		zap.String("url", "http://"+net.JoinHostPort(host, port)),
		zap.Strings("agent_versions", eval.AgentVersions),
		zap.String("deployer", eval.Deployer),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()

	select {
	case <-ctx.Done():
		log.Info("shutdown signal received, draining")
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		<-evaluatorDone
		return srv.Shutdown(shutCtx)
	case err := <-errCh:
		stop()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}
