package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
)

func TestWatchProgress_RendersSyncAndComputeStages(t *testing.T) {
	var output bytes.Buffer
	p := newWatchProgress(&output, false)
	p.sync(provider.SyncProgress{"phase": "activities", "current": 3, "total": 10, "percent": 31})
	if err := p.heartbeat("training_load", 66); err != nil {
		t.Fatal(err)
	}

	got := output.String()
	if !strings.Contains(got, "[activities]") || !strings.Contains(got, "3/10 (31%)") {
		t.Fatalf("missing activity progress: %q", got)
	}
	if !strings.Contains(got, "[training_load]") || !strings.Contains(got, "66/100 (66%)") {
		t.Fatalf("missing compute progress: %q", got)
	}
}

func TestWatchProgress_DerivedStagesFinishWithoutRegressing(t *testing.T) {
	var output bytes.Buffer
	p := newWatchProgress(&output, false)
	p.sync(provider.SyncProgress{"phase": "health", "current": 1, "total": 1, "percent": 95})
	if err := p.derivedHeartbeat("calibration", 100); err != nil {
		t.Fatal(err)
	}
	if err := p.derivedHeartbeat("training_load", 66); err != nil {
		t.Fatal(err)
	}
	if err := p.derivedHeartbeat("personal_bests", 99); err != nil {
		t.Fatal(err)
	}
	p.complete()

	for _, want := range []string{"[health]", "(95%)", "[calibration]", "(97%)", "[training_load]", "(98%)", "[personal_bests]", "(99%)", "[complete]", "(100%)"} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("progress output missing %q: %q", want, output.String())
		}
	}
}
