package coros

import (
	"context"
	"net/http"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
)

// scheduleFixture is a step-level schedule/query payload covering the four pull
// outcomes: a linear run, an interval group, a [STRIDE]-authored session
// (self-loop), a strength session (skipped), an orphan entity (invalid), and an
// absolute-HR session (including a percent-only step that degrades to open).
const scheduleFixture = `{
	"entities": [
		{"happenDay": "20260922", "idInPlan": 10},
		{"happenDay": "20260922", "idInPlan": 11},
		{"happenDay": "20260922", "idInPlan": 12},
		{"happenDay": "20260922", "idInPlan": 13},
		{"happenDay": "20260922", "idInPlan": 14},
		{"happenDay": "20260922", "idInPlan": 99}
	],
	"programs": [
		{"idInPlan": 10, "name": "Easy Run", "sportType": 1, "exercises": [
			{"exerciseType": 1, "targetType": 2, "targetValue": 600, "intensityType": 0, "id": 1, "isGroup": false},
			{"exerciseType": 2, "targetType": 5, "targetValue": 8000000, "intensityType": 3, "intensityValue": 300000, "intensityValueExtend": 320000, "id": 2, "isGroup": false}
		]},
		{"idInPlan": 11, "name": "[STRIDE] Tempo", "sportType": 1, "exercises": [
			{"exerciseType": 2, "targetType": 2, "targetValue": 600, "intensityType": 0, "id": 1, "isGroup": false}
		]},
		{"idInPlan": 12, "name": "Strength Day", "sportType": 4, "exercises": []},
		{"idInPlan": 13, "name": "Intervals", "sportType": 1, "exercises": [
			{"exerciseType": 0, "isGroup": true, "sets": 6, "restValue": 60, "id": 5},
			{"exerciseType": 2, "targetType": 5, "targetValue": 1000000, "intensityType": 3, "intensityValue": 250000, "intensityValueExtend": 260000, "id": 6, "groupId": 5},
			{"exerciseType": 4, "targetType": 2, "targetValue": 60, "intensityType": 0, "id": 7, "groupId": 5}
		]},
		{"idInPlan": 14, "name": "HR Tempo", "sportType": 1, "exercises": [
			{"exerciseType": 2, "targetType": 2, "targetValue": 1800, "intensityType": 2, "intensityValue": 170, "intensityValueExtend": 176, "intensityMultiplier": 0, "intensityPercent": 103000, "id": 8, "isGroup": false},
			{"exerciseType": 3, "targetType": 2, "targetValue": 600, "intensityType": 2, "intensityValue": 0, "intensityValueExtend": 0, "intensityMultiplier": 0, "intensityPercent": 80000, "id": 9, "isGroup": false}
		]}
	]
}`

func TestDecodeWatchSchedule(t *testing.T) {
	pull, err := decodeWatchSchedule([]byte(scheduleFixture), "2026-09-14", "2026-12-20", "2026-09-21T08:00:00Z")
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if pull.SkippedStrength != 1 {
		t.Errorf("skipped strength = %d, want 1", pull.SkippedStrength)
	}
	if pull.SkippedStride != 1 {
		t.Errorf("skipped stride = %d, want 1 ([STRIDE] self-loop)", pull.SkippedStride)
	}
	if pull.SkippedInvalid != 1 {
		t.Errorf("skipped invalid = %d, want 1 (orphan entity)", pull.SkippedInvalid)
	}
	if len(pull.Schedule.Sessions) != 3 {
		t.Fatalf("sessions = %d, want 3", len(pull.Schedule.Sessions))
	}
	if pull.Schedule.Provider != providerName || pull.Schedule.Schema != provider.WatchScheduleSchema {
		t.Errorf("envelope = %+v", pull.Schedule)
	}
	if pull.Schedule.Fetch.WindowFrom != "2026-09-14" || pull.Schedule.Fetch.WindowTo != "2026-12-20" {
		t.Errorf("fetch window = %+v", pull.Schedule.Fetch)
	}

	easy := pull.Schedule.Sessions[0]
	if easy.SourceIDs.EntityID != "10" || easy.SourceIDs.Provider != "coros" {
		t.Errorf("easy source ids = %+v", easy.SourceIDs)
	}
	if easy.Spec.Name != "Easy Run" || easy.Spec.Date != "2026-09-22" {
		t.Errorf("easy spec = %+v", easy.Spec)
	}
	if len(easy.Spec.Blocks) != 2 {
		t.Fatalf("easy blocks = %d, want 2", len(easy.Spec.Blocks))
	}
	if easy.Spec.Blocks[0].Steps[0].StepKind != provider.StepWarmup {
		t.Errorf("easy step 0 kind = %q", easy.Spec.Blocks[0].Steps[0].StepKind)
	}
	work := easy.Spec.Blocks[1].Steps[0]
	if work.Duration.Kind != provider.DurationDistanceM || *work.Duration.Value != 8000 {
		t.Errorf("easy work duration = %+v, want 8000m", work.Duration)
	}
	if work.Target.Kind != provider.TargetPaceSKM || *work.Target.Low != 320 || *work.Target.High != 300 {
		t.Errorf("easy work target = %+v, want pace low=320 high=300 s/km", work.Target)
	}

	intervals := pull.Schedule.Sessions[1]
	if intervals.Spec.Name != "Intervals" {
		t.Fatalf("interval spec = %+v", intervals.Spec)
	}
	if len(intervals.Spec.Blocks) != 1 {
		t.Fatalf("interval blocks = %d, want 1", len(intervals.Spec.Blocks))
	}
	blk := intervals.Spec.Blocks[0]
	if blk.Repeat != 6 {
		t.Errorf("interval repeat = %d, want 6", blk.Repeat)
	}
	if len(blk.Steps) != 2 {
		t.Fatalf("interval steps = %d, want 2", len(blk.Steps))
	}
	if blk.Steps[0].StepKind != provider.StepWork || blk.Steps[1].StepKind != provider.StepRecovery {
		t.Errorf("interval step kinds = %q, %q", blk.Steps[0].StepKind, blk.Steps[1].StepKind)
	}
	if *blk.Steps[0].Target.Low != 260 || *blk.Steps[0].Target.High != 250 {
		t.Errorf("interval work target = %+v, want low=260 high=250", blk.Steps[0].Target)
	}
	if *blk.Steps[1].Duration.Value != 60 {
		t.Errorf("interval recovery duration = %+v, want 60s", blk.Steps[1].Duration)
	}

	// HR session: absolute bpm wins over intensityPercent; Low = easier (lower
	// bpm), High = harder. The percent-only cooldown step degrades to open.
	hr := pull.Schedule.Sessions[2]
	if hr.Spec.Name != "HR Tempo" {
		t.Fatalf("hr spec = %+v", hr.Spec)
	}
	hrWork := hr.Spec.Blocks[0].Steps[0]
	if hrWork.Target.Kind != provider.TargetHRBPM {
		t.Fatalf("hr work target kind = %q, want hr_bpm", hrWork.Target.Kind)
	}
	if *hrWork.Target.Low != 170 || *hrWork.Target.High != 176 {
		t.Errorf("hr work target = %+v, want low=170 high=176 (easier→harder)", hrWork.Target)
	}
	if hrWork.Target.Kind.IsValid() {
		if err := hrWork.Target.Validate(); err != nil {
			t.Errorf("hr work target invalid: %v", err)
		}
	}
	hrCool := hr.Spec.Blocks[1].Steps[0]
	if hrCool.Target.Kind != provider.TargetOpen {
		t.Errorf("percent-only hr cooldown target = %+v, want open", hrCool.Target)
	}
}

func TestPullWatchSchedule(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/training/schedule/query", func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("startDate"); got != "20260914" {
			t.Errorf("startDate = %q, want 20260914", got)
		}
		if got := r.URL.Query().Get("endDate"); got != "20261220" {
			t.Errorf("endDate = %q, want 20261220", got)
		}
		writeEnvelope(w, resultSuccess, scheduleFixture)
	})
	p := newTestProvider(t, mux, newFakeWriter())

	pull, err := p.PullWatchSchedule(context.Background(), testUID, "2026-09-14", "2026-12-20")
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if len(pull.Schedule.Sessions) != 3 {
		t.Fatalf("sessions = %d, want 3", len(pull.Schedule.Sessions))
	}
	if pull.Schedule.Provider != providerName {
		t.Errorf("provider = %q, want %q", pull.Schedule.Provider, providerName)
	}
}
