package routethumbnails

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/thumbnail"
)

// ShapeBackfillJobType is the internal compute-only backfill (devops#830): it
// fills route_thumb_json for activities synced before the sync pipeline wrote
// it, without rendering a PNG or touching COS. It exists separately from
// BackfillJobType because that one's job is the URL — an operator runs this
// instead when only the shape channel is missing (e.g. a row already has a
// legacy PNG URL but no polyline).
const ShapeBackfillJobType = "route_thumbnails_shape_backfill"

// ShapeStore is the slice of storage the shape backfill needs — the PNG
// handler's Store minus everything upload-shaped. Keeping it a separate,
// smaller interface states at the type level that this job cannot write the
// URL column even if handed the full store.
type ShapeStore interface {
	RouteThumbShapeCandidates(ctx context.Context, userID string) ([]string, error)
	ActivityTimeseries(ctx context.Context, userID, labelID string) ([]storage.TimeseriesPoint, error)
	SetActivityRouteThumbJSON(ctx context.Context, userID, labelID, thumbJSON string) error
}

type shapeResult struct {
	Candidates int `json:"candidates"`
	Generated  int `json:"generated"`
	NoGPS      int `json:"no_gps"`
	Failed     int `json:"failed"`
}

// NewShapeBackfill builds the compute-only shape backfill handler: read the
// timeseries, Compute the polyline, persist route_thumb_json, nothing else.
// The candidate query selects only rows still missing their shape, so the job
// is idempotent and a rerun over the same athlete is a no-op. Like the PNG
// handler it is partial-success: per-activity failures are collected and joined
// so the job reports what did land before failing.
func NewShapeBackfill(store ShapeStore) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		if _, err := uuid.Parse(j.UserID); err != nil {
			return "", job.NewPermanentError("bad_partition", fmt.Errorf("route thumb shape backfill: user must be UUID: %w", err))
		}

		candidates, err := store.RouteThumbShapeCandidates(ctx, j.UserID)
		if err != nil {
			return "", err
		}
		_ = hb("route_thumbnails", 5)

		var out shapeResult
		out.Candidates = len(candidates)
		var failures []error

		for i, labelID := range candidates {
			points, err := store.ActivityTimeseries(ctx, j.UserID, labelID)
			if err != nil {
				failures = append(failures, fmt.Errorf("activity %s: read timeseries: %w", labelID, err))
				continue
			}
			polyline, ok := thumbnail.Compute(toSamples(points))
			if !ok {
				// Fewer valid fixes than the cutoff (or has_gps lied): skip
				// without writing, so the column keeps meaning "a drawable
				// shape" and the client keeps its icon fallback.
				out.NoGPS++
				continue
			}
			if err := store.SetActivityRouteThumbJSON(ctx, j.UserID, labelID, thumbnail.JSON(polyline)); err != nil {
				failures = append(failures, fmt.Errorf("activity %s: persist: %w", labelID, err))
				continue
			}
			out.Generated++
			if i%progressEvery == 0 {
				_ = hb("route_thumbnails", (i+1)*100/len(candidates))
			}
		}

		out.Failed = len(failures)
		result, _ := json.Marshal(out)
		if len(failures) > 0 {
			return string(result), errors.Join(failures...)
		}
		_ = hb("route_thumbnails", 100)
		return string(result), nil
	}
}
