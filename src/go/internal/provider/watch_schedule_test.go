// Tests for the watch-schedule/v1 canonical envelope: provider tag, fetch
// metadata, per-session source ids, and embedded run-workout/v1 content.
package provider

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

const sampleWatchSchedule = `{
	"schema": "watch-schedule/v1",
	"provider": "coros",
	"fetch": {"fetched_at": "2026-09-21T08:00:00Z", "window_from": "2026-09-14", "window_to": "2026-12-20"},
	"sessions": [{
		"date": "2026-09-22",
		"kind": "run",
		"source_ids": {"provider": "coros", "entity_id": "sch-123"},
		"spec": {
			"schema": "run-workout/v1",
			"name": "Threshold 6x1k",
			"date": "2026-09-22",
			"blocks": [{"repeat": 6, "steps": [
				{"step_kind": "work", "duration": {"kind": "distance_m", "value": 1000}, "target": {"kind": "pct_lt_pace", "low": 0.87, "high": 0.93}, "hr_cap_bpm": 167},
				{"step_kind": "recovery", "duration": {"kind": "time_s", "value": 60}, "target": {"kind": "open", "low": null, "high": null}}
			]}]
		}
	}]
}`

func TestWatchScheduleRoundTrip(t *testing.T) {
	s, err := WatchScheduleFromJSON([]byte(sampleWatchSchedule))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if s.Schema != WatchScheduleSchema || s.Provider != "coros" {
		t.Fatalf("envelope = %+v", s)
	}
	if len(s.Sessions) != 1 {
		t.Fatalf("sessions = %d, want 1", len(s.Sessions))
	}
	sess := s.Sessions[0]
	if sess.Kind != WatchSessionKindRun {
		t.Errorf("kind = %q, want %q", sess.Kind, WatchSessionKindRun)
	}
	if sess.SourceIDs.Provider != "coros" || sess.SourceIDs.EntityID != "sch-123" {
		t.Errorf("source_ids = %+v", sess.SourceIDs)
	}
	if got := sess.Spec.Blocks[0].Steps[0].Target.Kind; got != TargetPctLTPace {
		t.Errorf("embedded target kind = %q, want %q", got, TargetPctLTPace)
	}
	if cap := sess.Spec.Blocks[0].Steps[0].HRCapBPM; cap == nil || *cap != 167 {
		t.Errorf("embedded hr_cap_bpm = %v, want 167 (a first-class guardrail must survive the pull)", cap)
	}

	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	again, err := WatchScheduleFromJSON(raw)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if !reflect.DeepEqual(s, again) {
		t.Fatalf("round-trip = %+v, want %+v", again, s)
	}
}

func TestWatchScheduleFromJSONNormalizesMissingSchema(t *testing.T) {
	raw := `{"provider":"garmin","sessions":[{"date":"2026-05-01","kind":"run","source_ids":{"provider":"garmin","entity_id":"w-1"},"spec":{"name":"Easy","date":"2026-05-01","blocks":[{"repeat":1,"steps":[{"step_kind":"work","duration":{"kind":"time_s","value":600},"target":{"kind":"open","low":null,"high":null}}]}]}}]}`
	s, err := WatchScheduleFromJSON([]byte(raw))
	if err != nil {
		t.Fatalf("parse schema-less: %v", err)
	}
	if s.Schema != WatchScheduleSchema {
		t.Errorf("schema = %q, want normalized %q", s.Schema, WatchScheduleSchema)
	}
}

func TestWatchScheduleFromJSONRejectsWrongSchema(t *testing.T) {
	raw := `{"schema":"run-workout/v1","provider":"coros","sessions":[]}`
	_, err := WatchScheduleFromJSON([]byte(raw))
	if err == nil || !strings.Contains(err.Error(), "unexpected watch schedule schema") {
		t.Fatalf("err = %v, want schema mismatch", err)
	}
}

func TestWatchScheduleRejectsStrengthSession(t *testing.T) {
	raw := `{"provider":"coros","sessions":[{"date":"2026-05-01","kind":"strength","source_ids":{"provider":"coros","entity_id":"s-1"},"spec":{"name":"x","date":"2026-05-01","blocks":[]}}]}`
	_, err := WatchScheduleFromJSON([]byte(raw))
	if err == nil || !strings.Contains(err.Error(), "run content only") {
		t.Fatalf("err = %v, want strength not modeled in v1", err)
	}
}

func TestWatchScheduleRejectsMissingSourceID(t *testing.T) {
	raw := `{"provider":"coros","sessions":[{"date":"2026-05-01","kind":"run","source_ids":{"provider":"coros"},"spec":{"name":"x","date":"2026-05-01","blocks":[{"repeat":1,"steps":[{"step_kind":"work","duration":{"kind":"time_s","value":600},"target":{"kind":"open","low":null,"high":null}}]}]}}]}`
	_, err := WatchScheduleFromJSON([]byte(raw))
	if err == nil || !strings.Contains(err.Error(), "entity_id") {
		t.Fatalf("err = %v, want entity_id required", err)
	}
}

func TestSchedulePullWindow(t *testing.T) {
	from, to := SchedulePullWindow()
	if !validISODate(from) || !validISODate(to) {
		t.Fatalf("window = %q..%q, want ISO dates", from, to)
	}
	fromDay, err1 := time.Parse("2006-01-02", from)
	toDay, err2 := time.Parse("2006-01-02", to)
	if err1 != nil || err2 != nil {
		t.Fatalf("window parse: %v / %v", err1, err2)
	}
	if d := toDay.Sub(fromDay).Hours() / 24; d != 97 {
		t.Errorf("window span = %.0f days, want 97 (−7 → +90)", d)
	}
}

func TestWatchScheduleSessionProviderDefaultsToEnvelope(t *testing.T) {
	raw := `{"provider":"garmin","sessions":[{"date":"2026-05-01","kind":"run","source_ids":{"entity_id":"w-1"},"spec":{"name":"x","date":"2026-05-01","blocks":[{"repeat":1,"steps":[{"step_kind":"work","duration":{"kind":"time_s","value":600},"target":{"kind":"open","low":null,"high":null}}]}]}}]}`
	if _, err := WatchScheduleFromJSON([]byte(raw)); err != nil {
		t.Fatalf("provider should default to envelope: %v", err)
	}
}
