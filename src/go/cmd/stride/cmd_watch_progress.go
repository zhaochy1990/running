package main

import (
	"fmt"
	"io"
	"strings"

	"github.com/zhaochy1990/stride/internal/provider"
)

const progressBarWidth = 24

// watchProgress renders provider progress and post-sync compute heartbeats for
// the interactive CLI. It accepts an io.Writer so command output is testable.
type watchProgress struct {
	w           io.Writer
	interactive bool
	lastLine    string
	started     bool
}

func newWatchProgress(w io.Writer, interactive bool) *watchProgress {
	return &watchProgress{w: w, interactive: interactive}
}

func (p *watchProgress) sync(event provider.SyncProgress) {
	phase, _ := event["phase"].(string)
	current, _ := event["current"].(int)
	total, _ := event["total"].(int)
	percent, _ := event["percent"].(int)
	p.render(phase, current, total, percent)
}

func (p *watchProgress) heartbeat(stage string, percent int) error {
	p.render(stage, percent, 100, percent)
	return nil
}

// derivedHeartbeat maps post-sync calculation steps into the final five percent
// of the overall CLI progress, so the display never moves backwards after the
// provider has reached its 95% health-sync milestone.
func (p *watchProgress) derivedHeartbeat(stage string, _ int) error {
	percent := 96
	switch stage {
	case "calibration":
		percent = 97
	case "training_load":
		percent = 98
	case "personal_bests":
		percent = 99
	}
	p.render(stage, percent, 100, percent)
	return nil
}

func (p *watchProgress) complete() {
	p.render("complete", 100, 100, 100)
}

func (p *watchProgress) render(phase string, current, total, percent int) {
	if total < 1 {
		total = 1
	}
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	filled := progressBarWidth * percent / 100
	line := fmt.Sprintf("[%s] [%s%s] %d/%d (%d%%)", phase,
		strings.Repeat("=", filled), strings.Repeat("-", progressBarWidth-filled), current, total, percent)
	if line == p.lastLine {
		return
	}
	p.lastLine = line
	if p.interactive {
		fmt.Fprintf(p.w, "\r%s", line)
	} else {
		fmt.Fprintln(p.w, line)
	}
	p.started = true
}

func (p *watchProgress) finish() {
	if p.started && p.interactive {
		fmt.Fprintln(p.w)
	}
}
