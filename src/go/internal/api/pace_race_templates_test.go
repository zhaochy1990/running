package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPaceRaceTemplates(t *testing.T) {
	svc := NewService(Config{Auth: NewAuthenticator("", nil)})
	rec := httptest.NewRecorder()
	svc.Router().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/pace-calculator/race-templates", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status %d: %s", rec.Code, rec.Body)
	}
	var payload struct {
		Templates []struct {
			Key      string  `json:"key"`
			Name     string  `json:"name"`
			Distance float64 `json:"distance_km"`
			Segments []struct {
				Start float64 `json:"start_km"`
				End   float64 `json:"end_km"`
				Delta *int    `json:"pace_delta_seconds"`
			} `json:"segments"`
		} `json:"templates"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Templates) != 7 {
		t.Fatalf("got %d templates, want 7", len(payload.Templates))
	}
	seen := make(map[string]bool)
	for _, template := range payload.Templates {
		if template.Key == "" || template.Name == "" || seen[template.Key] {
			t.Fatalf("missing or duplicate template identity: %q", template.Key)
		}
		seen[template.Key] = true
		if template.Distance != 42.195 || len(template.Segments) == 0 || len(template.Segments) > 10 {
			t.Fatalf("invalid distance or segment count for %s", template.Key)
		}
		end := 0.0
		for _, segment := range template.Segments {
			if segment.Start != end || segment.End <= segment.Start || segment.Delta == nil {
				t.Fatalf("invalid or non-contiguous segment in %s: %+v", template.Key, segment)
			}
			end = segment.End
		}
		if end != template.Distance {
			t.Fatalf("%s segments end at %f, want %f", template.Key, end, template.Distance)
		}
	}
}
