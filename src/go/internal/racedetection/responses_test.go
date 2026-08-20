package racedetection

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestResponsesClassifierUsesLunaContract(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" {
			t.Errorf("path = %q, want /responses", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"output":[{"type":"message","content":[{"type":"output_text","text":"{\"赛事或全力自测意图\":\"支持比赛\",\"强度与跑动连续性\":\"支持比赛\"}"}]}],"usage":{"input_tokens":1234,"output_tokens":17,"total_tokens":1251}}`))
	}))
	defer server.Close()

	classifier, err := NewResponsesClassifier(ResponsesConfig{
		Endpoint: server.URL, APIKey: "test-key", Model: "gpt-5.6-luna", Timeout: time.Second,
	})
	if err != nil {
		t.Fatalf("new classifier: %v", err)
	}
	result, err := classifier.AssessWithUsage(context.Background(), Candidate{
		Sport: "run_outdoor", DistanceM: 42_195, CandidateType: RaceTypeMarathon,
		Trace: []TracePoint{{Latitude: float64ptr(31.23), Longitude: float64ptr(121.47)}},
	})
	if err != nil || result.Assessment.EventIntent != EvidenceRace {
		t.Fatalf("assessment = (%+v, %v)", result.Assessment, err)
	}
	if !result.Usage.Available || result.Usage.APIKind != "responses" || result.Usage.Model != "gpt-5.6-luna" || result.Usage.InputTokens != 1234 || result.Usage.OutputTokens != 17 || result.Usage.TotalTokens != 1251 {
		t.Fatalf("usage = %+v", result.Usage)
	}
	if body["model"] != "gpt-5.6-luna" || int(body["max_output_tokens"].(float64)) != 2048 {
		t.Fatalf("responses request = %#v", body)
	}
	if _, present := body["response_format"]; present {
		t.Fatalf("Responses request leaked Chat Completions field: %#v", body)
	}
	input := body["input"].([]any)
	if len(input) != 2 || input[0].(map[string]any)["role"] != "system" || input[1].(map[string]any)["role"] != "user" {
		t.Fatalf("input roles = %#v", input)
	}
}

func TestResponsesClassifierRejectsWrongStructuredField(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"output":[{"type":"message","content":[{"type":"output_text","text":"{\"type\":\"比赛\"}"}]}]}`))
	}))
	defer server.Close()
	classifier, err := NewResponsesClassifier(ResponsesConfig{
		Endpoint: server.URL, APIKey: "test-key", Model: "gpt-5.6-luna", Timeout: time.Second,
	})
	if err != nil {
		t.Fatalf("new classifier: %v", err)
	}
	if _, err := classifier.Assess(context.Background(), Candidate{}); err == nil {
		t.Fatal("wrong structured field must fail")
	}
}
