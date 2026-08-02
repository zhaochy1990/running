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
	// JobTypeOnboardingCompute derives athlete baselines/load/ability from synced
	// data. Internal-only: users start the onboarding pipeline, not this step.
	JobTypeOnboardingCompute = "onboarding_compute"
)

// PipelineOnboarding is the new-user onboarding pipeline name (ADR 0015).
const PipelineOnboarding = "onboarding"

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
			Type:          JobTypeOnboardingCompute,
			UserInitiable: false,
			Description:   "Derive athlete baselines, training load and ability from already-synced data. No input body; operates on the job's user_id (subject UUID). Internal-only.",
			InputSchema:   json.RawMessage(`{"type":"object","description":"No input fields; operates on the job's user_id (subject UUID).","additionalProperties":false}`),
			ExampleInput:  json.RawMessage(`{}`),
		},
	}
}

// Pipelines returns every pipeline the API can start. The onboarding pipeline
// (full_sync -> onboarding_compute) is user-initiable: a browser/app POSTs
// /pipelines/onboarding for itself (ADR 0012 / 0015). Its step job
// types MUST be registered as handlers in cmd/worker.
func Pipelines() []PipelineSpec {
	return []PipelineSpec{
		{
			Def: pipeline.Def{
				Name: PipelineOnboarding,
				Steps: []pipeline.StepDef{
					{Name: "full_sync", JobType: JobTypeWatchSync},
					{Name: "onboarding_compute", JobType: JobTypeOnboardingCompute},
				},
			},
			UserInitiable: true,
			Description:   "New-user onboarding: a full watch sync followed by baseline/load/ability compute. user_id is the subject athlete.",
			InputSchema:   json.RawMessage(`{"type":"object","description":"No input consumed; onboarding operates on the run's user_id (subject UUID).","additionalProperties":false}`),
			ExampleInput:  json.RawMessage(`{}`),
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
