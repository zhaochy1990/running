// Package api is the HTTP API server (cmd/api) that fronts the async-job worker
// (ADR 0012). It exposes create/read for Async Jobs and Pipeline Runs over gin,
// with two auth tiers (internal shared secret + end-user RS256 JWT), per-user
// scoping, a shared job-type/pipeline catalog, and day-one idempotency. It owns
// no storage or broker logic — those arrive via the small interfaces below,
// satisfied by internal/storage, internal/job and internal/pipeline.
package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/health"
	"github.com/zhaochy1990/stride/internal/httplog"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
)

// maxRequestBytes caps create request bodies. The API has a public ingress, so
// an unbounded body binding into a MySQL longtext is a DoS/storage-abuse vector.
const maxRequestBytes = 1 << 20 // 1 MiB

// Enqueuer creates a standalone job and publishes its pointer.
type Enqueuer interface {
	Enqueue(ctx context.Context, spec job.EnqueueSpec) (string, error)
}

// JobGetter reads a job's durable state by its globally-unique id.
type JobGetter interface {
	Get(ctx context.Context, jobID string) (*job.Job, error)
}

// JobIdemLookup resolves a job by its idempotency key (dedup + conflict replay).
type JobIdemLookup interface {
	JobByIdempotencyKey(ctx context.Context, userID, key string) (*job.Job, error)
}

// PipelineStarter starts a pipeline run (store-first) with an idempotency key.
// inputJSON is the run-level input threaded into the pipeline's steps ("" for
// pipelines that take none).
type PipelineStarter interface {
	StartPipeline(ctx context.Context, name, userID, createdBy, idempotencyKey, inputJSON string) (string, error)
}

// RunGetter reads a pipeline run's aggregate state by its globally-unique id.
type RunGetter interface {
	Get(ctx context.Context, runID string) (*job.PipelineRun, error)
}

// RunLister lists the pipeline runs for a user (the subject; newest first, capped).
type RunLister interface {
	PipelineRunsByUser(ctx context.Context, userID string) ([]*job.PipelineRun, error)
}

// RunIdemLookup resolves a run by its idempotency key.
type RunIdemLookup interface {
	PipelineRunByIdempotencyKey(ctx context.Context, userID, key string) (*job.PipelineRun, error)
}

// Config wires a Service.
type Config struct {
	Enqueuer  Enqueuer
	Jobs      JobGetter
	JobsIdem  JobIdemLookup
	Pipelines PipelineStarter
	Runs      RunGetter
	RunsList  RunLister
	RunsIdem  RunIdemLookup

	// JobUserInitiable maps job type -> may a user create it; a type absent from
	// the map is unknown (rejected 400). PipelineUserInitiable is the same for
	// pipeline names. Both come from internal/catalog.
	JobUserInitiable      map[string]bool
	PipelineUserInitiable map[string]bool

	// WatchSyncJobType is the job type the POST /api/{user}/sync endpoint
	// enqueues. Injected (from catalog.JobTypeWatchSync) so the api package
	// stays decoupled from internal/catalog, matching the JobCatalog pattern.
	WatchSyncJobType string

	// SyncPipelineFull / SyncPipelineIncremental are the pipeline names POST
	// /api/{user}/sync starts, picked by mode (full -> onboarding, incremental ->
	// data_sync). Injected from internal/catalog for the same decoupling reason.
	SyncPipelineFull        string
	SyncPipelineIncremental string

	// JobCatalog and PipelineCatalog back the discovery endpoints GET /jobs and
	// GET /pipelines (input schema + example per type). Populated from
	// internal/catalog by cmd/api.
	JobCatalog      []JobCatalogEntry
	PipelineCatalog []PipelineCatalogEntry

	// User/onboarding surface (ADR 0013) — a sibling registrar sharing the auth
	// path. Leave zero to run the job/pipeline API only (e.g. in tests).
	UserStore     UserStore
	ProviderLogin ProviderLogin
	ProviderInfo  ProviderInfo
	AuthNameSync  AuthNameSync
	Features      FeatureConfig

	// ActivityStore backs the activity read surface (ADR 0019) — a sibling
	// registrar sharing the auth path. Leave zero to run without the activity
	// endpoints (e.g. in tests that never hit them).
	ActivityStore ActivityStore

	// Race-goal surface (ADR 0021) — a sibling registrar sharing the auth path.
	// Leave zero to run without the training-goal endpoints (e.g. in tests).
	GoalStore GoalStore

	// HealthStore and StrideStore back the training-status metrics read surface
	// (ADR 0023) — two sibling registrars sharing the auth path. HealthStore
	// serves /health, /hrv, /pmc; StrideStore serves /stride/zones and
	// /stride/training-load. Leave zero to run without them (e.g. in tests).
	HealthStore HealthStore
	StrideStore StrideStore

	// Master-plan read surface (ADR 0024) — a sibling registrar sharing the auth
	// path. Leave zero to run without the master-plan endpoints (e.g. in tests).
	MasterPlanStore MasterPlanStore
	WeeklyPlanStore WeeklyPlanStore

	Auth           *Authenticator
	CORSOrigins    []string
	SwaggerEnabled bool
	// Health, when non-empty, backs GET /health with real dependency checks
	// (mysql/broker) so the container HEALTHCHECK restarts a wedged API.
	Health map[string]health.Check
	Logger *zap.Logger
}

// Service holds the wired dependencies and builds the gin router.
type Service struct {
	enq       Enqueuer
	jobs      JobGetter
	jobsIdem  JobIdemLookup
	pipelines PipelineStarter
	runs      RunGetter
	runsList  RunLister
	runsIdem  RunIdemLookup

	jobUserInitiable      map[string]bool
	pipelineUserInitiable map[string]bool

	watchSyncJobType string

	syncPipelineFull        string
	syncPipelineIncremental string

	jobCatalog      []JobCatalogEntry
	pipelineCatalog []PipelineCatalogEntry

	users *userRoutes
	goals *goalRoutes

	activities *activityRoutes

	healthMetrics *healthRoutes
	strideMetrics *strideRoutes
	masterPlan    *masterPlanRoutes
	weeklyPlan    *weeklyPlanRoutes

	auth           *Authenticator
	corsOrigins    []string
	swaggerEnabled bool
	health         map[string]health.Check
	log            *zap.Logger
}

// NewService wires a Service. It panics if Auth is nil (a wiring bug — the API
// must always be able to authenticate).
func NewService(cfg Config) *Service {
	if cfg.Auth == nil {
		panic("api: NewService requires a non-nil Auth")
	}
	log := cfg.Logger
	if log == nil {
		log = logging.Default()
	}
	return &Service{
		enq:                     cfg.Enqueuer,
		jobs:                    cfg.Jobs,
		jobsIdem:                cfg.JobsIdem,
		pipelines:               cfg.Pipelines,
		runs:                    cfg.Runs,
		runsList:                cfg.RunsList,
		runsIdem:                cfg.RunsIdem,
		jobUserInitiable:        cfg.JobUserInitiable,
		pipelineUserInitiable:   cfg.PipelineUserInitiable,
		watchSyncJobType:        cfg.WatchSyncJobType,
		syncPipelineFull:        cfg.SyncPipelineFull,
		syncPipelineIncremental: cfg.SyncPipelineIncremental,
		jobCatalog:              cfg.JobCatalog,
		pipelineCatalog:         cfg.PipelineCatalog,
		users:                   newUserRoutes(cfg.UserStore, cfg.ProviderLogin, cfg.ProviderInfo, cfg.AuthNameSync, cfg.Features, log),
		goals:                   newGoalRoutes(cfg.GoalStore, log),
		activities:              newActivityRoutes(cfg.ActivityStore, log),
		healthMetrics:           newHealthRoutes(cfg.HealthStore, log),
		strideMetrics:           newStrideRoutes(cfg.StrideStore, log),
		masterPlan:              newMasterPlanRoutes(cfg.MasterPlanStore, log),
		weeklyPlan:              newWeeklyPlanRoutes(cfg.WeeklyPlanStore, log),
		auth:                    cfg.Auth,
		corsOrigins:             cfg.CORSOrigins,
		swaggerEnabled:          cfg.SwaggerEnabled,
		health:                  cfg.Health,
		log:                     log,
	}
}

// Router builds the gin engine with middleware, the four authenticated routes,
// a public /health, and (when enabled and built with -tags swagger) the
// Swagger UI at /swagger/*any.
func (s *Service) Router() *gin.Engine {
	r := gin.New()
	r.Use(httplog.Middleware(s.log), gin.Recovery())
	if len(s.corsOrigins) > 0 {
		r.Use(corsMiddleware(s.corsOrigins))
	}

	r.GET("/health", s.healthHandler())
	mountSwagger(r, s.swaggerEnabled)

	// Public discovery: the catalog of supported job types and pipelines (static
	// system metadata, no auth). Distinct from the authed create/read routes.
	r.GET("/jobs", s.listJobs)
	r.GET("/pipelines", s.listPipelines)

	authed := r.Group("", limitBody(maxRequestBytes), s.auth.middleware())
	authed.POST("/jobs", s.createJob)
	authed.GET("/jobs/:job_id", s.getJob)
	authed.POST("/pipelines", s.startPipeline)
	authed.GET("/pipelines/:run_id", s.getPipelineRun)
	authed.GET("/api/pipelines/:run_id", s.getPipelineRun)
	authed.GET("/api/users/:uid/pipelines", s.listUserPipelines)
	authed.POST("/api/:user/sync", s.syncUser)
	s.users.register(authed)
	s.activities.register(authed)
	s.goals.register(authed)
	s.healthMetrics.register(authed)
	s.strideMetrics.register(authed)
	s.masterPlan.register(authed)
	s.weeklyPlan.register(authed)
	return r
}

// healthHandler reports real dependency health when checks are wired, else a
// static liveness OK (used in tests).
func (s *Service) healthHandler() gin.HandlerFunc {
	if len(s.health) > 0 {
		return health.Endpoint(s.health)
	}
	return func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) }
}

// limitBody caps the request body size (public ingress hardening).
func limitBody(max int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, max)
		c.Next()
	}
}

// resolveUserID returns the subject a create request targets: for the user tier
// it is always the JWT sub (client value ignored, ADR 0012); for the internal
// tier it is the client-supplied value, defaulting to empty (a system job/run,
// stored as NULL).
func resolveUserID(caller Caller, requested string) string {
	if caller.Tier == TierUser {
		return caller.UserID
	}
	return requested
}

// resolveCreatedBy returns the actor to record as the record's creator (pure
// provenance): the JWT sub for the user tier, or empty (NULL) for internal
// callers.
func resolveCreatedBy(caller Caller) string {
	if caller.Tier == TierUser {
		return caller.UserID
	}
	return ""
}

// zapErr wraps an error as a structured log field.
func zapErr(err error) zap.Field { return zap.Error(err) }

// corsMiddleware is a minimal allow-list CORS for the direct-browser tier.
func corsMiddleware(origins []string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(origins))
	for _, o := range origins {
		allowed[o] = true
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		c.Header("Vary", "Origin")
		if origin != "" && allowed[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Methods", strings.Join([]string{
				http.MethodGet,
				http.MethodPost,
				http.MethodPut,
				http.MethodPatch,
				http.MethodDelete,
				http.MethodOptions,
			}, ", "))
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Internal-Token, Idempotency-Key")
			c.Header("Access-Control-Max-Age", "600")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
