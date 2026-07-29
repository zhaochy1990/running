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

import "github.com/zhaochy1990/stride/internal/pipeline"

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

// PipelineOnboarding is the new-user onboarding pipeline name (ADR 0013).
const PipelineOnboarding = "onboarding"

// JobSpec is one known job type and whether end users may enqueue it directly.
type JobSpec struct {
	Type          string
	UserInitiable bool
}

// PipelineSpec is one known pipeline (its linear step definition) and whether
// end users may start it.
type PipelineSpec struct {
	Def           pipeline.Def
	UserInitiable bool
}

// Jobs returns every job type the API accepts. Unknown types are rejected 400.
func Jobs() []JobSpec {
	return []JobSpec{
		{Type: JobTypeHello, UserInitiable: false},
		{Type: JobTypeWatchSync, UserInitiable: true},
		{Type: JobTypeOnboardingCompute, UserInitiable: false},
	}
}

// Pipelines returns every pipeline the API can start. The onboarding pipeline
// (full_sync -> onboarding_compute) is user-initiable: a browser/app POSTs
// /pipelines/onboarding for its own partition (ADR 0012 / 0013). Its step job
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
