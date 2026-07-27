package pipeline

// DefaultRegistry returns the built-in pipeline definitions. Currently only the
// onboarding pipeline (full historical sync -> calibration -> training-load
// backfill), mirroring the reference design. Shared by the API (which starts
// pipelines) and the worker.
func DefaultRegistry() *Registry {
	r := NewRegistry()
	r.MustRegister(Def{Name: "onboarding", Steps: []StepDef{
		{Name: "full_sync", JobType: "onboarding_full_sync"},
		{Name: "calibration", JobType: "onboarding_calibration"},
		{Name: "backfill", JobType: "onboarding_backfill"},
	}})
	return r
}
