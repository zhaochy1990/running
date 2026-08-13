package racedetection

import (
	"fmt"
	"time"
)

// ProviderConfig is the protocol-neutral model configuration used by both the
// worker and real-provider golden tests.
type ProviderConfig struct {
	APIKind  string
	Endpoint string
	APIKey   string
	Model    string
	Timeout  time.Duration
}

// NewClassifier selects the configured OpenAI-compatible protocol adapter.
func NewClassifier(cfg ProviderConfig) (Classifier, error) {
	switch cfg.APIKind {
	case "chat-completions":
		return NewChatCompletionsClassifier(ChatCompletionsConfig{
			Endpoint: cfg.Endpoint, APIKey: cfg.APIKey, Model: cfg.Model, Timeout: cfg.Timeout,
		})
	case "responses":
		return NewResponsesClassifier(ResponsesConfig{
			Endpoint: cfg.Endpoint, APIKey: cfg.APIKey, Model: cfg.Model, Timeout: cfg.Timeout,
		})
	default:
		return nil, fmt.Errorf("race detection: unsupported api kind %q", cfg.APIKind)
	}
}
