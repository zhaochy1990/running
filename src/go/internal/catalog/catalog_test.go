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
	// calibration and compute are internal-only: users start a pipeline, not a step.
	for _, jt := range []string{JobTypeCalibration, JobTypeCompute} {
		if ui, ok := JobUserInitiable()[jt]; !ok || ui {
			t.Fatalf("%s should be internal-only, got ok=%v ui=%v", jt, ok, ui)
		}
	}
	// The onboarding pipeline is user-initiable and registered.
	if ui, ok := PipelineUserInitiable()[PipelineOnboarding]; !ok || !ui {
		t.Fatalf("onboarding pipeline should be user-initiable, got ok=%v ui=%v", ok, ui)
	}
	def, ok := PipelineRegistry().Get(PipelineOnboarding)
	if !ok {
		t.Fatalf("onboarding pipeline missing from registry")
	}
	want := []string{JobTypeWatchSync, JobTypeRaceDetection, JobTypeCalibration, JobTypeCompute}
	if len(def.Steps) != len(want) {
		t.Fatalf("onboarding has %d steps, want %d", len(def.Steps), len(want))
	}
	for i, jt := range want {
		if def.Steps[i].JobType != jt {
			t.Fatalf("step %d job type = %q, want %q", i, def.Steps[i].JobType, jt)
		}
	}
	if !def.Steps[1].ContinueOnFailure {
		t.Fatal("onboarding race detection must continue on terminal failure")
	}
}

// TestDataSyncPipelineCataloged checks the incremental path: sync -> race detection -> compute.
func TestDataSyncPipelineCataloged(t *testing.T) {
	if ui, ok := PipelineUserInitiable()[PipelineDataSync]; !ok || !ui {
		t.Fatalf("data_sync pipeline should be user-initiable, got ok=%v ui=%v", ok, ui)
	}
	def, ok := PipelineRegistry().Get(PipelineDataSync)
	if !ok {
		t.Fatalf("data_sync pipeline missing from registry")
	}
	want := []string{JobTypeWatchSync, JobTypeRaceDetection, JobTypeCompute}
	if len(def.Steps) != len(want) {
		t.Fatalf("data_sync has %d steps, want %d", len(def.Steps), len(want))
	}
	for i, jt := range want {
		if def.Steps[i].JobType != jt {
			t.Fatalf("step %d job type = %q, want %q", i, def.Steps[i].JobType, jt)
		}
	}
	if !def.Steps[1].ContinueOnFailure {
		t.Fatal("data_sync race detection must continue on terminal failure")
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
