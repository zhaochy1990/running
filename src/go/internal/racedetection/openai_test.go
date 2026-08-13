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
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"赛事或全力自测意图\":\"支持比赛\",\"强度与跑动连续性\":\"支持比赛\"}"}}],"usage":{"prompt_tokens":2345,"completion_tokens":9,"total_tokens":2354}}`))
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
	duration, pace, ascent := 5400.0, 255.9, 85.0
	locationDistance := 1067.0
	result, err := classifier.AssessWithUsage(context.Background(), Candidate{
		LabelID: "a1", Name: "Shanghai Half Marathon", Sport: "run_outdoor", CandidateType: RaceTypeHalfMarathon, DistanceM: 21100,
		DurationS: &duration, AvgPaceSKm: &pace, AscentM: &ascent,
		Trace: []TracePoint{
			{Timestamp: int64ptr(100), Latitude: float64ptr(31.2304), Longitude: float64ptr(121.4737), AltitudeM: float64ptr(8.5)},
			{Timestamp: int64ptr(200), Latitude: float64ptr(31.2310), Longitude: float64ptr(121.4742), AltitudeM: float64ptr(9.0)},
		},
		Location: &LocationContext{
			TypicalLatitude: 39.9042, TypicalLongitude: 116.4074,
			SupportingActivityCount: 42, CandidateStartDistanceKM: &locationDistance,
		},
		Pauses: &PauseContext{Count: 1, TotalDurationS: 12.34, Intervals: []PauseInterval{{
			StartLocal: "2024-03-10 07:45:00", EndLocal: "2024-03-10 07:45:12", DurationS: 12.34,
		}}},
	})
	if err != nil {
		t.Fatalf("Classify: %v", err)
	}
	if result.Assessment.EventIntent != EvidenceRace || result.Assessment.IntensityContinuity != EvidenceRace {
		t.Fatalf("assessment = %+v", result.Assessment)
	}
	if !result.Usage.Available || result.Usage.APIKind != "chat-completions" || result.Usage.Model != "race-model" || result.Usage.InputTokens != 2345 || result.Usage.OutputTokens != 9 || result.Usage.TotalTokens != 2354 {
		t.Fatalf("usage = %+v", result.Usage)
	}
	format := body["response_format"].(map[string]any)
	if format["type"] != "json_object" {
		t.Fatalf("format = %#v", format)
	}
	if got := int(body["max_tokens"].(float64)); got != 2048 {
		t.Fatalf("max_tokens = %d, want 2048 for the bounded JSON decision", got)
	}
	if _, present := body["thinking"]; present {
		t.Fatalf("generic OpenAI-compatible request must not include provider-specific thinking: %#v", body)
	}
	messages := body["messages"].([]any)
	systemContent := messages[0].(map[string]any)["content"].(string)
	userContent := messages[1].(map[string]any)["content"].(string)
	allContent := systemContent + "\n" + userContent
	if !strings.Contains(allContent, "Shanghai Half Marathon") {
		t.Fatalf("candidate data missing from input: %s", allContent)
	}
	if !strings.Contains(allContent, "本地开始时间") || !strings.Contains(allContent, "半程马拉松") {
		t.Fatalf("user prompt fields and enum values must be Chinese: %s", allContent)
	}
	if strings.Contains(allContent, "candidate_type") || strings.Contains(allContent, "train_kind") {
		t.Fatalf("English prompt field names leaked into user prompt: %s", allContent)
	}
	for _, expected := range []string{
		`"用时_秒"`, `"平均配速_秒每公里"`, `"累计爬升_米"`,
		`"赛事或全力自测意图"`, `"强度与跑动连续性"`,
		"支持比赛", "支持训练", "信息不足", "不负责计算分数",
	} {
		if !strings.Contains(allContent, expected) {
			t.Fatalf("request is missing assessment field or guidance %q: %s", expected, allContent)
		}
	}
	for _, forbidden := range []string{"地理与海拔轨迹", "常用活动区域", "暂停信息", "候选起点距区域中心_公里"} {
		if strings.Contains(userContent, forbidden) {
			t.Fatalf("LLM input must omit Go-scored field %q: %s", forbidden, userContent)
		}
	}
	if strings.Contains(allContent, ",omitempty") {
		t.Fatalf("omitempty leaked into localized JSON field name: %s", allContent)
	}
}

func TestTravelEvidenceTreatsLocalLocationAsNeutral(t *testing.T) {
	localDistance, travelDistance := 12.0, 1_067.0
	if got := travelEvidence(&LocationContext{CandidateStartDistanceKM: &localDistance}); got != EvidenceUnknown {
		t.Fatalf("local travel evidence = %q, want neutral", got)
	}
	if got := travelEvidence(&LocationContext{CandidateStartDistanceKM: &travelDistance}); got != EvidenceRace {
		t.Fatalf("travel evidence = %q, want race", got)
	}
}

func TestDeepSeekRequestDisablesThinking(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"赛事或全力自测意图\":\"信息不足\",\"强度与跑动连续性\":\"支持训练\"}"}}]}`))
	}))
	defer server.Close()

	classifier, err := NewChatCompletionsClassifier(ChatCompletionsConfig{
		Endpoint: server.URL, APIKey: "test-key", Model: "deepseek-v4-flash", Timeout: time.Second,
	})
	if err != nil {
		t.Fatalf("new classifier: %v", err)
	}
	if _, err := classifier.Assess(context.Background(), Candidate{}); err != nil {
		t.Fatalf("classify: %v", err)
	}
	thinking, ok := body["thinking"].(map[string]any)
	if !ok || thinking["type"] != "disabled" {
		t.Fatalf("DeepSeek thinking = %#v, want disabled", body["thinking"])
	}
}

func TestLocalizeTrainKindCoversEveryNormalizedValue(t *testing.T) {
	for _, kind := range []string{
		"base", "aerobic", "threshold", "interval", "vo2max", "anaerobic",
		"sprint", "recovery", "long_run", "race", "tempo", "unknown",
	} {
		if got := localizeTrainKind(kind); got == kind {
			t.Errorf("training kind %q was not translated", kind)
		}
	}
}

func int64ptr(v int64) *int64       { return &v }
func float64ptr(v float64) *float64 { return &v }

func TestChatCompletionsClassifierRejectsMalformedDecisions(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{"no choices", "{\"choices\":[]}"},
		{"invalid assessment JSON", "{\"choices\":[{\"message\":{\"content\":\"true\"}}]}"},
		{"missing dimensions", "{\"choices\":[{\"message\":{\"content\":\"{}\"}}]}"},
		{"unexpected field", "{\"choices\":[{\"message\":{\"content\":\"{\\\"赛事或全力自测意图\\\":\\\"信息不足\\\",\\\"强度与跑动连续性\\\":\\\"信息不足\\\",\\\"reason\\\":\\\"x\\\"}\"}}]}"},
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
			if _, err := classifier.Assess(context.Background(), Candidate{}); err == nil {
				t.Fatal("malformed assessment must fail")
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
