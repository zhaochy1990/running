// Package routethumbnails renders each outdoor activity's GPS trace into a small
// route PNG, uploads it to COS, and records both the polyline and the PNG's
// public URL on the activity row.
//
// It runs as an optional step of the sync pipelines (after compute) and as an
// internal all-history backfill. Both entry points do the same work — the
// candidate query already selects only activities that still need a thumbnail,
// so no input narrows it. Thumbnails are cosmetic, so every failure mode here
// degrades to "no thumbnail" rather than to "sync failed".
package routethumbnails

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/color"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/cos"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/thumbnail"
)

const (
	// JobType is the sync-pipeline step, run after compute.
	JobType = "route_thumbnails"
	// BackfillJobType is the internal one-time all-history scan. It exists as a
	// separate catalog entry so an operator can trigger it deliberately for one
	// athlete, not because it behaves differently.
	BackfillJobType = "route_thumbnails_backfill"

	// canvasSize is the PNG edge length in pixels. The list page draws it in a
	// 72rpx slot, so 96 leaves headroom on a 3x-density phone without bloating
	// the stored object.
	canvasSize = 96

	// progressEvery bounds heartbeat writes on a long backfill: one UPDATE per
	// activity would cost more than the work being reported.
	progressEvery = 25
)

// strokeColor is the single colour a route is stroked in. The activity list is
// a dark surface (#101111 card, 5%-white icon slot), so the route is drawn in
// the same near-white as the row's own text rather than a dark ink that would
// vanish into the card.
var strokeColor = color.RGBA{R: 0xe3, G: 0xe2, B: 0xe5, A: 0xff}

// Store is the slice of storage the handler needs.
type Store interface {
	RouteThumbCandidates(ctx context.Context, userID string) ([]string, error)
	ActivityTimeseries(ctx context.Context, userID, labelID string) ([]storage.TimeseriesPoint, error)
	SetActivityRouteThumb(ctx context.Context, userID, labelID, thumbJSON, thumbURL string) error
}

type thumbResult struct {
	Candidates int `json:"candidates"`
	Generated  int `json:"generated"`
	NoGPS      int `json:"no_gps"`
	Failed     int `json:"failed"`
	// Skipped names why the job did nothing, when it did nothing on purpose.
	Skipped string `json:"skipped,omitempty"`
}

// New builds the handler for both job types. Candidate failures are collected
// and joined so the job still reports a partial result; the pipeline's
// ContinueOnFailure policy then advances to the next step regardless.
func New(store Store, uploader *cos.Client) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		if _, err := uuid.Parse(j.UserID); err != nil {
			return "", job.NewPermanentError("bad_partition", fmt.Errorf("route thumbnails: user must be UUID: %w", err))
		}

		// A bucket without credentials is a normal deployment state, not a
		// failure: thumbnails are cosmetic, so skip cleanly and report why.
		if !uploader.Configured() {
			result, _ := json.Marshal(thumbResult{Skipped: "cos_not_configured"})
			return string(result), nil
		}

		candidates, err := store.RouteThumbCandidates(ctx, j.UserID)
		if err != nil {
			return "", err
		}
		_ = hb("route_thumbnails", 5)

		var out thumbResult
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
				// Fewer valid fixes than the cutoff: the client falls back to the
				// sport icon for this activity.
				out.NoGPS++
				continue
			}
			png, err := thumbnail.RenderPNG(polyline, canvasSize, strokeColor)
			if err != nil {
				failures = append(failures, fmt.Errorf("activity %s: render: %w", labelID, err))
				continue
			}
			key := objectKey(j.UserID, labelID)
			if err := uploader.Upload(ctx, key, bytes.NewReader(png), "image/png"); err != nil {
				failures = append(failures, fmt.Errorf("activity %s: upload: %w", labelID, err))
				continue
			}
			// The polyline is stored alongside the URL: the web client draws it
			// directly, and Go sync previously never populated it at all.
			if err := store.SetActivityRouteThumb(ctx, j.UserID, labelID, thumbnail.JSON(polyline), uploader.PublicURL(key)); err != nil {
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

// objectKey is the bucket key for one activity's thumbnail. Per-activity keys
// keep regeneration idempotent: a re-render overwrites rather than accumulates.
func objectKey(userID, labelID string) string {
	return "thumbnails/" + userID + "/" + labelID + ".png"
}

// toSamples narrows a time series to what the thumbnail algorithm needs. A row
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
