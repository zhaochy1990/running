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

// ResponsesConfig configures an OpenAI-compatible Responses endpoint.
type ResponsesConfig struct {
	Endpoint string
	APIKey   string
	Model    string
	Timeout  time.Duration
}

// ResponsesClassifier calls /responses and applies the same strict semantic
// assessment decoder as the Chat Completions adapter. Some compatible bridges ignore
// structured-output declarations, so correctness never relies on them.
type ResponsesClassifier struct {
	url    string
	apiKey string
	model  string
	client *http.Client
}

func NewResponsesClassifier(cfg ResponsesConfig) (*ResponsesClassifier, error) {
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
	return &ResponsesClassifier{
		url: strings.TrimRight(cfg.Endpoint, "/") + "/responses", apiKey: cfg.APIKey,
		model: cfg.Model, client: &http.Client{Timeout: cfg.Timeout},
	}, nil
}

func (c *ResponsesClassifier) Assess(ctx context.Context, candidate Candidate) (ModelAssessment, error) {
	result, err := c.AssessWithUsage(ctx, candidate)
	return result.Assessment, err
}

// AssessWithUsage returns the Responses API usage object without locally
// estimating token counts.
func (c *ResponsesClassifier) AssessWithUsage(ctx context.Context, candidate Candidate) (ModelAssessmentResult, error) {
	result := ModelAssessmentResult{Usage: TokenUsage{APIKind: "responses", Model: c.model}}
	activityJSON, err := localizedCandidateJSON(candidate)
	if err != nil {
		return result, fmt.Errorf("race detection: marshal candidate: %w", err)
	}
	body, err := json.Marshal(map[string]any{
		"model": c.model,
		"input": []map[string]string{
			{"role": "system", "content": classifierSystemPrompt},
			{"role": "user", "content": candidateUserPrompt(activityJSON)},
		},
		"reasoning":         map[string]string{"effort": "low"},
		"max_output_tokens": 2048,
	})
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
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return result, fmt.Errorf("race detection: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return result, fmt.Errorf("race detection: provider returned HTTP %d", resp.StatusCode)
	}
	var response struct {
		Output []struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
		Usage *struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
			TotalTokens  int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(responseBody, &response); err != nil {
		return result, fmt.Errorf("race detection: decode response: %w", err)
	}
	if response.Usage != nil {
		result.Usage.InputTokens = response.Usage.InputTokens
		result.Usage.OutputTokens = response.Usage.OutputTokens
		result.Usage.TotalTokens = response.Usage.TotalTokens
		result.Usage.Available = true
	}
	var outputText strings.Builder
	for _, item := range response.Output {
		if item.Type != "message" {
			continue
		}
		for _, content := range item.Content {
			if content.Type == "output_text" {
				outputText.WriteString(content.Text)
			}
		}
	}
	if outputText.Len() == 0 {
		return result, errors.New("race detection: response has no output text")
	}
	result.Assessment, err = decodeAssessment(outputText.String())
	return result, err
}
