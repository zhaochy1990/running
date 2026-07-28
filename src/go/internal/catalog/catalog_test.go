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
