package provider

// Watch Schedule — the canonical, provider-agnostic shape of a third-party
// watch platform's calendar (COROS schedule / Garmin workouts) pulled into
// STRIDE. It is a separate domain from the coach-generated weekly plan: watch
// content is stored on its own and never merged into weekly_plan/master_plan.
//
// v1 models run content only, reusing run-workout/v1 for each session. Each
// session carries provider source ids so a later sync can be idempotent without
// changing the schema. Strength content is intentionally not modelled in v1.

import (
	"encoding/json"
	"fmt"
	"strings"
)

// WatchScheduleSchema is the schema discriminator for the watch-schedule
// envelope.
const WatchScheduleSchema = "watch-schedule/v1"

// WatchSessionKindRun is the only session kind modelled by watch-schedule/v1.
const WatchSessionKindRun = "run"

// WatchFetchMeta records where a schedule page came from. FetchedAt is an
// RFC3339 instant; the window bounds are ISO dates (local calendar days).
type WatchFetchMeta struct {
	FetchedAt  string `json:"fetched_at,omitempty"`
	WindowFrom string `json:"window_from,omitempty"`
	WindowTo   string `json:"window_to,omitempty"`
}

// WatchSourceIDs is the per-session idempotency key: the provider that owns the
// session plus the platform's own entity id. Provider may be omitted and
// inherited from the envelope.
type WatchSourceIDs struct {
	Provider string `json:"provider"`
	EntityID string `json:"entity_id"`
}

// WatchSession mirrors the planned-session content shape (date / kind / spec)
// for the watch domain. Spec is a full run-workout/v1 document.
type WatchSession struct {
	Date      string         `json:"date"`
	Kind      string         `json:"kind"`
	SourceIDs WatchSourceIDs `json:"source_ids"`
	Spec      RunWorkout     `json:"spec"`
}

// WatchSchedule is the provider-tagged envelope for a pulled calendar.
type WatchSchedule struct {
	Schema   string         `json:"schema"`
	Provider string         `json:"provider"`
	Fetch    WatchFetchMeta `json:"fetch"`
	Sessions []WatchSession `json:"sessions"`
}

// Validate checks the envelope and every session. An empty session list is
// valid (a pull window may legitimately contain no workouts).
func (s WatchSchedule) Validate() error {
	if strings.TrimSpace(s.Provider) == "" {
		return fmt.Errorf("watch schedule provider is required")
	}
	if s.Fetch.WindowFrom != "" && !validISODate(s.Fetch.WindowFrom) {
		return fmt.Errorf("fetch window_from must be ISO YYYY-MM-DD, got %q", s.Fetch.WindowFrom)
	}
	if s.Fetch.WindowTo != "" && !validISODate(s.Fetch.WindowTo) {
		return fmt.Errorf("fetch window_to must be ISO YYYY-MM-DD, got %q", s.Fetch.WindowTo)
	}
	for i, sess := range s.Sessions {
		if err := sess.Validate(s.Provider); err != nil {
			return fmt.Errorf("session %d: %w", i, err)
		}
	}
	return nil
}

// Validate checks one session against the envelope provider (used as the
// fallback when the session omits source_ids.provider).
func (s WatchSession) Validate(envelopeProvider string) error {
	if !validISODate(s.Date) {
		return fmt.Errorf("date must be ISO YYYY-MM-DD, got %q", s.Date)
	}
	if s.Kind != WatchSessionKindRun {
		return fmt.Errorf("unsupported session kind %q: watch-schedule/v1 models run content only", s.Kind)
	}
	if strings.TrimSpace(s.SourceIDs.Provider) == "" && strings.TrimSpace(envelopeProvider) == "" {
		return fmt.Errorf("source_ids.provider is required")
	}
	if strings.TrimSpace(s.SourceIDs.EntityID) == "" {
		return fmt.Errorf("source_ids.entity_id is required")
	}
	if err := s.Spec.Validate(); err != nil {
		return fmt.Errorf("spec: %w", err)
	}
	return nil
}

// WatchScheduleFromJSON parses and validates a watch-schedule/v1 payload. A
// missing schema is tolerated and normalized (consistent with
// RunWorkoutFromJSON); a present-but-wrong schema is rejected.
func WatchScheduleFromJSON(data []byte) (*WatchSchedule, error) {
	var head struct {
		Schema string `json:"schema"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, fmt.Errorf("parse watch schedule: %w", err)
	}
	if head.Schema != "" && head.Schema != WatchScheduleSchema {
		return nil, fmt.Errorf("unexpected watch schedule schema %q, want %q", head.Schema, WatchScheduleSchema)
	}
	var s WatchSchedule
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse watch schedule: %w", err)
	}
	s.Schema = WatchScheduleSchema
	if err := s.Validate(); err != nil {
		return nil, err
	}
	return &s, nil
}
