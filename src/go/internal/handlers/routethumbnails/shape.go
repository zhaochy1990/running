package routethumbnails

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
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

// shapeBackfillInputKeys are the keys the backfill payload accepts: the json
// tags of shapeBackfillInput, kept in sync by hand. decodeShapeBackfillInput
// enforces here what the catalog's schema promises for this job
// (additionalProperties:false).
var shapeBackfillInputKeys = []string{"date_from", "date_to"}

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
// over the same athlete and window is a no-op. The payload is checked before
// anything is read or written: a malformed or reversed window and any unknown
// key fail permanently as bad_payload. Like the retired PNG step it is
// partial-success: per-activity failures are collected and joined so the job
// reports what did land before failing.
func NewShapeBackfill(store ShapeStore) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		if err := parseShapeJob(j); err != nil {
			return "", err
		}
		in, err := decodeShapeBackfillInput(j.InputJSON)
		if err != nil {
			return "", job.NewPermanentError("bad_payload", fmt.Errorf("route shapes: %w", err))
		}
		if err := validateScopeDate(in.DateFrom); err != nil {
			return "", job.NewPermanentError("bad_payload", fmt.Errorf("route shapes: date_from: %w", err))
		}
		if err := validateScopeDate(in.DateTo); err != nil {
			return "", job.NewPermanentError("bad_payload", fmt.Errorf("route shapes: date_to: %w", err))
		}
		// A reversed window matches no rows, so without this guard the job
		// "succeeds" with zero candidates — indistinguishable from the no-op
		// rerun the candidate query is designed to produce. Both bounds are
		// validated YYYY-MM-DD by now, so string order is date order.
		if in.DateFrom != "" && in.DateTo != "" && in.DateFrom > in.DateTo {
			return "", job.NewPermanentError("bad_payload", errors.New("route shapes: date_from must not be after date_to"))
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
// than a loud permanent failure. A reversed window is the same failure for the
// same reason and is refused in NewShapeBackfill once both bounds parse.
func validateScopeDate(s string) error {
	if s == "" {
		return nil
	}
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return errors.New("must be YYYY-MM-DD")
	}
	return nil
}

// decodeShapeBackfillInput parses the backfill payload, refusing keys it does
// not know instead of dropping them. A plain Unmarshal ignores unknown keys,
// so a mistyped window (from/to instead of date_from/date_to) would decode as
// the empty payload — whose meaning is "recompute the athlete's whole stale
// set" — and one typo would widen a bounded recompute into an unbounded one.
// Keys are matched exactly; a JSON null decodes as the empty payload, like an
// absent input.
func decodeShapeBackfillInput(inputJSON string) (shapeBackfillInput, error) {
	var in shapeBackfillInput
	if inputJSON == "" {
		return in, nil
	}
	raw := []byte(inputJSON)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return in, fmt.Errorf("parse input: %w", err)
	}
	var unknown []string
	for key := range fields {
		if !slices.Contains(shapeBackfillInputKeys, key) {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		slices.Sort(unknown)
		return in, fmt.Errorf("unknown keys: %s (accepted: %s)",
			strings.Join(unknown, ", "), strings.Join(shapeBackfillInputKeys, ", "))
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return in, fmt.Errorf("parse input: %w", err)
	}
	return in, nil
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
