// Package catalog is the shared source of truth for the job types and pipelines
// the system knows about, plus whether an end user may initiate each one. Both
// cmd/worker (which registers the matching handlers) and cmd/api (which
// validates create requests and builds the pipeline registry) import it.
//
// The API process cannot consult the worker's live handler registry — it runs
// in a different binary — so this catalog is the API-side source of truth for
// "is this a valid name" and "may a user create it". Job-type names here MUST
// match the handler names registered in cmd/worker; a name present here but not
// registered will pass the API's 400 check yet poison at dispatch (ADR 0012).
package catalog

import (
	"encoding/json"

	"github.com/zhaochy1990/stride/internal/pipeline"
)

// Canonical job-type names. Keep in sync with cmd/worker's registerHandlers.
const (
	// JobTypeHello is the deploy smoke handler (internal-only).
	JobTypeHello = "hello"
	// JobTypeWatchSync syncs one user's watch data; a user may trigger their own.
	JobTypeWatchSync = "watch_sync"
	// JobTypeCalibration computes the 180-day athlete baseline (HRmax/LTHR/
	// threshold/RHR/CP + zones). Internal-only: it is a step of the onboarding
	// pipeline and (later) a weekly job.
	JobTypeCalibration = "calibration"
	// JobTypeCompute derives per-activity load, daily PMC and PBs from synced data
	// + the latest calibration. Mode-aware (full|incremental). Internal-only: it is
	// the compute step of the data_sync / onboarding pipelines.
	JobTypeCompute = "compute"
	// JobTypeAbility computes + persists the 4-layer ability snapshot for a
	// Shanghai day. Mode-aware (full|backfill). Internal-only: it is a step of the
	// sync pipelines (ability failure must not fail the sync).
	JobTypeAbility = "ability"
	// JobTypeRaceDetection classifies synced HM/FM-distance outdoor/track runs.
	// It is optional inside sync pipelines: terminal failure remains observable
	// on the step while the pipeline advances to deterministic compute.
	JobTypeRaceDetection = "race_detection"
	// JobTypeRaceDetectionBackfill is the internal one-time all-history scan.
	JobTypeRaceDetectionBackfill = "race_detection_backfill"
	// JobTypeRouteThumbnails renders each newly synced outdoor activity's GPS
	// trace into a route-thumbnail PNG in COS and records the polyline plus the
	// PNG URL on the activity. Optional inside sync pipelines: thumbnails are
	// cosmetic, so a terminal failure stays observable on its step while the
	// pipeline advances.
	JobTypeRouteThumbnails = "route_thumbnails"
	// JobTypeRouteThumbnailsBackfill is the internal one-time all-history scan
	// that fills in thumbnails for activities synced before the feature existed.
	JobTypeRouteThumbnailsBackfill = "route_thumbnails_backfill"
	// JobTypeCompetitionCalendar syncs the external World Athletics competition
	// calendar (label road races) into the competition_calendar table. It is a
	// system job (no subject user): internal-only, the single step of the
	// competition_calendar_sync pipeline started by the daily cron workflow.
	JobTypeCompetitionCalendar = "competition_calendar_sync"
)

// Pipeline names (ADR 0020). onboarding and data_sync are fronted by
// POST /api/{user}/sync, which picks by mode; competition_calendar_sync is an
// internal system pipeline started by the daily cron workflow.
const (
	// PipelineOnboarding is the full path: watch_sync(full) -> optional
	// race_detection -> calibration -> compute(full). New-user onboarding and
	// any explicit full resync.
	PipelineOnboarding = "onboarding"
	// PipelineDataSync is the ongoing incremental path: watch_sync(incremental)
	// -> optional race_detection -> compute(incremental).
	PipelineDataSync = "data_sync"
	// PipelineCompetitionCalendar mirrors the World Athletics label-road-races
	// calendar into competition_calendar. Internal-only (system run, no subject
	// user); the daily cron workflow starts it via POST /pipelines.
	PipelineCompetitionCalendar = "competition_calendar_sync"
)

// JobSpec is one known job type and whether end users may enqueue it directly.
// Description, InputSchema (JSON Schema for the job's InputJSON) and ExampleInput
// are documentation surfaced by the API's GET /jobs discovery endpoint.
type JobSpec struct {
	Type          string
	UserInitiable bool
	Description   string
	InputSchema   json.RawMessage
	ExampleInput  json.RawMessage
}

// PipelineSpec is one known pipeline (its linear step definition) and whether
// end users may start it. Description/InputSchema/ExampleInput document it for
// the API's GET /pipelines discovery endpoint.
type PipelineSpec struct {
	Def           pipeline.Def
	UserInitiable bool
	Description   string
	InputSchema   json.RawMessage
	ExampleInput  json.RawMessage
}

// Jobs returns every job type the API accepts. Unknown types are rejected 400.
func Jobs() []JobSpec {
	return []JobSpec{
		{
			Type:          JobTypeHello,
			UserInitiable: false,
			Description:   "Deploy smoke handler: echoes the input back in result_json. Internal-only.",
			InputSchema:   json.RawMessage(`{"type":"object","description":"Arbitrary JSON; echoed back verbatim in result_json.","additionalProperties":true}`),
			ExampleInput:  json.RawMessage(`{"message":"hello world"}`),
		},
		{
			Type:          JobTypeWatchSync,
			UserInitiable: true,
			Description:   "Sync one user's watch data (activities + health) from their linked provider. user_id is the subject athlete; the input body is optional.",
			InputSchema:   json.RawMessage(`{"type":"object","properties":{"mode":{"type":"string","enum":["full","incremental"],"default":"full","description":"Sync mode."},"content":{"type":"string","enum":["all","activities","health"],"default":"all","description":"Which data to sync."},"limit":{"type":"integer","minimum":0,"default":0,"description":"Max items to sync; 0 means unlimited."}},"additionalProperties":false}`),
			ExampleInput:  json.RawMessage(`{"mode":"incremental","content":"activities","limit":50}`),
		},
		{
			Type:          JobTypeCalibration,
			UserInitiable: false,
			Description:   "Compute the 180-day athlete baseline (HRmax/LTHR/threshold pace/RHR/critical power + zones) from synced data. No input body; operates on the job's user_id (subject UUID). Internal-only.",
			InputSchema:   json.RawMessage(`{"type":"object","description":"No input fields; operates on the job's user_id (subject UUID).","additionalProperties":false}`),
			ExampleInput:  json.RawMessage(`{}`),
		},
		{
			Type:          JobTypeRaceDetection,
			UserInitiable: false,
			Description:   "Classify newly synced outdoor/track half-marathon and marathon distance candidates and persist confirmed activity references. Internal optional pipeline step.",
			InputSchema:   json.RawMessage(`{"type":"object","properties":{"mode":{"type":"string"},"label_ids":{"type":"array","items":{"type":"string"}}},"additionalProperties":true}`),
			ExampleInput:  json.RawMessage(`{"mode":"incremental","label_ids":["a1b2"]}`),
		},
		{
			Type:          JobTypeRaceDetectionBackfill,
			UserInitiable: false,
			Description:   "One-time all-history race detection backfill for one athlete. Skips activities already referenced by races. Internal-only.",
			InputSchema:   json.RawMessage(`{"type":"object","additionalProperties":false}`),
			ExampleInput:  json.RawMessage(`{}`),
		},
		{
			Type:          JobTypeRouteThumbnails,
			UserInitiable: false,
			Description:   "Render the subject athlete's outdoor activities into route-thumbnail PNGs stored in COS, recording the polyline and PNG URL on each activity. Only activities that still lack a thumbnail are touched, so the step is a cheap no-op on a routine sync. Internal optional pipeline step; with an empty COS config it skips itself and reports why.",
			InputSchema:   json.RawMessage(`{"type":"object","additionalProperties":false}`),
			ExampleInput:  json.RawMessage(`{}`),
		},
		{
			Type:          JobTypeRouteThumbnailsBackfill,
			UserInitiable: false,
			Description:   "All-history route-thumbnail backfill for one athlete: fills in activities that have no thumbnail yet. Pass {\"force\":true} to also regenerate activities that already have one, which is what a rendering-algorithm change needs — the default selection skips finished work on purpose. Internal-only.",
			InputSchema:   json.RawMessage(`{"type":"object","properties":{"force":{"type":"boolean","default":false,"description":"Regenerate activities that already have a thumbnail instead of only filling the gaps. Object keys are per-activity, so this overwrites in place."}},"additionalProperties":false}`),
			ExampleInput:  json.RawMessage(`{"force":true}`),
		},
		{
			Type:          JobTypeCompute,
			UserInitiable: false,
			Description:   "Derive per-activity training load, daily PMC (CTL/ATL/Form) and personal bests from synced data and the latest calibration snapshot. Mode-aware: full recomputes the window; incremental only touches this sync's new activities (label_ids). Internal-only.",
			InputSchema:   json.RawMessage(`{"type":"object","properties":{"mode":{"type":"string","enum":["full","incremental"],"default":"full"},"label_ids":{"type":"array","items":{"type":"string"},"description":"Incremental only: the activities this sync produced."}},"additionalProperties":true}`),
			ExampleInput:  json.RawMessage(`{"mode":"incremental","label_ids":["a1b2"]}`),
		},
		{
			Type:          JobTypeAbility,
			UserInitiable: false,
			Description:   "Compute + persist the 4-layer ability snapshot (L1 quality / L2 freshness / L3 six dimensions / L4 composite + marathon/half estimates) for the subject athlete. Mode-aware: full computes the current Shanghai day; backfill seeds the last `days` days. Internal-only.",
			InputSchema:   json.RawMessage(`{"type":"object","properties":{"mode":{"type":"string","enum":["full","backfill"],"default":"full"},"days":{"type":"integer","minimum":1,"maximum":365},"ref_date":{"type":"string","format":"date"}},"additionalProperties":false}`),
			ExampleInput:  json.RawMessage(`{"mode":"backfill","days":180}`),
		},
		{
			Type:          JobTypeCompetitionCalendar,
			UserInitiable: false,
			Description:   "Mirror the World Athletics label-road-races calendar into the competition_calendar table. System job (no subject user). Seasons come from the input {\"seasons\":[...]}, else the configured defaults, else the current Shanghai year. Internal-only; the daily cron workflow starts it via the competition_calendar_sync pipeline.",
			InputSchema:   json.RawMessage(`{"type":"object","properties":{"seasons":{"type":"array","items":{"type":"string"},"description":"World Athletics seasons (calendar years) to fetch. Empty uses the configured defaults / current Shanghai year."}},"additionalProperties":false}`),
			ExampleInput:  json.RawMessage(`{"seasons":["2026"]}`),
		},
	}
}

// Pipelines returns every pipeline the API can start. Both are fronted by POST
// /api/{user}/sync (which picks by mode) and are user-initiable — a browser/app
// triggers a run for its own user_id (the subject; ADR 0012 / 0020). Their step
// job types MUST be registered as handlers in cmd/worker. The run-level input
// {mode,content,limit} is threaded into each step (the sync step reads mode;
// race_detection and compute read mode + the upstream label_ids).
func Pipelines() []PipelineSpec {
	syncInputSchema := json.RawMessage(`{"type":"object","properties":{"mode":{"type":"string","enum":["full","incremental"]},"content":{"type":"string","enum":["all","activities","health"]},"limit":{"type":"integer","minimum":0}},"additionalProperties":false}`)
	return []PipelineSpec{
		{
			Def: pipeline.Def{
				Name: PipelineOnboarding,
				Steps: []pipeline.StepDef{
					{Name: "sync", JobType: JobTypeWatchSync},
					{Name: "race_detection", JobType: JobTypeRaceDetection, ContinueOnFailure: true},
					{Name: "calibration", JobType: JobTypeCalibration},
					{Name: "compute", JobType: JobTypeCompute},
					{Name: "route_thumbnails", JobType: JobTypeRouteThumbnails, ContinueOnFailure: true},
					{Name: "ability", JobType: JobTypeAbility, ContinueOnFailure: true},
				},
			},
			UserInitiable: true,
			Description:   "Full path (new-user onboarding or explicit full resync): a full watch sync, optional race detection, the athlete baseline, a full load/PMC/PB compute, then route thumbnails. Race-detection and thumbnail failures remain visible on their steps but do not fail the pipeline. The run's user_id is the subject athlete.",
			InputSchema:   syncInputSchema,
			ExampleInput:  json.RawMessage(`{"mode":"full"}`),
		},
		{
			Def: pipeline.Def{
				Name: PipelineDataSync,
				Steps: []pipeline.StepDef{
					{Name: "sync", JobType: JobTypeWatchSync},
					{Name: "race_detection", JobType: JobTypeRaceDetection, ContinueOnFailure: true},
					{Name: "compute", JobType: JobTypeCompute},
					{Name: "route_thumbnails", JobType: JobTypeRouteThumbnails, ContinueOnFailure: true},
					{Name: "ability", JobType: JobTypeAbility, ContinueOnFailure: true},
				},
			},
			UserInitiable: true,
			Description:   "Ongoing incremental path: an incremental watch sync, optional race detection, an incremental compute over only this sync's new activities, then route thumbnails for those activities. Race-detection and thumbnail failures remain visible on their steps but do not fail the pipeline. The run's user_id is the subject athlete.",
			InputSchema:   syncInputSchema,
			ExampleInput:  json.RawMessage(`{"mode":"incremental"}`),
		},
		{
			Def: pipeline.Def{
				Name: PipelineCompetitionCalendar,
				Steps: []pipeline.StepDef{
					{Name: "fetch", JobType: JobTypeCompetitionCalendar},
				},
			},
			UserInitiable: false,
			Description:   "Internal system pipeline (no subject user): fetch one or more World Athletics label-road-races calendar seasons and mirror them into the competition_calendar table. Started by the daily cron workflow via POST /pipelines; the optional input {\"seasons\":[...]} overrides which seasons to fetch.",
			InputSchema:   json.RawMessage(`{"type":"object","properties":{"seasons":{"type":"array","items":{"type":"string"}}},"additionalProperties":false}`),
			ExampleInput:  json.RawMessage(`{"seasons":["2026"]}`),
		},
	}
}

// JobUserInitiable maps job type -> whether a user may create it. Types absent
// from the map are unknown (reject 400).
func JobUserInitiable() map[string]bool {
	out := make(map[string]bool, len(Jobs()))
	for _, s := range Jobs() {
		out[s.Type] = s.UserInitiable
	}
	return out
}

// PipelineUserInitiable maps pipeline name -> whether a user may start it.
func PipelineUserInitiable() map[string]bool {
	specs := Pipelines()
	out := make(map[string]bool, len(specs))
	for _, s := range specs {
		out[s.Def.Name] = s.UserInitiable
	}
	return out
}

// PipelineRegistry builds a pipeline.Registry from the catalog's pipeline
// definitions, for the API's orchestrator.
func PipelineRegistry() *pipeline.Registry {
	reg := pipeline.NewRegistry()
	for _, s := range Pipelines() {
		reg.MustRegister(s.Def)
	}
	return reg
}
