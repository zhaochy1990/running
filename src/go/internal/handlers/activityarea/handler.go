// Package activityarea adapts usual-activity-area derivation to an async job.
package activityarea

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	area "github.com/zhaochy1990/stride/internal/activityarea"
	"github.com/zhaochy1990/stride/internal/job"
)

const JobType = "usual_activity_area"

type Store interface {
	UsualActivityArea(ctx context.Context, userID string) (*area.Snapshot, error)
	ActivityStartCoordinates(ctx context.Context, userID string) ([]area.Coordinate, error)
	SaveUsualActivityArea(ctx context.Context, userID string, usualArea *area.Area, computedAt time.Time) (bool, error)
}

// New builds the independent job that performs the expensive historical scan
// once and persists its derived result on the user's profile. A cached unknown
// is as terminal as a cached area; recomputation requires explicitly clearing
// the profile snapshot rather than accidentally repeating the scan.
func New(store Store) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		if _, err := uuid.Parse(j.UserID); err != nil {
			return "", job.NewPermanentError("bad_partition", fmt.Errorf("usual activity area: user must be UUID: %w", err))
		}
		var passthrough map[string]any
		if j.InputJSON != "" {
			if err := json.Unmarshal([]byte(j.InputJSON), &passthrough); err != nil {
				return "", job.NewPermanentError("bad_payload", fmt.Errorf("usual activity area: parse input: %w", err))
			}
		}
		cached, err := store.UsualActivityArea(ctx, j.UserID)
		if err != nil {
			return "", err
		}
		if cached == nil {
			return "", job.NewPermanentError("profile_not_found", fmt.Errorf("usual activity area: user profile not found"))
		}
		if cached.Computed {
			if passthrough == nil {
				passthrough = map[string]any{}
			}
			passthrough["status"] = "cached"
			passthrough["supporting_activities"] = 0
			if cached.Area != nil {
				passthrough["supporting_activities"] = cached.Area.SupportingActivityCount
			}
			result, _ := json.Marshal(passthrough)
			_ = hb("usual_activity_area", 100)
			return string(result), nil
		}
		starts, err := store.ActivityStartCoordinates(ctx, j.UserID)
		if err != nil {
			return "", err
		}
		_ = hb("usual_activity_area", 75)
		usualArea := area.Infer(starts)
		found, err := store.SaveUsualActivityArea(ctx, j.UserID, usualArea, time.Now().UTC())
		if err != nil {
			return "", err
		}
		if !found {
			return "", job.NewPermanentError("profile_not_found", fmt.Errorf("usual activity area: user profile not found"))
		}
		if passthrough == nil {
			passthrough = map[string]any{}
		}
		passthrough["status"] = "unknown"
		passthrough["supporting_activities"] = 0
		if usualArea != nil {
			passthrough["status"] = "computed"
			passthrough["supporting_activities"] = usualArea.SupportingActivityCount
		}
		result, _ := json.Marshal(passthrough)
		_ = hb("usual_activity_area", 100)
		return string(result), nil
	}
}
