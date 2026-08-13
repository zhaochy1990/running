package main

import (
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/config"
	"github.com/zhaochy1990/stride/internal/racedetection"
)

func TestNewRaceClassifierSelectsConfiguredAPIKind(t *testing.T) {
	for _, test := range []struct {
		apiKind string
		check   func(racedetection.Classifier) bool
	}{
		{"chat-completions", func(c racedetection.Classifier) bool {
			_, ok := c.(*racedetection.ChatCompletionsClassifier)
			return ok
		}},
		{"responses", func(c racedetection.Classifier) bool { _, ok := c.(*racedetection.ResponsesClassifier); return ok }},
	} {
		classifier, err := newRaceClassifier(config.RaceDetection{
			APIKind: test.apiKind, Endpoint: "https://example.com", APIKey: "key", Model: "model", Timeout: time.Second,
		})
		if err != nil || !test.check(classifier) {
			t.Errorf("api kind %q = (%T, %v)", test.apiKind, classifier, err)
		}
	}
}
