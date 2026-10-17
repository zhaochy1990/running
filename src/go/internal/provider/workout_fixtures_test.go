// The shared workout fixtures in tests/fixtures/workout are the authoritative
// run-workout/v1 and strength-workout/v1 samples (ADR 0043). The TS side parses
// the same files with the zod contract; here we prove the Go spec parser accepts
// every one of them, including the cadence_spm target and the new step rest idiom.
package provider

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSharedWorkoutFixturesParse(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join("..", "..", "..", "..", "tests", "fixtures", "workout"))
	if err != nil {
		t.Fatalf("read shared fixtures: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("no shared workout fixtures found")
	}
	var sawCadence bool
	for _, entry := range entries {
		raw, readErr := os.ReadFile(filepath.Join("..", "..", "..", "..", "tests", "fixtures", "workout", entry.Name()))
		if readErr != nil {
			t.Fatalf("read %s: %v", entry.Name(), readErr)
		}
		var head struct {
			Schema string `json:"schema"`
		}
		if err := json.Unmarshal(raw, &head); err != nil {
			t.Fatalf("decode %s: %v", entry.Name(), err)
		}
		switch head.Schema {
		case RunWorkoutSchema:
			w, err := RunWorkoutFromJSON(raw)
			if err != nil {
				t.Fatalf("%s: %v", entry.Name(), err)
			}
			for _, block := range w.Blocks {
				for _, step := range block.Steps {
					if step.Target.Kind == TargetCadenceSPM {
						sawCadence = true
					}
				}
			}
		case StrengthWorkoutSchema:
			if _, err := StrengthWorkoutFromJSON(raw); err != nil {
				t.Fatalf("%s: %v", entry.Name(), err)
			}
		default:
			t.Fatalf("%s: unexpected schema %q", entry.Name(), head.Schema)
		}
	}
	if !sawCadence {
		t.Error("no fixture exercises the cadence_spm target kind")
	}
}
