package api

// Validates a race-content payload batch — the JSON the WebSearch research
// produces — against the real validators before anything is pushed to the
// admin API. It exists because the payloads are hand-assembled from web
// research and a rejected field is only discovered at push time otherwise.
//
// It is opt-in: set STRIDE_RACE_PILOT_JSON to the file and run
//
//	STRIDE_RACE_PILOT_JSON=/path/to/batch.json go test ./internal/api/ -run TestPilotPayloadValidates
//
// Without the variable it skips, so CI never depends on a file outside the repo.

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

type pilotFile struct {
	Races []struct {
		RaceID   uint64 `json:"race_id"`
		RaceName string `json:"race_name"`
		Event    struct {
			NameCN        *string                              `json:"name_cn"`
			Overrides     []string                             `json:"overrides"`
			ContentSource optionalField[string]                `json:"content_source"`
			Content       optionalField[raceEventContentInput] `json:"content"`
		} `json:"event"`
		Items []struct {
			ItemID *uint64                       `json:"item_id"`
			Name   string                        `json:"name"`
			Body   raceCalendarItemCreateRequest `json:"body"`
		} `json:"items"`
	} `json:"races"`
}

func TestPilotPayloadValidates(t *testing.T) {
	path := os.Getenv("STRIDE_RACE_PILOT_JSON")
	if path == "" {
		t.Skip("set STRIDE_RACE_PILOT_JSON to a payload file to run this check")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read pilot: %v", err)
	}
	var f pilotFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("decode pilot: %v", err)
	}
	if len(f.Races) == 0 {
		t.Fatal("payload has no races")
	}

	events, items, creates := 0, 0, 0
	for _, r := range f.Races {
		if !r.Event.Content.Set {
			t.Errorf("race %d %s: event.content not set", r.RaceID, r.RaceName)
		}
		if err := validateRaceEventContent(r.Event.Content.Value); err != nil {
			t.Errorf("race %d %s: event content INVALID: %v", r.RaceID, r.RaceName, err)
		}
		// The ordering invariant: normalize must not turn a valid payload into
		// an invalid one (normalize clears url_type when url is nil).
		normalizeRaceEventContent(r.Event.Content.Value)
		if err := validateRaceEventContent(r.Event.Content.Value); err != nil {
			t.Errorf("race %d %s: invalid AFTER normalize: %v", r.RaceID, r.RaceName, err)
		}
		for _, field := range r.Event.Overrides {
			if !storage.IsRaceCalendarOverrideable(field) {
				t.Errorf("race %d: %q is not an overrideable field", r.RaceID, field)
			}
		}
		if r.Event.NameCN != nil && len(r.Event.Overrides) == 0 {
			t.Errorf("race %d: name_cn set without recording the override", r.RaceID)
		}
		events++

		for _, it := range r.Items {
			if it.Body.Content == nil {
				t.Errorf("race %d item %s: no content", r.RaceID, it.Name)
				continue
			}
			if err := validateRaceItemContent(it.Body.Content); err != nil {
				t.Errorf("race %d item %s: content INVALID: %v", r.RaceID, it.Name, err)
			}
			if it.ItemID == nil {
				creates++
				if it.Body.Type == "" {
					t.Errorf("race %d item %s: creation without a type", r.RaceID, it.Name)
				}
			}
			items++
		}
	}
	t.Logf("validated %d events, %d items (%d to create)", events, items, creates)
}
