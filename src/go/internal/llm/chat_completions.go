// Package llm provides a small, reusable OpenAI-compatible chat-completions
// client. It was extracted from internal/racedetection so the city-content
// ai-draft endpoint can reuse the same verified wire protocol without coupling
// to race-detection's domain types (issue #332). race-detection itself is
// deliberately left untouched for now.
package llm

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

// Config configures an OpenAI-compatible chat-completions endpoint.
type Config struct {
	Endpoint string
	APIKey   string
	Model    string
	Timeout  time.Duration
}

// ChatCompletions is a minimal OpenAI-compatible chat-completions client that
// always requests a JSON response.
type ChatCompletions struct {
	url    string
	apiKey string
	model  string
	client *http.Client
}

// NewChatCompletions validates cfg and returns a client that POSTs to
// <endpoint>/chat/completions.
func NewChatCompletions(cfg Config) (*ChatCompletions, error) {
	if strings.TrimSpace(cfg.Endpoint) == "" || strings.TrimSpace(cfg.APIKey) == "" || strings.TrimSpace(cfg.Model) == "" {
		return nil, errors.New("llm: endpoint, api key and model are required")
	}
	endpoint, err := url.ParseRequestURI(cfg.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("llm: invalid endpoint: %w", err)
	}
	if endpoint.Scheme == "" || endpoint.Host == "" {
		return nil, errors.New("llm: endpoint must be an absolute URL")
	}
	if cfg.Timeout <= 0 {
		return nil, errors.New("llm: timeout must be greater than zero")
	}
	return &ChatCompletions{
		url:    strings.TrimRight(cfg.Endpoint, "/") + "/chat/completions",
		apiKey: cfg.APIKey,
		model:  cfg.Model,
		client: &http.Client{Timeout: cfg.Timeout},
	}, nil
}

// CompleteJSON sends systemPrompt and userPrompt and decodes the first choice's
// message content strictly into out. out must be a non-nil pointer. The JSON is
// decoded with unknown fields rejected and no trailing data allowed, so a
// provider that drifts from the contract fails loudly.
func (c *ChatCompletions) CompleteJSON(ctx context.Context, systemPrompt, userPrompt string, out any) error {
	requestBody := map[string]any{
		"model": c.model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"response_format": map[string]string{"type": "json_object"},
		"max_tokens":      4096,
		"temperature":     0,
	}
	if strings.HasPrefix(strings.ToLower(c.model), "deepseek-") {
		requestBody["thinking"] = map[string]string{"type": "disabled"}
	}
	body, err := json.Marshal(requestBody)
	if err != nil {
		return fmt.Errorf("llm: marshal request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("llm: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("llm: complete: %w", err)
	}
	defer resp.Body.Close()
	limited := io.LimitReader(resp.Body, 1<<20)
	responseBody, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("llm: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("llm: provider returned HTTP %d", resp.StatusCode)
	}
	var response struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(responseBody, &response); err != nil {
		return fmt.Errorf("llm: decode response: %w", err)
	}
	if len(response.Choices) == 0 {
		return errors.New("llm: response has no choices")
	}
	return decodeJSON(response.Choices[0].Message.Content, out)
}

// decodeJSON decodes a strict JSON string into out.
func decodeJSON(content string, out any) error {
	decoder := json.NewDecoder(strings.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return fmt.Errorf("llm: decode content: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("llm: content contains trailing JSON")
	}
	return nil
}
