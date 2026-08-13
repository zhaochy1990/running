// Package racedetection adapts the independent race detector to async jobs.
package racedetection

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
	detector "github.com/zhaochy1990/stride/internal/racedetection"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

const (
	JobType         = "race_detection"
	BackfillJobType = "race_detection_backfill"
)

type Store interface {
	RaceCandidates(ctx context.Context, userID string, labelIDs []string) ([]storage.RaceCandidate, error)
	ActivityStartCoordinates(ctx context.Context, userID string) ([]detector.Coordinate, error)
	ActivityTimeseries(ctx context.Context, userID, labelID string) ([]storage.TimeseriesPoint, error)
	InsertRace(ctx context.Context, race *storage.Race) error
}

type detectionInput struct {
	Mode        string   `json:"mode,omitempty"`
	LabelIDs    []string `json:"label_ids,omitempty"`
	HealthDates []string `json:"health_dates,omitempty"`
}

type detectionResult struct {
	Mode        string   `json:"mode,omitempty"`
	LabelIDs    []string `json:"label_ids,omitempty"`
	HealthDates []string `json:"health_dates,omitempty"`
	Candidates  int      `json:"candidates"`
	Confirmed   int64    `json:"confirmed"`
}

// New builds the sync-pipeline handler. Each confirmed activity is committed
// immediately. Candidate failures do not stop other workers; after all
// candidates finish, errors.Join makes the job retry/fail while the pipeline's
// ContinueOnFailure policy advances to compute.
func New(store Store, raceDetector *detector.Detector, maxConcurrency int) job.Handler {
	return newHandler(store, raceDetector, maxConcurrency, false)
}

// NewBackfill builds the internal one-time all-history handler.
func NewBackfill(store Store, raceDetector *detector.Detector, maxConcurrency int) job.Handler {
	return newHandler(store, raceDetector, maxConcurrency, true)
}

func newHandler(store Store, raceDetector *detector.Detector, maxConcurrency int, backfill bool) job.Handler {
	if maxConcurrency < 1 {
		maxConcurrency = 1
	}
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		if _, err := uuid.Parse(j.UserID); err != nil {
			return "", job.NewPermanentError("bad_partition", fmt.Errorf("race detection: user must be UUID: %w", err))
		}
		var in detectionInput
		if j.InputJSON != "" {
			if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
				return "", job.NewPermanentError("bad_payload", fmt.Errorf("race detection: parse input: %w", err))
			}
		}
		labelIDs := in.LabelIDs
		if backfill {
			labelIDs = nil
		} else if labelIDs == nil {
			labelIDs = []string{}
		}
		candidates, err := store.RaceCandidates(ctx, j.UserID, labelIDs)
		if err != nil {
			return "", err
		}
		var starts []detector.Coordinate
		var usualArea *detector.UsualActivityArea
		if len(candidates) > 0 {
			starts, err = store.ActivityStartCoordinates(ctx, j.UserID)
			if err != nil {
				return "", err
			}
			usualArea = detector.InferUsualActivityArea(starts)
		}
		_ = hb("race_detection", 5)

		jobs := make(chan storage.RaceCandidate)
		var confirmed atomic.Int64
		var wg sync.WaitGroup
		var errorMu sync.Mutex
		var candidateErrors []error
		worker := func() {
			defer wg.Done()
			for row := range jobs {
				points, classifyErr := store.ActivityTimeseries(ctx, j.UserID, row.LabelID)
				var isRace bool
				if classifyErr == nil {
					candidate := toCandidate(row, points)
					candidate.Location = detector.LocationContextForTrace(usualArea, candidate.Trace)
					classification, err := raceDetector.DetectWithUsage(ctx, candidate)
					isRace, classifyErr = classification.IsRace, err
					logTokenUsage(logging.Default(), j.UserID, row.LabelID, classification.Usage)
					if classifyErr == nil {
						logClassification(logging.Default(), j.UserID, row.LabelID, classification)
					}
				}
				if classifyErr == nil && isRace {
					classifyErr = store.InsertRace(ctx, &storage.Race{
						UserID: j.UserID, LabelID: row.LabelID, CreatedAt: time.Now().UTC(),
					})
					if classifyErr == nil {
						confirmed.Add(1)
					}
				}
				if classifyErr != nil {
					errorMu.Lock()
					candidateErrors = append(candidateErrors, fmt.Errorf("activity %s: %w", row.LabelID, classifyErr))
					errorMu.Unlock()
				}
			}
		}
		workers := min(maxConcurrency, len(candidates))
		for range workers {
			wg.Add(1)
			go worker()
		}
		for _, candidate := range candidates {
			jobs <- candidate
		}
		close(jobs)
		wg.Wait()

		result, _ := json.Marshal(detectionResult{
			Mode:        in.Mode,
			LabelIDs:    in.LabelIDs,
			HealthDates: in.HealthDates,
			Candidates:  len(candidates),
			Confirmed:   confirmed.Load(),
		})
		if len(candidateErrors) > 0 {
			return string(result), errors.Join(candidateErrors...)
		}
		_ = hb("race_detection", 100)
		return string(result), nil
	}
}

func logTokenUsage(log *zap.Logger, userID, labelID string, usage detector.TokenUsage) {
	fields := []zap.Field{
		zap.String("user_id", userID),
		zap.String("label_id", labelID),
		zap.String("api_kind", usage.APIKind),
		zap.String("model", usage.Model),
		zap.Bool("usage_available", usage.Available),
	}
	if usage.Available {
		fields = append(fields,
			zap.Int("input_tokens", usage.InputTokens),
			zap.Int("output_tokens", usage.OutputTokens),
			zap.Int("total_tokens", usage.TotalTokens),
		)
	}
	log.Info("race detection token usage", fields...)
}

func logClassification(log *zap.Logger, userID, labelID string, classification detector.ClassificationResult) {
	log.Info("race detection classification",
		zap.String("user_id", userID),
		zap.String("label_id", labelID),
		zap.Bool("is_race", classification.IsRace),
		zap.Int("score", classification.Score),
		zap.Int("threshold", classification.Threshold),
		zap.String("event_intent", string(classification.Assessment.EventIntent)),
		zap.String("intensity_continuity", string(classification.Assessment.IntensityContinuity)),
		zap.String("route_shape", string(classification.Route.Shape)),
		zap.Int("route_valid_points", classification.Route.ValidPoints),
		zap.Int("route_ignored_jump_points", classification.Route.IgnoredJumpPoints),
		zap.Float64("route_path_length_m", classification.Route.PathLengthM),
		zap.Float64("route_bounding_width_m", classification.Route.BoundingWidthM),
		zap.Float64("route_bounding_height_m", classification.Route.BoundingHeightM),
		zap.Float64("route_start_end_distance_m", classification.Route.StartEndDistanceM),
		zap.Float64("route_path_to_perimeter", classification.Route.PathToPerimeter),
		zap.Float64("route_spatial_revisit_ratio", classification.Route.SpatialRevisitRatio),
		zap.Float64("route_out_and_back_match_ratio", classification.Route.OutAndBackMatchRatio),
		zap.Any("dimensions", classification.Dimensions),
	)
}

func toCandidate(row storage.RaceCandidate, points []storage.TimeseriesPoint) detector.Candidate {
	localStart := row.Date.In(timefmt.Shanghai)
	trace := make([]detector.TracePoint, len(points))
	for i, point := range points {
		trace[i] = detector.TracePoint{
			Timestamp: point.Timestamp, Latitude: point.GPSLat,
			Longitude: point.GPSLon, AltitudeM: point.Altitude,
		}
	}
	return detector.Candidate{
		LabelID: row.LabelID, Name: row.Name, Sport: row.Sport,
		Date: localStart.Format("2006-01-02 15:04:05"), Weekday: localStart.Weekday().String(), DistanceM: row.DistanceM,
		DurationS: row.DurationS, AvgPaceSKm: row.AvgPaceSKm, AvgHR: row.AvgHR,
		MaxHR: row.MaxHR, AscentM: row.AscentM, TrainKind: row.TrainKind,
		SportNote: row.SportNote, Trace: trace,
		Pauses: detector.ParsePauseContext(row.Pauses, timefmt.Shanghai),
	}
}
