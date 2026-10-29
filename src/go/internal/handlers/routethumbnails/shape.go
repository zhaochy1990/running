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
// it, without rendering a PNG or touching COS. It exists separately from the
// pipeline's route_shapes step so an operator can trigger the historical fill
// deliberately per athlete.
const ShapeBackfillJobType = "route_thumbnails_shape_backfill"

// ShapeStore is the slice of storage the shape fillers need — deliberately
// without anything upload-shaped or URL-shaped: neither the pipeline step nor
// the backfill can write route_thumb_url or touch COS even if handed the full
// store.
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
	// LabelIDs echoes the sync's threaded batch through to the next pipeline
	// step (set by the pipeline step; the operator-triggered backfill has none).
	LabelIDs []string `json:"label_ids,omitempty"`
}

// NewShapeBackfill builds the compute-only shape backfill handler: read the
// timeseries, Compute the polyline, persist route_thumb_json, nothing else.
// The candidate query selects only rows still missing their shape, so the job
// is idempotent and a rerun over the same athlete is a no-op. Like the retired
// PNG step it is partial-success: per-activity failures are collected and
// joined so the job reports what did land before failing.
func NewShapeBackfill(store ShapeStore) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		if err := parseShapeJob(j); err != nil {
			return "", err
		}
		out, err := fillShapes(ctx, store, j.UserID, hb)
		result, _ := json.Marshal(out)
		return string(result), err
	}
}

// parseShapeJob enforces the partition contract both shape fillers share: the
// subject must be a UUID.
func parseShapeJob(j *job.Job) error {
	if _, err := uuid.Parse(j.UserID); err != nil {
		return job.NewPermanentError("bad_partition", fmt.Errorf("route shapes: user must be UUID: %w", err))
	}
	return nil
}

// fillShapes is the shared body of both shape fillers: read the candidate
// activities' timeseries, Compute each polyline and persist route_thumb_json.
// Rows whose trace has too few valid fixes are counted as no_gps and left
// NULL on purpose, so the column keeps meaning "a drawable shape" and the
// client keeps its icon fallback.
func fillShapes(ctx context.Context, store ShapeStore, userID string, hb job.Heartbeat) (shapeResult, error) {
	candidates, err := store.RouteThumbShapeCandidates(ctx, userID)
	if err != nil {
		return shapeResult{}, err
	}
	_ = hb("route_shapes", 5)

	var out shapeResult
	out.Candidates = len(candidates)
	var failures []error

	for i, labelID := range candidates {
		points, err := store.ActivityTimeseries(ctx, userID, labelID)
		if err != nil {
			failures = append(failures, fmt.Errorf("activity %s: read timeseries: %w", labelID, err))
			continue
		}
		polyline, ok := thumbnail.Compute(toSamples(points))
		if !ok {
			out.NoGPS++
			continue
		}
		if err := store.SetActivityRouteThumbJSON(ctx, userID, labelID, thumbnail.JSON(polyline)); err != nil {
			failures = append(failures, fmt.Errorf("activity %s: persist: %w", labelID, err))
			continue
		}
		out.Generated++
		if i%progressEvery == 0 {
			_ = hb("route_shapes", (i+1)*100/len(candidates))
		}
	}

	out.Failed = len(failures)
	if len(failures) > 0 {
		return out, errors.Join(failures...)
	}
	_ = hb("route_shapes", 100)
	return out, nil
}

// toSamples narrows a time series to what the shape algorithm needs. A row
// missing either coordinate is marked invalid rather than treated as a fix at
// (0,0).
func toSamples(points []storage.TimeseriesPoint) []thumbnail.Sample {
	samples := make([]thumbnail.Sample, len(points))
	for i, p := range points {
		if p.GPSLat == nil || p.GPSLon == nil {
			continue
		}
		samples[i] = thumbnail.Sample{Lat: *p.GPSLat, Lon: *p.GPSLon, OK: true}
	}
	return samples
}
