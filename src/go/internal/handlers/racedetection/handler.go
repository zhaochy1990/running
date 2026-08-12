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

	"github.com/zhaochy1990/stride/internal/job"
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
		_ = hb("race_detection", 5)

		jobs := make(chan storage.RaceCandidate)
		var confirmed atomic.Int64
		var wg sync.WaitGroup
		var errorMu sync.Mutex
		var candidateErrors []error
		worker := func() {
			defer wg.Done()
			for row := range jobs {
				candidate := toCandidate(row)
				isRace, classifyErr := raceDetector.Detect(ctx, candidate)
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
			Mode: in.Mode, LabelIDs: in.LabelIDs, HealthDates: in.HealthDates,
			Candidates: len(candidates), Confirmed: confirmed.Load(),
		})
		if len(candidateErrors) > 0 {
			return string(result), errors.Join(candidateErrors...)
		}
		_ = hb("race_detection", 100)
		return string(result), nil
	}
}

func toCandidate(row storage.RaceCandidate) detector.Candidate {
	return detector.Candidate{
		LabelID: row.LabelID, Name: row.Name, Sport: row.Sport,
		Date: row.Date.In(timefmt.Shanghai).Format("2006-01-02"), DistanceM: row.DistanceM,
		DurationS: row.DurationS, AvgPaceSKm: row.AvgPaceSKm, AvgHR: row.AvgHR,
		MaxHR: row.MaxHR, AscentM: row.AscentM, TrainKind: row.TrainKind,
		SportNote: row.SportNote,
	}
}
