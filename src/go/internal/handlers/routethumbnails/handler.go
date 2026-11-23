// Package routethumbnails produces the activities.route_thumb_json shape
// channel: a versioned multi-stroke route shape per outdoor activity (the v2
// `{"v":2,...}` object of devops#1036/#1037; rows filled before the upgrade
// still carry the legacy ≤60-point polyline), drawn client-side (mp canvas /
// iOS Path) as the route thumbnail.
//
// The PNG half of this package — render, COS upload and the route_thumb_url
// column — was retired in devops#829 after both clients moved to vector
// drawing (devops#827/#828). What remains:
//
//   - NewShapes is the sync pipelines' route_shapes step (after compute): it
//     fills route_thumb_json for the subject athlete's activities that have
//     GPS but no stored shape, and threads the sync's label_ids through.
//   - NewShapeBackfill (shape.go, devops#830, version-scoped in devops#1037)
//     is the operator-triggered per-athlete recompute over historical rows
//     whose stored shape is missing or older than the current algorithm
//     version, optionally narrowed to a date window.
//   - NewDeprecated is the one-version tombstone for the retired
//     route_thumbnails job type, so in-flight pipeline runs whose stored
//     definitions still carry the old step dispatch cleanly instead of
//     terminally failing on an unknown job type.
//
// The sync step deliberately fills only missing shapes, never upgrades stale
// versions: a routine sync must not kick off a bulk historical rewrite, which
// is what the backfill job exists to do deliberately.
//
// Shapes are cosmetic, so every failure mode here degrades to "no shape" (the
// client keeps its sport-icon fallback) rather than to "sync failed".
package routethumbnails

import (
	"context"
	"encoding/json"
	"fmt"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
)

const (
	// JobType is the retired PNG-rendering step (devops#829). Deprecated: kept
	// one version as a no-op tombstone — see NewDeprecated.
	JobType = "route_thumbnails"
	// ShapesJobType is the sync-pipeline shape step that replaced the PNG step:
	// it fills route_thumb_json without rendering or uploading anything.
	ShapesJobType = "route_shapes"

	// progressEvery bounds heartbeat writes on a long fill: one UPDATE per
	// activity would cost more than the work being reported.
	progressEvery = 25
)

// NewDeprecated builds the one-version no-op tombstone for the retired
// route_thumbnails PNG job (devops#829). It logs a deprecation warning, echoes
// the input's label_ids through to its result and reports skipped — nothing is
// rendered, uploaded or written. Old in-flight pipeline runs (stored step
// definitions predating the retirement) and stale operator triggers land here
// and advance their pipeline instead of terminally failing at dispatch; the
// label_ids echo keeps the downstream ability step's batch threading intact.
// Delete together with the catalog entry once no pre-retirement run can still
// be alive.
func NewDeprecated(log *zap.Logger) job.Handler {
	return func(_ context.Context, j *job.Job, _ job.Heartbeat) (string, error) {
		if log != nil {
			log.Warn("route_thumbnails is deprecated (devops#829): PNG rendering retired, job is a no-op",
				zap.String("job_id", j.ID),
				zap.String("user_id", j.UserID),
			)
		}
		// Best-effort parse: a tombstone must not fail, and the only field
		// worth recovering is the pipeline's label_ids batch.
		var in struct {
			LabelIDs []string `json:"label_ids,omitempty"`
		}
		if j.InputJSON != "" {
			_ = json.Unmarshal([]byte(j.InputJSON), &in)
		}
		result, _ := json.Marshal(struct {
			Skipped  string   `json:"skipped"`
			LabelIDs []string `json:"label_ids,omitempty"`
		}{Skipped: "png_pipeline_retired", LabelIDs: in.LabelIDs})
		return string(result), nil
	}
}

// NewShapes builds the sync pipelines' route_shapes step: fill the subject
// athlete's route_thumb_json gaps (RouteThumbShapeCandidates selects only rows
// that have GPS but no stored shape), and echo the sync's label_ids batch
// through to the result so the downstream ability step keeps seeing it.
// Newly-written shapes are the current algorithm version's multi-stroke
// serialization; rows that already hold any shape — including a stale one —
// are left for the operator-triggered recompute. Partial-success like the
// retired PNG step: per-activity failures are collected and joined so the job
// reports what did land, and the pipeline's ContinueOnFailure policy advances
// regardless.
func NewShapes(store ShapeStore) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		if err := parseShapeJob(j); err != nil {
			return "", err
		}
		var in struct {
			LabelIDs []string `json:"label_ids,omitempty"`
		}
		if j.InputJSON != "" {
			if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
				return "", job.NewPermanentError("bad_payload", fmt.Errorf("route shapes: parse input: %w", err))
			}
		}

		candidates, err := store.RouteThumbShapeCandidates(ctx, j.UserID)
		if err != nil {
			return "", err
		}
		out, err := fillShapes(ctx, store, j.UserID, candidates, hb)
		out.LabelIDs = in.LabelIDs
		result, _ := json.Marshal(out)
		return string(result), err
	}
}
