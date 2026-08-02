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
)

// Pipeline names (ADR 0020). Both are fronted by POST /api/{user}/sync, which
// picks by mode; onboarding is also the new-user full path.
const (
	// PipelineOnboarding is the full path: watch_sync(full) -> calibration ->
	// compute(full). New-user onboarding and any explicit full resync.
	PipelineOnboarding = "onboarding"
	// PipelineDataSync is the ongoing incremental path: watch_sync(incremental) ->
	// compute(incremental).
	PipelineDataSync = "data_sync"
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
			Type:          JobTypeCompute,
			UserInitiable: false,
			Description:   "Derive per-activity training load, daily PMC (CTL/ATL/Form) and personal bests from synced data and the latest calibration snapshot. Mode-aware: full recomputes the window; incremental only touches this sync's new activities (label_ids). Internal-only.",
			InputSchema:   json.RawMessage(`{"type":"object","properties":{"mode":{"type":"string","enum":["full","incremental"],"default":"full"},"label_ids":{"type":"array","items":{"type":"string"},"description":"Incremental only: the activities this sync produced."}},"additionalProperties":true}`),
			ExampleInput:  json.RawMessage(`{"mode":"incremental","label_ids":["a1b2"]}`),
		},
	}
}

// Pipelines returns every pipeline the API can start. Both are fronted by POST
// /api/{user}/sync (which picks by mode) and are user-initiable — a browser/app
// triggers a run for its own user_id (the subject; ADR 0012 / 0020). Their step
// job types MUST be registered as handlers in cmd/worker. The run-level input
// {mode,content,limit} is threaded into each step (the sync step reads mode;
// compute reads mode + the upstream label_ids).
func Pipelines() []PipelineSpec {
	syncInputSchema := json.RawMessage(`{"type":"object","properties":{"mode":{"type":"string","enum":["full","incremental"]},"content":{"type":"string","enum":["all","activities","health"]},"limit":{"type":"integer","minimum":0}},"additionalProperties":false}`)
	return []PipelineSpec{
		{
			Def: pipeline.Def{
				Name: PipelineOnboarding,
				Steps: []pipeline.StepDef{
					{Name: "sync", JobType: JobTypeWatchSync},
					{Name: "calibration", JobType: JobTypeCalibration},
					{Name: "compute", JobType: JobTypeCompute},
				},
			},
			UserInitiable: true,
			Description:   "Full path (new-user onboarding or explicit full resync): a full watch sync, then the athlete baseline, then a full load/PMC/PB compute. The run's user_id is the subject athlete.",
			InputSchema:   syncInputSchema,
			ExampleInput:  json.RawMessage(`{"mode":"full"}`),
		},
		{
			Def: pipeline.Def{
				Name: PipelineDataSync,
				Steps: []pipeline.StepDef{
					{Name: "sync", JobType: JobTypeWatchSync},
					{Name: "compute", JobType: JobTypeCompute},
				},
			},
			UserInitiable: true,
			Description:   "Ongoing incremental path: an incremental watch sync, then an incremental compute over only this sync's new activities. The run's user_id is the subject athlete.",
			InputSchema:   syncInputSchema,
			ExampleInput:  json.RawMessage(`{"mode":"incremental"}`),
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
