package racedetection

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/config"
	detector "github.com/zhaochy1990/stride/internal/racedetection"
	"github.com/zhaochy1990/stride/internal/storage"
)

const goldenUserID = "11c2e582-5a85-4633-81d2-df7e37ad7b48"

type goldenTruth struct {
	labelID string
	isRace  bool
}

// The real-provider regressions are opt-in. The committed fixture contains only
// immutable activity references and the user's manually confirmed truth.
// Activity data come from local MySQL and label IDs are excluded from model
// input, so they cannot reveal the answer.
func TestDeepSeekRaceGoldenRegression(t *testing.T) {
	apiKey := os.Getenv("DEEPSEEK_API_KEY")
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if apiKey == "" || dsn == "" {
		t.Skip("set DEEPSEEK_API_KEY and STRIDE_WORKER_TEST_MYSQL_DSN to run the real golden regression")
	}

	classifier, err := detector.NewChatCompletionsClassifier(detector.ChatCompletionsConfig{
		Endpoint: "https://api.deepseek.com", APIKey: apiKey,
		Model: "deepseek-v4-flash", Timeout: 60 * time.Second,
	})
	if err != nil {
		t.Fatalf("new classifier: %v", err)
	}
	runRaceGoldenRegression(t, dsn, detector.New(classifier), 4, 60*time.Second)
}

func TestLunaRaceGoldenRegression(t *testing.T) {
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if os.Getenv("STRIDE_RUN_LUNA_RACE_GOLDEN") != "1" || dsn == "" {
		t.Skip("set STRIDE_RUN_LUNA_RACE_GOLDEN=1 and STRIDE_WORKER_TEST_MYSQL_DSN to run the Luna golden regression")
	}
	apiKey := os.Getenv("AGENT_MAESTRO_API_KEY")
	if apiKey == "" {
		apiKey = "local-race-golden"
	}
	classifier, err := detector.NewResponsesClassifier(detector.ResponsesConfig{
		Endpoint: "http://127.0.0.1:23333/api/openai/v1", APIKey: apiKey,
		Model: "gpt-5.6-luna", Timeout: 90 * time.Second,
	})
	if err != nil {
		t.Fatalf("new Luna classifier: %v", err)
	}
	runRaceGoldenRegression(t, dsn, detector.New(classifier), 4, 90*time.Second)
}

func TestConfiguredRaceGoldenRegression(t *testing.T) {
	if os.Getenv("STRIDE_RUN_CONFIGURED_RACE_GOLDEN") != "1" {
		t.Skip("set STRIDE_RUN_CONFIGURED_RACE_GOLDEN=1 to run the configured real-provider regression")
	}
	configPath := os.Getenv("CONFIG_PATH")
	if configPath == "" {
		configPath = "config.local.yml"
	}
	runtimeCfg := config.MustLoadRaceDetectionRuntimeFrom(configPath)
	cfg := runtimeCfg.RaceDetection
	classifier, err := detector.NewClassifier(detector.ProviderConfig{
		APIKind: cfg.APIKind, Endpoint: cfg.Endpoint, APIKey: cfg.APIKey,
		Model: cfg.Model, Timeout: cfg.Timeout,
	})
	if err != nil {
		t.Fatalf("configured race classifier: %v", err)
	}
	t.Logf("configured race provider: api_kind=%s model=%s endpoint=%s", cfg.APIKind, cfg.Model, cfg.Endpoint)
	runRaceGoldenRegression(t, runtimeCfg.MySQL.DSN, detector.New(classifier), cfg.MaxConcurrency, cfg.Timeout)
}

func runRaceGoldenRegression(t *testing.T, dsn string, raceDetector *detector.Detector, maxConcurrency int, requestTimeout time.Duration) {
	t.Helper()
	truth := loadGoldenTruth(t)
	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open local MySQL: %v", err)
	}
	defer store.Close()
	snapshot, err := store.UsualActivityArea(context.Background(), goldenUserID)
	if err != nil {
		t.Fatalf("read persisted usual activity area: %v", err)
	}
	if snapshot == nil {
		t.Fatal("usual activity area has not been computed; run usual_activity_area once before the golden regression")
	}
	usualArea := snapshot.Area
	type result struct {
		label              string
		activityTime       string
		want               bool
		got                bool
		err                error
		locationDistanceKM *float64
		classification     detector.ClassificationResult
		usage              detector.TokenUsage
	}
	results := make(chan result, len(truth))
	if maxConcurrency < 1 {
		t.Fatalf("race detection concurrency = %d, want >= 1", maxConcurrency)
	}
	if requestTimeout <= 0 {
		t.Fatalf("race detection timeout = %s, want > 0", requestTimeout)
	}
	sem := make(chan struct{}, maxConcurrency)
	var wg sync.WaitGroup
	for _, expected := range truth {
		expected := expected
		activity, readErr := store.ActivityByID(context.Background(), goldenUserID, expected.labelID)
		if readErr != nil {
			t.Fatalf("read activity %s: %v", expected.labelID, readErr)
		}
		if activity == nil {
			t.Fatalf("local activity %s is missing", expected.labelID)
		}
		points, readErr := store.ActivityTimeseries(context.Background(), goldenUserID, expected.labelID)
		if readErr != nil {
			t.Fatalf("read activity %s timeseries: %v", expected.labelID, readErr)
		}
		candidate := toCandidate(storage.RaceCandidate{
			LabelID: activity.LabelID, Name: valueOrZero(activity.Name), Sport: valueOrZero(activity.Sport),
			Date: activity.Date, DistanceM: valueOrZero(activity.DistanceM), DurationS: activity.DurationS,
			AvgPaceSKm: activity.AvgPaceSKm, AvgHR: activity.AvgHR, MaxHR: activity.MaxHR,
			AscentM: activity.AscentM, TrainKind: valueOrZero(activity.TrainKind), SportNote: valueOrZero(activity.SportNote),
			Pauses: activity.Pauses,
		}, points)
		candidate.Location = detector.LocationContextForTrace(usualArea, candidate.Trace)
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
			defer cancel()
			classification, detectErr := raceDetector.DetectWithUsage(ctx, candidate)
			var locationDistance *float64
			if candidate.Location != nil {
				locationDistance = candidate.Location.CandidateStartDistanceKM
			}
			results <- result{
				label: expected.labelID, activityTime: candidate.Date, want: expected.isRace, got: classification.IsRace, err: detectErr, locationDistanceKM: locationDistance,
				classification: classification, usage: classification.Usage,
			}
		}()
	}
	wg.Wait()
	close(results)

	var mismatches []string
	for got := range results {
		t.Logf(
			"race detection token usage: user_id=%s label_id=%s api_kind=%s model=%s usage_available=%t input_tokens=%d output_tokens=%d total_tokens=%d",
			goldenUserID, got.label, got.usage.APIKind, got.usage.Model, got.usage.Available, got.usage.InputTokens, got.usage.OutputTokens, got.usage.TotalTokens,
		)
		t.Logf(
			"race detection score: label_id=%s activity_time=%s is_race=%t score=%d threshold=%d event_intent=%s intensity_continuity=%s route=%s route_points=%d route_ignored_jump_points=%d route_path_m=%.1f route_bbox_m=%.1fx%.1f route_start_end_m=%.1f route_path_perimeter=%.2f route_spatial_revisit_ratio=%.2f route_out_back_ratio=%.2f dimensions=%s",
			got.label, got.activityTime, got.classification.IsRace, got.classification.Score, got.classification.Threshold,
			got.classification.Assessment.EventIntent, got.classification.Assessment.IntensityContinuity,
			got.classification.Route.Shape, got.classification.Route.ValidPoints, got.classification.Route.IgnoredJumpPoints, got.classification.Route.PathLengthM,
			got.classification.Route.BoundingWidthM, got.classification.Route.BoundingHeightM,
			got.classification.Route.StartEndDistanceM, got.classification.Route.PathToPerimeter, got.classification.Route.SpatialRevisitRatio,
			got.classification.Route.OutAndBackMatchRatio, formatDimensions(got.classification.Dimensions),
		)
		if got.err != nil {
			mismatches = append(mismatches, fmt.Sprintf("%s: error=%v", got.label, got.err))
		} else if got.got != got.want {
			mismatches = append(mismatches, fmt.Sprintf("%s: got=%t want=%t candidate_start_distance_km=%s", got.label, got.got, got.want, formatDistance(got.locationDistanceKM)))
		}
	}
	if len(mismatches) > 0 {
		t.Fatalf("%d/%d golden decisions mismatched:\n%s", len(mismatches), len(truth), strings.Join(mismatches, "\n"))
	}
}

func formatDistance(distance *float64) string {
	if distance == nil {
		return "unknown"
	}
	return fmt.Sprintf("%.1f", *distance)
}

func formatDimensions(dimensions []detector.ScoreContribution) string {
	parts := make([]string, 0, len(dimensions))
	for _, dimension := range dimensions {
		parts = append(parts, fmt.Sprintf("%s:%s:%+d", dimension.Dimension, dimension.Evidence, dimension.Contribution))
	}
	return strings.Join(parts, ",")
}

func loadGoldenTruth(t *testing.T) []goldenTruth {
	t.Helper()
	f, err := os.Open("testdata/race_golden_11c2e582.tsv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	var truth []goldenTruth
	scanner := bufio.NewScanner(f)
	for line := 1; scanner.Scan(); line++ {
		if strings.HasPrefix(scanner.Text(), "#") || scanner.Text() == "" {
			continue
		}
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) != 2 {
			t.Fatalf("fixture line %d has %d fields, want 2", line, len(fields))
		}
		want, parseErr := strconv.ParseBool(fields[1])
		if parseErr != nil {
			t.Fatalf("fixture line %d expected result: %v", line, parseErr)
		}
		truth = append(truth, goldenTruth{labelID: fields[0], isRace: want})
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(truth) != 28 {
		t.Fatalf("fixture cases = %d, want 28", len(truth))
	}
	return truth
}

func valueOrZero[T any](value *T) T {
	if value == nil {
		var zero T
		return zero
	}
	return *value
}
