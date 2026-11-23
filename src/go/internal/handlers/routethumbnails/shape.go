package routethumbnails

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/thumbnail"
)

// ShapeBackfillJobType is the operator-triggered historical recompute
// (devops#830, version-scoped in devops#1037): it recomputes route_thumb_json
// for activities whose stored shape is missing or older than the algorithm
// version the pipeline currently writes, without rendering a PNG or touching
// COS. It exists separately from the pipeline's route_shapes step so an
// operator can trigger the historical rewrite deliberately per athlete — a
// routine sync never upgrades history.
const ShapeBackfillJobType = "route_thumbnails_shape_backfill"

// ShapeStore is the slice of storage the shape fillers need — deliberately
// without anything upload-shaped or URL-shaped: neither the pipeline step nor
// the backfill can write route_thumb_url or touch COS even if handed the full
// store.
type ShapeStore interface {
	// RouteThumbShapeCandidates selects the sync step's gap set: rows that
	// have GPS but no stored shape at all.
	RouteThumbShapeCandidates(ctx context.Context, userID string) ([]string, error)
	// RouteThumbRecomputeCandidates selects the backfill's stale set: rows
	// whose stored shape version is below the current algorithm version
	// (NULL included), optionally narrowed to a Shanghai-date window.
	RouteThumbRecomputeCandidates(ctx context.Context, userID string, scope storage.RouteThumbRecomputeScope) ([]string, error)
	ActivityTimeseries(ctx context.Context, userID, labelID string) ([]storage.TimeseriesPoint, error)
	SetActivityRouteThumbJSON(ctx context.Context, userID, labelID, thumbJSON string) error
}

// shapeBackfillInput is the backfill job's optional payload: a Shanghai-date
// window narrowing the recompute. The empty payload recomputes the athlete's
// whole stale set.
type shapeBackfillInput struct {
	DateFrom string `json:"date_from,omitempty"` // Shanghai YYYY-MM-DD; "" = no lower bound
	DateTo   string `json:"date_to,omitempty"`   // Shanghai YYYY-MM-DD; "" = no upper bound
}

type shapeResult struct {
	Candidates int `json:"candidates"`
	Generated  int `json:"generated"`
	NoGPS      int `json:"no_gps"`
	Failed     int `json:"failed"`
	// Version reports the algorithm version this run wrote, so an operator
	// reading a job result can tell which shape generation landed.
	Version int `json:"version"`
	// LabelIDs echoes the sync's threaded batch through to the next pipeline
	// step (set by the pipeline step; the operator-triggered backfill has none).
	LabelIDs []string `json:"label_ids,omitempty"`
}

// NewShapeBackfill builds the operator-triggered historical recompute handler:
// read the timeseries of every activity whose stored shape is stale (missing
// or pre-current-version), ComputeV2 the multi-stroke shape and persist it in
// the versioned serialization, nothing else. The candidate query drops rows
// once they carry the current version, so the job is idempotent and a rerun
// over the same athlete and window is a no-op. Like the retired PNG step it
// is partial-success: per-activity failures are collected and joined so the
// job reports what did land before failing.
func NewShapeBackfill(store ShapeStore) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		if err := parseShapeJob(j); err != nil {
			return "", err
		}
		var in shapeBackfillInput
		if j.InputJSON != "" {
			if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
				return "", job.NewPermanentError("bad_payload", fmt.Errorf("route shapes: parse input: %w", err))
			}
		}
		if err := validateScopeDate(in.DateFrom); err != nil {
			return "", job.NewPermanentError("bad_payload", fmt.Errorf("route shapes: date_from: %w", err))
		}
		if err := validateScopeDate(in.DateTo); err != nil {
			return "", job.NewPermanentError("bad_payload", fmt.Errorf("route shapes: date_to: %w", err))
		}
		scope := storage.RouteThumbRecomputeScope{DateFrom: in.DateFrom, DateTo: in.DateTo}
		candidates, err := store.RouteThumbRecomputeCandidates(ctx, j.UserID, scope)
		if err != nil {
			return "", err
		}
		out, err := fillShapes(ctx, store, j.UserID, candidates, hb)
		result, _ := json.Marshal(out)
		return string(result), err
	}
}

// validateScopeDate rejects anything but a real YYYY-MM-DD date: a malformed
// window would silently match no rows in SQL (string compare against a DATE),
// and an operator recompute that "succeeds" while touching nothing is worse
// than a loud permanent failure.
func validateScopeDate(s string) error {
	if s == "" {
		return nil
	}
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return errors.New("must be YYYY-MM-DD")
	}
	return nil
}

// parseShapeJob enforces the partition contract both shape fillers share: the
// subject must be a UUID.
func parseShapeJob(j *job.Job) error {
	if _, err := uuid.Parse(j.UserID); err != nil {
		return job.NewPermanentError("bad_partition", fmt.Errorf("route shapes: user must be UUID: %w", err))
	}
	return nil
}

// fillShapes is the shared body of both shape fillers: for each candidate
// activity, read the timeseries, ComputeV2 the version-2 multi-stroke shape
// and persist it in the new serialization (devops#1037). Rows whose trace has
// too few valid fixes are counted as no_gps and left NULL on purpose, so the
// column keeps meaning "a drawable shape" and the client keeps its icon
// fallback.
func fillShapes(ctx context.Context, store ShapeStore, userID string, candidates []string, hb job.Heartbeat) (shapeResult, error) {
	_ = hb("route_shapes", 5)

	var out shapeResult
	out.Candidates = len(candidates)
	out.Version = thumbnail.ShapeVersion
	var failures []error

	for i, labelID := range candidates {
		points, err := store.ActivityTimeseries(ctx, userID, labelID)
		if err != nil {
			failures = append(failures, fmt.Errorf("activity %s: read timeseries: %w", labelID, err))
			continue
		}
		shape, ok := thumbnail.ComputeV2(toSamples(points))
		if !ok {
			out.NoGPS++
			continue
		}
		if err := store.SetActivityRouteThumbJSON(ctx, userID, labelID, thumbnail.EncodeV2(shape)); err != nil {
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
// (0,0). Timestamps are stored in centiseconds; Sample.Ts is seconds, so a
// missing timestamp maps to 0 ("unknown"), which ComputeV2 treats as never
// splitting the trace.
func toSamples(points []storage.TimeseriesPoint) []thumbnail.Sample {
	samples := make([]thumbnail.Sample, len(points))
	for i, p := range points {
		if p.GPSLat == nil || p.GPSLon == nil {
			continue
		}
		s := thumbnail.Sample{Lat: *p.GPSLat, Lon: *p.GPSLon, OK: true}
		if p.Timestamp != nil {
			s.Ts = *p.Timestamp / 100
		}
		samples[i] = s
	}
	return samples
}
