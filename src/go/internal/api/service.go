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
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/health"
	"github.com/zhaochy1990/stride/internal/httplog"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/webhook"
)

// maxRequestBytes caps authenticated request bodies. The API has a public
// ingress, so an unbounded body binding into MySQL longtext is a DoS/storage-
// abuse vector.
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

// JobCreator persists a job row without publishing (the internal plan-job
// surface, ADR 0033 — the caller owns the broker pointer).
type JobCreator interface {
	Create(ctx context.Context, j *job.Job) error
}

// JobTransitioner applies a compare-and-set state change to a job row (ADR 0033).
type JobTransitioner interface {
	TransitionJob(ctx context.Context, jobID string, tr job.JobTransition) (*job.Job, error)
}

// JobStaleRunner fails running jobs whose heartbeat is older than a window,
// scoped to the caller's own job types.
type JobStaleRunner interface {
	FailStaleRunningJobs(ctx context.Context, olderThan, now time.Time, errorCode string, jobTypes []string) (int64, error)
}

// JobAdminLister lists standalone jobs across all users (admin async surface).
type JobAdminLister interface {
	ListAllJobs(ctx context.Context, opts job.PipelineListOptions) ([]*job.Job, int64, error)
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

// RunAdminLister lists pipeline runs across all users (admin surface), newest
// first, filtered + paginated, with the total matching count.
type RunAdminLister interface {
	ListAllPipelineRuns(ctx context.Context, opts job.PipelineListOptions) ([]*job.PipelineRun, int64, error)
}

// RunIdemLookup resolves a run by its idempotency key.
type RunIdemLookup interface {
	PipelineRunByIdempotencyKey(ctx context.Context, userID, key string) (*job.PipelineRun, error)
}

// Config wires a Service.
type Config struct {
	Enqueuer       Enqueuer
	Jobs           JobGetter
	JobsIdem       JobIdemLookup
	JobsCreate     JobCreator
	JobsTransition JobTransitioner
	JobsStale      JobStaleRunner
	JobsAdminList  JobAdminLister
	Pipelines      PipelineStarter
	Runs           RunGetter
	RunsList       RunLister
	RunsAdminList  RunAdminLister
	RunsIdem       RunIdemLookup

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
	UserStore      UserStore
	InjuryStore    InjuryStore
	ProviderLogin  ProviderLogin
	ProviderInfo   ProviderInfo
	AuthNameSync   AuthNameSync
	AccountDeleter AccountDeleter
	Features       FeatureConfig

	// Account-erasure orchestration (admin delete + self-delete). AdminAccountDeleter
	// forwards an administrator bearer to the auth-service admin endpoint;
	// CoachDataDeleter drives the coach service; UserDataDirRemover clears the
	// on-disk data directory; DeletionAuditStore records the per-step trail. All
	// are optional for tests that never exercise deletion.
	AdminAccountDeleter AdminAccountDeleter
	CoachDataDeleter    CoachDataDeleter
	UserDataDirRemover  UserDataDirRemover
	DeletionAuditStore  DeletionAuditStore

	// ActivityStore backs the activity read surface (ADR 0019) — a sibling
	// registrar sharing the auth path. Leave zero to run without the activity
	// endpoints (e.g. in tests that never hit them).
	ActivityStore ActivityStore

	// TeamAuth and TeamStore back the team/social surface. TeamAuth owns teams and
	// memberships; TeamStore owns MySQL activity aggregates, profiles, and likes.
	TeamAuth  TeamAuthService
	TeamStore TeamStore

	// Race-goal surface (ADR 0021) — a sibling registrar sharing the auth path.
	// Leave zero to run without the training-goal endpoints (e.g. in tests).
	GoalStore GoalStore

	// HealthStore and StrideStore back the training-status metrics read surface
	// (ADR 0023) — two sibling registrars sharing the auth path. HealthStore
	// serves /health, /hrv, /pmc; StrideStore serves /stride/zones and
	// /stride/training-load. Leave zero to run without them (e.g. in tests).
	HealthStore HealthStore
	StrideStore StrideStore
	// PBStore backs the personal-best read surface (GET /api/{user}/pbs), a
	// sibling registrar sharing the auth path. Leave zero to run without it.
	PBStore PBStore
	// RaceStore backs the user-facing race-effort read surface
	// (GET /api/{user}/races), a sibling registrar sharing the auth path. Leave
	// zero to run without it.
	RaceStore RaceStore
	// BodyCompositionStore backs the body-composition read/write surface
	// (list / summary / single / upsert). User-entered (OCR/manual), not
	// watch-synced. Leave zero to run without it (e.g. in tests).
	BodyCompositionStore BodyCompositionStore

	// AbilityStore and PredictionStore back the ability-score / race-prediction
	// read surfaces. AbilityBackfillJobType is the job type POST
	// /api/{user}/ability/backfill enqueues (injected from catalog for the same
	// decoupling as WatchSyncJobType). Leave zero to run without them.
	AbilityStore           AbilityStore
	PredictionStore        PredictionStore
	AbilityBackfillJobType string

	// Master-plan read surface (ADR 0024) — a sibling registrar sharing the auth
	// path. Leave zero to run without the master-plan endpoints (e.g. in tests).
	MasterPlanStore MasterPlanStore
	WeeklyPlanStore WeeklyPlanStore

	// Compliance declarations (user agreement / privacy policy / …). A public
	// read surface plus an admin-only maintenance surface. Leave zero to run
	// without the declaration endpoints (e.g. in tests).
	LegalDocumentStore LegalDocumentStore

	// Race calendar admin surface (source-synced race events + items).
	// Administrator-only CRUD the Dashboard races tab drives. Leave zero to run
	// without the race endpoints (e.g. in tests).
	RaceCalendarStore RaceCalendarStore
	// RaceFavoriteStore and RacePlanStore back the user-facing race engagement
	// surface (issue #391): 收藏 + 参赛计划. Two sibling registrars sharing the
	// auth path. Leave zero to run without them (e.g. in tests).
	RaceFavoriteStore RaceFavoriteStore
	RacePlanStore     RacePlanStore
	// CustomRaceStore backs the「我的比赛」custom-race surface (#474): user-added
	// races outside race_calendar, plus the my-races aggregate. Shares the
	// RacePlanStore port for the aggregate. Leave zero to run without it.
	CustomRaceStore UserCustomRaceStore
	// WorkoutStore backs the unified workout surface (devops#586): the
	// three-source plan/sessions projection and custom-workout CRUD. Leave
	// zero to run without those endpoints.
	WorkoutStore WorkoutStore
	// RoadmapStore backs the product-roadmap surface (devops#551): the user
	// read/vote endpoints plus the administrator feature maintenance. Leave
	// zero to run without the roadmap endpoints.
	RoadmapStore RoadmapStore
	// FeedbackStore backs the user-feedback surface (devops#552): upload,
	// thread endpoints and admin queue. Leave zero to run without the
	// feedback endpoints.
	FeedbackStore FeedbackStore
	// FeedbackImages is the bucket surface for the upload endpoint and URL
	// building (satisfied by *cos.Client); also drives the fail-open COS
	// sweep during account erasure. Leave zero to answer uploads 503.
	FeedbackImages FeedbackImages
	// RaceStrategyStore backs the race-strategy surface (#396): the coach's
	// structured strategy per (user, race), written by the TS coach API via the
	// internal endpoint and read/edited by the runner. Leave zero to run
	// without it (e.g. in tests).
	RaceStrategyStore RaceStrategyStore
	// RaceItemGeocoder optionally resolves race-calendar venue names to WGS84
	// coordinates when item content carries a name but no coordinates. Nil
	// disables geocoding (see race_calendar.go).
	RaceItemGeocoder RaceItemGeocoder

	// Race content maintenance surface (city/race/project structured content,
	// issue #318). Administrator-only. Leave zero to run without the content
	// endpoints (e.g. in tests).
	RaceContentStore RaceContentStore

	// User-facing race catalog (issue #390): published-only reads for the
	// 小程序 race center. Leave zero to run without the endpoints.
	RaceCatalogStore RaceCatalogStore

	// CityAIDraft configures the AI city-content draft generator (issue #332).
	// Leave zero to keep the ai-draft endpoint answering 501
	// ai_draft_not_configured.
	CityAIDraft CityAIDraftConfig

	// WorkoutPusher pushes normalized workouts to the user's bound watch
	// provider (satisfied by the cmd-layer adapter over registry).
	WorkoutPusher WorkoutPusher
	// PushedScheduleReader annotates the unified read with per-row push state
	// (same store; separate narrow interface for partial test services).
	PushedScheduleReader PushedScheduleReader
	// ScheduledWorkoutStore records device execution state after a push
	// (satisfied by *storage.Store).
	ScheduledWorkoutStore ScheduledWorkoutStore

	// Watch-provider event-push surface (devops#287). WebhookAdapters is the
	// provider registry (key = Adapter.Provider); empty or nil leaves the
	// push route unmounted-404 per provider. WebhookEventStore persists the
	// events; nil disables the surface entirely (tests running a partial
	// service). WebhookUserResolver maps provider accounts to STRIDE users
	// (optional; nil resolves nothing until the auth-service query ships).
	// WebhookFetchJobType is injected from internal/catalog like
	// WatchSyncJobType; WebhookEnqueueEnabled is the enqueue gate
	// (catalog.JobTypeProviderActivityFetch documents why it starts off).
	WebhookAdapters       map[string]webhook.Adapter
	WebhookEventStore     WebhookEventStore
	WebhookUserResolver   ProviderUserResolver
	WebhookFetchJobType   string
	WebhookEnqueueEnabled bool

	// SyncUserLister backs GET /api/internal/sync-users (devops#661): the
	// internal-tier user list for the daily/weekly sync workflows. Satisfied by
	// *storage.Store; leave zero to answer 503.
	SyncUserLister SyncUserLister

	// SyncUserAuditor backs GET /api/internal/sync-user-orphans (devops#663):
	// the weekly erasure-residue audit. Satisfied by *storage.Store; leave
	// zero to answer 503.
	SyncUserAuditor SyncUserAuditor

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
	enq            Enqueuer
	jobs           JobGetter
	jobsIdem       JobIdemLookup
	jobsCreate     JobCreator
	jobsTransition JobTransitioner
	jobsStale      JobStaleRunner
	jobsAdminList  JobAdminLister
	pipelines      PipelineStarter
	runs           RunGetter
	runsList       RunLister
	runsAdminList  RunAdminLister
	runsIdem       RunIdemLookup

	jobUserInitiable      map[string]bool
	pipelineUserInitiable map[string]bool

	watchSyncJobType string

	syncPipelineFull        string
	syncPipelineIncremental string

	jobCatalog      []JobCatalogEntry
	pipelineCatalog []PipelineCatalogEntry

	users *userRoutes
	goals *goalRoutes

	adminUsers *adminUserRoutes

	activities *activityRoutes
	teams      *teamRoutes

	healthMetrics   *healthRoutes
	strideMetrics   *strideRoutes
	pbs             *pbsRoutes
	races           *raceRoutes
	bodyComposition *bodyCompositionRoutes
	ability         *abilityRoutes
	predictions     *predictionRoutes
	masterPlan      *masterPlanRoutes
	weeklyPlan      *weeklyPlanRoutes
	legalDocuments  *legalDocumentRoutes
	raceCalendar    *raceCalendarRoutes
	raceFavorites   *raceFavoriteRoutes
	racePlans       *racePlanRoutes
	customRaces     *customRaceRoutes
	roadmap         *roadmapRoutes
	feedback        *feedbackRoutes
	raceStrategy    *raceStrategyRoutes
	raceContent     *raceContentRoutes
	raceCatalog     *raceCatalogRoutes
	workouts        *workoutRoutes
	sharedWorkouts  *sharedWorkoutRoutes
	webhook         *webhookRoutes

	syncUserLister  SyncUserLister
	syncUserAuditor SyncUserAuditor

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
	eraser := newAccountEraser(cfg.UserStore, cfg.AccountDeleter, cfg.AdminAccountDeleter, cfg.CoachDataDeleter, cfg.UserDataDirRemover, cfg.DeletionAuditStore, log)
	// Account erasure sweeps the bucket fail-open when the feedback image
	// client is wired (devops#552); without it the sweep is skipped. eraser
	// is nil in feedback-only test services (no UserStore).
	if eraser != nil {
		if cosDeleter, ok := cfg.FeedbackImages.(COSObjectDeleter); ok {
			eraser.cosDelete = cosDeleter
		}
	}
	return &Service{
		enq:                     cfg.Enqueuer,
		jobs:                    cfg.Jobs,
		jobsIdem:                cfg.JobsIdem,
		jobsCreate:              cfg.JobsCreate,
		jobsTransition:          cfg.JobsTransition,
		jobsStale:               cfg.JobsStale,
		jobsAdminList:           cfg.JobsAdminList,
		pipelines:               cfg.Pipelines,
		runs:                    cfg.Runs,
		runsList:                cfg.RunsList,
		runsAdminList:           cfg.RunsAdminList,
		runsIdem:                cfg.RunsIdem,
		jobUserInitiable:        cfg.JobUserInitiable,
		pipelineUserInitiable:   cfg.PipelineUserInitiable,
		watchSyncJobType:        cfg.WatchSyncJobType,
		syncPipelineFull:        cfg.SyncPipelineFull,
		syncPipelineIncremental: cfg.SyncPipelineIncremental,
		jobCatalog:              cfg.JobCatalog,
		pipelineCatalog:         cfg.PipelineCatalog,
		users:                   newUserRoutes(cfg.UserStore, cfg.InjuryStore, cfg.ProviderLogin, cfg.ProviderInfo, cfg.AuthNameSync, eraser, cfg.Features, cfg.Runs, log),
		goals:                   newGoalRoutes(cfg.GoalStore, log),
		adminUsers:              newAdminUserRoutes(eraser, log),
		activities:              newActivityRoutes(cfg.ActivityStore, log),
		teams:                   newTeamRoutes(cfg.TeamAuth, cfg.TeamStore, cfg.ActivityStore, log),
		healthMetrics:           newHealthRoutes(cfg.HealthStore, log),
		strideMetrics:           newStrideRoutes(cfg.StrideStore, log),
		pbs:                     newPbsRoutes(cfg.PBStore, log),
		races:                   newRaceRoutes(cfg.RaceStore, log),
		bodyComposition:         newBodyCompositionRoutes(cfg.BodyCompositionStore, log),
		ability:                 newAbilityRoutes(cfg.AbilityStore, cfg.Enqueuer, cfg.AbilityBackfillJobType, log),
		predictions:             newPredictionRoutes(cfg.PredictionStore, log),
		masterPlan:              newMasterPlanRoutes(cfg.MasterPlanStore, log),
		weeklyPlan:              newWeeklyPlanRoutes(cfg.WeeklyPlanStore, cfg.WorkoutPusher, cfg.ScheduledWorkoutStore, cfg.BodyCompositionStore, log),
		legalDocuments:          newLegalDocumentRoutes(cfg.LegalDocumentStore, log),
		raceCalendar:            newRaceCalendarRoutes(cfg.RaceCalendarStore, cfg.RaceContentStore, log, cfg.RaceItemGeocoder),
		raceFavorites:           newRaceFavoriteRoutes(cfg.RaceFavoriteStore, log),
		racePlans:               newRacePlanRoutes(cfg.RacePlanStore, log),
		customRaces:             newCustomRaceRoutes(cfg.CustomRaceStore, cfg.RacePlanStore, log),
		roadmap:                 newRoadmapRoutes(cfg.RoadmapStore, log),
		feedback:                newFeedbackRoutes(cfg.FeedbackStore, cfg.FeedbackImages, cfg.RoadmapStore, log),
		raceStrategy:            newRaceStrategyRoutes(cfg.RaceStrategyStore, log),
		raceContent:             newRaceContentRoutes(cfg.RaceContentStore, cfg.CityAIDraft, log),
		raceCatalog:             newRaceCatalogRoutes(cfg.RaceCatalogStore, log),
		workouts:                newWorkoutRoutes(cfg.WorkoutStore, cfg.WorkoutPusher, cfg.ScheduledWorkoutStore, cfg.PushedScheduleReader, log),
		sharedWorkouts:          newSharedWorkoutRoutes(cfg.WorkoutStore, log),
		webhook:                 newWebhookRoutes(cfg.WebhookAdapters, cfg.WebhookEventStore, cfg.WebhookUserResolver, cfg.Enqueuer, cfg.WebhookFetchJobType, cfg.WebhookEnqueueEnabled, log),
		syncUserLister:          cfg.SyncUserLister,
		syncUserAuditor:         cfg.SyncUserAuditor,
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
	// Deployment probes this before enabling the Web onboarding Go-route flags.
	// It contains no user or deployment-secret data.
	r.GET("/api/readyz/onboarding", s.onboardingReadiness)
	r.GET("/api/readyz/plan-setup", s.planSetupReadiness)
	r.GET("/api/readyz/body-composition", s.bodyCompositionReadiness)
	// Compliance declarations: readable before login (the app shows the
	// agreements on the sign-up screen), and only ever the published versions.
	s.legalDocuments.registerPublic(r)
	// Strategy share link (#506): read-only, the UUID triple is the access
	// boundary — the viewer may not be logged in.
	s.raceStrategy.registerPublic(r)
	// Workout share link (devops#701): read-only, the (user, workout) UUID
	// pair is the access boundary — the viewer may not be logged in.
	s.sharedWorkouts.registerPublic(r)
	// Watch-provider event-push ingress (devops#287): public, verified by
	// each provider's own credentials (header constants), never a JWT caller.
	s.webhook.register(r)

	authenticated := r.Group("", limitBody(maxRequestBytes), s.auth.middleware())
	// Plan routes explicitly admit the separate admin JWT tier. The master-plan
	// /me handler still rejects it; only the narrow Weekly/Master Plan import
	// and update routes may mutate data outside the default-deny child group below.
	s.masterPlan.register(authenticated)
	s.masterPlan.registerAdminWrites(authenticated)
	s.weeklyPlan.registerReads(authenticated)
	s.weeklyPlan.registerAdminWrites(authenticated)
	// Admin pipeline-status surface: global list + any-run detail. Mounted on
	// the authenticated group (NOT the rejectAdminCaller child) so the admin
	// JWT tier can use them; the handlers admit admin OR internal and deny users.
	authenticated.GET("/api/admin/pipeline-runs", s.listAdminPipelineRuns)
	authenticated.GET("/api/admin/pipeline-runs/:run_id", s.getAdminPipelineRun)
	// Unified admin async view: pipeline runs + standalone plan jobs together.
	authenticated.GET("/api/admin/async-runs", s.listAdminAsyncRuns)
	// Administrator account erasure: mounted on the parent group so the admin JWT
	// tier can enter; the handler rejects user/internal callers itself.
	s.adminUsers.register(authenticated)
	// Declaration maintenance is administrator-only; the handlers re-check the
	// tier, so mounting on the parent group only admits TierAdmin.
	s.legalDocuments.registerAdmin(authenticated)
	// Race-calendar management is administrator-only for the same reason.
	s.raceCalendar.register(authenticated)
	// Race-content maintenance is administrator-only for the same reason.
	s.raceContent.register(authenticated)
	// Product-roadmap feature maintenance is administrator-only (same tier
	// guard as the race-calendar admin tab); handlers re-check.
	s.roadmap.registerAdmin(authenticated)
	// Feedback admin queue is administrator-only for the same reason.
	s.feedback.registerAdmin(authenticated)
	// Feedback image upload carries a larger body cap than the shared
	// authenticated group (10MB contract), so it mounts its own chain.
	s.feedback.registerUpload(r, s.auth)

	// Existing routes accept only the original user/internal tiers. Keeping this
	// default deny prevents an admin-dashboard token from silently inheriting
	// user or server-to-server capabilities.
	authed := authenticated.Group("", rejectAdminCaller)
	authed.POST("/jobs", s.createJob)
	authed.GET("/jobs/:job_id", s.getJob)
	authed.GET("/api/jobs/:job_id", s.getJob)
	// Internal plan-job surface (ADR 0033): the TS worker + Coach API keep the
	// jobs table as the single async state store through Go, never directly.
	authed.POST("/api/internal/jobs", s.createInternalJob)
	authed.GET("/api/internal/jobs/:job_id", s.getInternalJob)
	authed.POST("/api/internal/jobs/:job_id/transition", s.transitionJob)
	authed.POST("/api/internal/jobs/stale-running", s.failStaleRunningJobs)
	// Internal-tier sync user list (devops#661): the daily/weekly GHA
	// workflows' user source, replacing data/.slug_aliases.json.
	authed.GET("/api/internal/sync-users", s.listSyncUsers)
	// Erasure-residue audit (devops#663): orphans the weekly guard alerts on.
	authed.GET("/api/internal/sync-user-orphans", s.listOrphanSyncUsers)
	authed.POST("/pipelines", s.startPipeline)
	authed.GET("/pipelines/:run_id", s.getPipelineRun)
	authed.GET("/api/pipelines/:run_id", s.getPipelineRun)
	authed.GET("/api/users/:user_id/pipelines", s.listUserPipelines)
	authed.POST("/api/:user/sync", s.syncUser)
	// User-facing race catalog (issue #390): published-only reads for the
	// 小程序 race center, on the default-deny group — the admin tier reaches
	// the same rows through /api/admin/races.
	s.raceCatalog.register(authed)
	s.users.register(authed)
	s.activities.register(authed)
	s.teams.register(authed)
	s.goals.register(authed)
	s.healthMetrics.register(authed)
	s.strideMetrics.register(authed)
	s.pbs.register(authed)
	s.races.register(authed)
	// Race engagement (收藏 + 参赛计划): user-tier "me" endpoints, same group as
	// the sibling user surfaces.
	s.raceFavorites.register(authed)
	s.racePlans.register(authed)
	s.customRaces.register(authed)
	// Unified workout surface (devops#586): same default-deny group as the
	// sibling user-tier "me" endpoints.
	s.workouts.register(authed)
	s.raceStrategy.register(authed)
	// Product-roadmap user surface: read + vote, user-tier only (the admin
	// tier has its own maintenance endpoints above).
	s.roadmap.registerUser(authed)
	// User-feedback threads: same default-deny group (the admin tier reads
	// through /api/admin/feedbacks above).
	s.feedback.registerUser(authed)
	s.bodyComposition.register(authed)
	s.ability.register(authed)
	s.predictions.register(authed)
	s.weeklyPlan.registerWrites(authed)
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
