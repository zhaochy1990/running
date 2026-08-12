package racedetection

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
