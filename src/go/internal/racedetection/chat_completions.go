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

const classifierSystemPrompt = `You classify running activities. Return true when the activity is either an organized race or a personal half-marathon/marathon time trial. Return false for ordinary long runs, workouts, paced training sessions, or insufficient evidence. Use only the supplied activity summary. Respond with JSON exactly matching {"is_race": boolean}.`

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
	if _, err := url.ParseRequestURI(cfg.Endpoint); err != nil {
		return nil, fmt.Errorf("race detection: invalid endpoint: %w", err)
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 30 * time.Second
	}
	return &ChatCompletionsClassifier{
		url:    strings.TrimRight(cfg.Endpoint, "/") + "/chat/completions",
		apiKey: cfg.APIKey,
		model:  cfg.Model,
		client: &http.Client{Timeout: cfg.Timeout},
	}, nil
}

func (c *ChatCompletionsClassifier) Classify(ctx context.Context, candidate Candidate) (bool, error) {
	activityJSON, err := json.Marshal(candidate)
	if err != nil {
		return false, fmt.Errorf("race detection: marshal candidate: %w", err)
	}
	body, err := json.Marshal(map[string]any{
		"model": c.model,
		"messages": []map[string]string{
			{"role": "system", "content": classifierSystemPrompt},
			{"role": "user", "content": string(activityJSON)},
		},
		"response_format": map[string]string{"type": "json_object"},
		"max_tokens":      32,
		"temperature":     0,
	})
	if err != nil {
		return false, fmt.Errorf("race detection: marshal request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return false, fmt.Errorf("race detection: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return false, fmt.Errorf("race detection: classify: %w", err)
	}
	defer resp.Body.Close()
	limited := io.LimitReader(resp.Body, 1<<20)
	responseBody, err := io.ReadAll(limited)
	if err != nil {
		return false, fmt.Errorf("race detection: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, fmt.Errorf("race detection: provider returned HTTP %d", resp.StatusCode)
	}
	var response struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(responseBody, &response); err != nil {
		return false, fmt.Errorf("race detection: decode response: %w", err)
	}
	if len(response.Choices) == 0 {
		return false, errors.New("race detection: response has no choices")
	}
	var decision struct {
		IsRace *bool `json:"is_race"`
	}
	if err := json.Unmarshal([]byte(response.Choices[0].Message.Content), &decision); err != nil {
		return false, fmt.Errorf("race detection: decode decision: %w", err)
	}
	if decision.IsRace == nil {
		return false, errors.New("race detection: decision omitted is_race")
	}
	return *decision.IsRace, nil
}
