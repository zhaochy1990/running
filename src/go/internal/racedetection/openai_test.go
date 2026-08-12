package racedetection

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestChatCompletionsClassifierUsesJSONResponseFormat(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("authorization = %q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"is_race\":true}"}}]}`))
	}))
	defer server.Close()

	classifier, err := NewChatCompletionsClassifier(ChatCompletionsConfig{
		Endpoint: server.URL,
		APIKey:   "test-key",
		Model:    "race-model",
		Timeout:  time.Second,
	})
	if err != nil {
		t.Fatalf("NewChatCompletionsClassifier: %v", err)
	}
	isRace, err := classifier.Classify(context.Background(), Candidate{
		LabelID: "a1", Name: "Shanghai Half Marathon", Sport: "run_outdoor", CandidateType: RaceTypeHalfMarathon, DistanceM: 21100,
	})
	if err != nil {
		t.Fatalf("Classify: %v", err)
	}
	if !isRace {
		t.Fatal("expected race=true")
	}
	format := body["response_format"].(map[string]any)
	if format["type"] != "json_object" {
		t.Fatalf("format = %#v", format)
	}
	encoded, _ := json.Marshal(body["messages"])
	if !strings.Contains(string(encoded), "Shanghai Half Marathon") {
		t.Fatalf("candidate data missing from input: %s", encoded)
	}
}

func TestChatCompletionsClassifierRejectsMalformedDecisions(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{"no choices", "{\"choices\":[]}"},
		{"invalid decision JSON", "{\"choices\":[{\"message\":{\"content\":\"true\"}}]}"},
		{"missing boolean", "{\"choices\":[{\"message\":{\"content\":\"{}\"}}]}"},
		{"unexpected field", "{\"choices\":[{\"message\":{\"content\":\"{\\\"is_race\\\":true,\\\"reason\\\":\\\"x\\\"}\"}}]}"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()
			classifier, err := NewChatCompletionsClassifier(ChatCompletionsConfig{
				Endpoint: server.URL, APIKey: "test-key", Model: "race-model", Timeout: time.Second,
			})
			if err != nil {
				t.Fatalf("new classifier: %v", err)
			}
			if _, err := classifier.Classify(context.Background(), Candidate{}); err == nil {
				t.Fatal("malformed decision must fail")
			}
		})
	}
}

func TestNewChatCompletionsClassifierRejectsInvalidConfiguration(t *testing.T) {
	tests := []ChatCompletionsConfig{
		{Endpoint: "relative", APIKey: "key", Model: "model", Timeout: time.Second},
		{Endpoint: "https://example.com", APIKey: "key", Model: "model", Timeout: 0},
	}
	for _, cfg := range tests {
		if _, err := NewChatCompletionsClassifier(cfg); err == nil {
			t.Fatalf("config %+v must fail", cfg)
		}
	}
}
