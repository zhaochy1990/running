package catalog

import "testing"

func TestJobUserInitiable(t *testing.T) {
	m := JobUserInitiable()
	if ui, ok := m[JobTypeWatchSync]; !ok || !ui {
		t.Fatalf("watch_sync should be user-initiable, got ok=%v ui=%v", ok, ui)
	}
	if ui, ok := m[JobTypeHello]; !ok || ui {
		t.Fatalf("hello should be internal-only, got ok=%v ui=%v", ok, ui)
	}
	if _, ok := m["nonexistent"]; ok {
		t.Fatalf("unknown type must be absent from the catalog")
	}
}

func TestPipelineRegistryMatchesUserInitiable(t *testing.T) {
	reg := PipelineRegistry()
	for name := range PipelineUserInitiable() {
		if _, ok := reg.Get(name); !ok {
			t.Fatalf("pipeline %q is cataloged but not in the registry", name)
		}
	}
}

func TestOnboardingPipelineCataloged(t *testing.T) {
	// onboarding_compute is internal-only: users start the pipeline, not the step.
	if ui, ok := JobUserInitiable()[JobTypeOnboardingCompute]; !ok || ui {
		t.Fatalf("onboarding_compute should be internal-only, got ok=%v ui=%v", ok, ui)
	}
	// The onboarding pipeline is user-initiable and registered.
	if ui, ok := PipelineUserInitiable()[PipelineOnboarding]; !ok || !ui {
		t.Fatalf("onboarding pipeline should be user-initiable, got ok=%v ui=%v", ok, ui)
	}
	def, ok := PipelineRegistry().Get(PipelineOnboarding)
	if !ok {
		t.Fatalf("onboarding pipeline missing from registry")
	}
	want := []string{JobTypeWatchSync, JobTypeOnboardingCompute}
	if len(def.Steps) != len(want) {
		t.Fatalf("onboarding has %d steps, want %d", len(def.Steps), len(want))
	}
	for i, jt := range want {
		if def.Steps[i].JobType != jt {
			t.Fatalf("step %d job type = %q, want %q", i, def.Steps[i].JobType, jt)
		}
	}
}

// TestPipelineStepsAreCatalogedJobs guards the catalog/registry drift the API
// cannot catch (ADR 0012): every pipeline step must name a cataloged job type,
// otherwise the API's 400 check passes yet the step poisons at dispatch.
func TestPipelineStepsAreCatalogedJobs(t *testing.T) {
	jobs := JobUserInitiable() // keyed by every cataloged job type
	for _, p := range Pipelines() {
		for _, s := range p.Def.Steps {
			if _, ok := jobs[s.JobType]; !ok {
				t.Fatalf("pipeline %q step %q references uncataloged job type %q",
					p.Def.Name, s.Name, s.JobType)
			}
		}
	}
}
