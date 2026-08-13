package racedetection

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const classifierSystemPrompt = `你只负责评估候选半马或全马活动的两个语义维度，不负责计算分数，也不直接判断最终是否为比赛。正式赛事与个人全力半马/全马测试都属于比赛。

每个维度只能选择“支持比赛”“支持训练”“信息不足”：
1. “赛事或全力自测意图”：根据活动名称、备注，以及城市和精确日期是否明确对应真实赛事判断。默认“<城市> 跑步”和空备注不能作为训练证据；手表训练分类也不代表主观意图。只有名称/备注明确是训练计划时才支持训练，明确赛事或全力测试/PB时支持比赛，否则信息不足。可以使用确定的通用赛事知识，但不能因为某城市可能在某天办赛而猜测。
2. “强度与跑动连续性”：根据用时、平均配速、平均/最高心率判断是否像连续全力完成。不要使用星期、时刻、距离先验、暂停、路线形态或异地信息；这些由 Go 代码独立评分。指标不足时选择信息不足。

只输出严格匹配以下结构的 JSON，不得输出其它字段或文字：
{"赛事或全力自测意图":"支持比赛|支持训练|信息不足","强度与跑动连续性":"支持比赛|支持训练|信息不足"}`

// ChatCompletionsConfig configures an OpenAI-compatible Chat Completions
// endpoint. It is owned by race detection and does not read Coach configuration.
type ChatCompletionsConfig struct {
	Endpoint string
	APIKey   string
	Model    string
	Timeout  time.Duration
}

// ChatCompletionsClassifier calls /chat/completions with JSON response format.
type ChatCompletionsClassifier struct {
	url    string
	apiKey string
	model  string
	client *http.Client
}

func NewChatCompletionsClassifier(cfg ChatCompletionsConfig) (*ChatCompletionsClassifier, error) {
	if strings.TrimSpace(cfg.Endpoint) == "" || strings.TrimSpace(cfg.APIKey) == "" || strings.TrimSpace(cfg.Model) == "" {
		return nil, errors.New("race detection: endpoint, api key and model are required")
	}
	endpoint, err := url.ParseRequestURI(cfg.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("race detection: invalid endpoint: %w", err)
	}
	if endpoint.Scheme == "" || endpoint.Host == "" {
		return nil, errors.New("race detection: endpoint must be an absolute URL")
	}
	if cfg.Timeout <= 0 {
		return nil, errors.New("race detection: timeout must be greater than zero")
	}
	return &ChatCompletionsClassifier{
		url:    strings.TrimRight(cfg.Endpoint, "/") + "/chat/completions",
		apiKey: cfg.APIKey,
		model:  cfg.Model,
		client: &http.Client{Timeout: cfg.Timeout},
	}, nil
}

func (c *ChatCompletionsClassifier) Assess(ctx context.Context, candidate Candidate) (ModelAssessment, error) {
	result, err := c.AssessWithUsage(ctx, candidate)
	return result.Assessment, err
}

// AssessWithUsage returns the Chat Completions usage object without locally
// estimating token counts.
func (c *ChatCompletionsClassifier) AssessWithUsage(ctx context.Context, candidate Candidate) (ModelAssessmentResult, error) {
	result := ModelAssessmentResult{Usage: TokenUsage{APIKind: "chat-completions", Model: c.model}}
	activityJSON, err := localizedCandidateJSON(candidate)
	if err != nil {
		return result, fmt.Errorf("race detection: marshal candidate: %w", err)
	}
	requestBody := map[string]any{
		"model": c.model,
		"messages": []map[string]string{
			{"role": "system", "content": classifierSystemPrompt},
			{"role": "user", "content": candidateUserPrompt(activityJSON)},
		},
		"response_format": map[string]string{"type": "json_object"},
		"max_tokens":      2048,
		"temperature":     0,
	}
	if strings.HasPrefix(strings.ToLower(c.model), "deepseek-") {
		requestBody["thinking"] = map[string]string{"type": "disabled"}
	}
	body, err := json.Marshal(requestBody)
	if err != nil {
		return result, fmt.Errorf("race detection: marshal request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return result, fmt.Errorf("race detection: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return result, fmt.Errorf("race detection: classify: %w", err)
	}
	defer resp.Body.Close()
	limited := io.LimitReader(resp.Body, 1<<20)
	responseBody, err := io.ReadAll(limited)
	if err != nil {
		return result, fmt.Errorf("race detection: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return result, fmt.Errorf("race detection: provider returned HTTP %d", resp.StatusCode)
	}
	var response struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(responseBody, &response); err != nil {
		return result, fmt.Errorf("race detection: decode response: %w", err)
	}
	if response.Usage != nil {
		result.Usage.InputTokens = response.Usage.PromptTokens
		result.Usage.OutputTokens = response.Usage.CompletionTokens
		result.Usage.TotalTokens = response.Usage.TotalTokens
		result.Usage.Available = true
	}
	if len(response.Choices) == 0 {
		return result, errors.New("race detection: response has no choices")
	}
	result.Assessment, err = decodeAssessment(response.Choices[0].Message.Content)
	return result, err
}

func localizedCandidateJSON(candidate Candidate) ([]byte, error) {
	return json.Marshal(localizedCandidate{
		Name:           candidate.Name,
		Sport:          localizeSport(candidate.Sport),
		LocalStart:     candidate.Date,
		Weekday:        localizeWeekday(candidate.Weekday),
		DistanceM:      candidate.DistanceM,
		DurationS:      candidate.DurationS,
		AvgPaceSKm:     candidate.AvgPaceSKm,
		AvgHR:          candidate.AvgHR,
		MaxHR:          candidate.MaxHR,
		AscentM:        candidate.AscentM,
		WatchTrainKind: localizeTrainKind(candidate.TrainKind),
		SportNote:      candidate.SportNote,
		CandidateType:  localizeRaceType(candidate.CandidateType),
	})
}

func candidateUserPrompt(activityJSON []byte) string {
	return "请判断以下候选活动：\n" + string(activityJSON)
}

func decodeAssessment(content string) (ModelAssessment, error) {
	var assessment ModelAssessment
	decoder := json.NewDecoder(strings.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&assessment); err != nil {
		return ModelAssessment{}, fmt.Errorf("race detection: decode assessment: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ModelAssessment{}, errors.New("race detection: assessment contains trailing JSON")
	}
	if !validEvidence(assessment.EventIntent) || !validEvidence(assessment.IntensityContinuity) {
		return ModelAssessment{}, errors.New("race detection: assessment has invalid or missing evidence")
	}
	return assessment, nil
}

type localizedCandidate struct {
	Name           string   `json:"名称,omitempty"`
	Sport          string   `json:"运动类型"`
	LocalStart     string   `json:"本地开始时间"`
	Weekday        string   `json:"星期,omitempty"`
	DistanceM      float64  `json:"距离_米"`
	DurationS      *float64 `json:"用时_秒,omitempty"`
	AvgPaceSKm     *float64 `json:"平均配速_秒每公里,omitempty"`
	AvgHR          *int     `json:"平均心率,omitempty"`
	MaxHR          *int     `json:"最高心率,omitempty"`
	AscentM        *float64 `json:"累计爬升_米,omitempty"`
	WatchTrainKind string   `json:"手表训练分类,omitempty"`
	SportNote      string   `json:"运动备注,omitempty"`
	CandidateType  string   `json:"候选距离类型"`
}

func localizeSport(sport string) string {
	switch sport {
	case "run_outdoor":
		return "户外跑"
	case "run_track":
		return "操场跑"
	default:
		return sport
	}
}

func localizeRaceType(raceType RaceType) string {
	switch raceType {
	case RaceTypeHalfMarathon:
		return "半程马拉松"
	case RaceTypeMarathon:
		return "全程马拉松"
	default:
		return ""
	}
}

func localizeWeekday(weekday string) string {
	weekdays := map[string]string{
		"Monday": "星期一", "Tuesday": "星期二", "Wednesday": "星期三",
		"Thursday": "星期四", "Friday": "星期五", "Saturday": "星期六", "Sunday": "星期日",
	}
	if localized, ok := weekdays[weekday]; ok {
		return localized
	}
	return weekday
}

func localizeTrainKind(kind string) string {
	kinds := map[string]string{
		"base": "基础", "aerobic": "有氧", "threshold": "阈值", "interval": "间歇",
		"vo2max": "最大摄氧量", "anaerobic": "无氧", "sprint": "冲刺", "recovery": "恢复",
		"long_run": "长距离跑", "race": "比赛", "tempo": "节奏跑", "unknown": "未知",
	}
	if localized, ok := kinds[kind]; ok {
		return localized
	}
	return kind
}
