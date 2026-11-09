// tsblob.go is the storage side of the timeseries→COS migration (devops#785):
// the Store's injected tsstore backend, the row→blob point conversion, and
// the pointer query surface the audit and orphan GC build on. The dependency
// direction is storage→tsstore only (tsstore never imports storage — see the
// tsstore package comment).
package storage

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/zhaochy1990/stride/internal/tsstore"
)

// SetTSBlobStore injects the timeseries blob backend the dual-write uses. A
// Store without one (CLI reconcile paths, tests that predate Phase 1) keeps
// the pre-blob behaviour: upserts omit the pointer columns instead of writing
// blobs, so they can never clobber a stamped pointer. The worker injects it
// right after Open; it is not safe to call concurrently with upserts.
func (s *Store) SetTSBlobStore(ts tsstore.Store) { s.tsBlob = ts }

// TSBlobPoints mirrors a timeseries point set into the tsstore codec's Point
// shape. A nil slice maps to a non-nil zero-length slice so encoding an
// activity without samples produces the "[]" (empty-blob) checksum, matching
// EncodePoints' own normalisation. Exported because tests round-trip
// payloads through the exact same conversion.
func TSBlobPoints(rows []TimeseriesPoint) []tsstore.Point {
	pts := make([]tsstore.Point, len(rows))
	for i, r := range rows {
		pts[i] = tsstore.Point{
			Ts: r.Timestamp, Dist: r.Distance, Hr: r.HeartRate, Spd: r.Speed,
			Pace: r.AdjustedPace, Cad: r.Cadence, Alt: r.Altitude, Pwr: r.Power,
			Gct: r.GroundContactTimeMs, Vosc: r.VerticalOscillationMm,
			Vratio: r.VerticalRatioPct, Cdl: r.CadenceLengthCm,
			Slope: r.Slope, Hlvl: r.HeartLevel, Lat: r.GPSLat, Lon: r.GPSLon,
		}
	}
	return pts
}

// WriteActivityBlob encodes rows and Put-s the blob at the deterministic key,
// returning (key, pointCount, sha256, hasGPS). It is the encode+upload half
// of the dual-write — used by the upsert path and, with the same content, by
// the backfill; the caller stamps the activity row with the results. A Put
// failure is returned as-is — the sync upsert turns it into a whole-upsert
// failure (MQ retry), the backfill records it and moves on; the key's
// idempotent-overwrite semantics make both safe to re-run. Panics if no blob
// backend is injected — callers gate on it (upsertActivity checks; the
// backfill is only constructed with one).
func (s *Store) WriteActivityBlob(ctx context.Context, userID, labelID string, rows []TimeseriesPoint) (string, int, string, bool, error) {
	payload, sum, err := tsstore.EncodePoints(userID, labelID, TSBlobPoints(rows))
	if err != nil {
		return "", 0, "", false, fmt.Errorf("storage: encode ts blob %s/%s: %w", userID, labelID, err)
	}
	key := tsstore.BlobKey(userID, labelID)
	start := time.Now()
	if err := s.tsBlob.Put(ctx, key, payload); err != nil {
		slog.Error("tsblob: blob put failed",
			slog.String("event", "tsblob_put_error"),
			slog.String("key", key),
			slog.Duration("latency", time.Since(start)),
			slog.Int("bytes", len(payload)),
			slog.Int("points", len(rows)),
			slog.String("error", err.Error()))
		return "", 0, "", false, fmt.Errorf("storage: put ts blob %s: %w", key, err)
	}
	slog.Info("tsblob: blob put ok",
		slog.String("event", "tsblob_put_ok"),
		slog.String("key", key),
		slog.Duration("latency", time.Since(start)),
		slog.Int("bytes", len(payload)),
		slog.Int("points", len(rows)))
	return key, len(rows), sum, anyValidGPS(rows), nil
}

// anyValidGPS reports whether any sampled point carries a complete, valid GPS
// fix (see validGPSFix) — the activities.has_gps flag.
func anyValidGPS(rows []TimeseriesPoint) bool {
	for _, r := range rows {
		if r.GPSLat == nil || r.GPSLon == nil {
			continue
		}
		if validGPSFix(*r.GPSLat, *r.GPSLon) {
			return true
		}
	}
	return false
}

// --- audit / GC query surface ----------------------------------------------
//
// These methods exist for the migration's residual tooling (devops#785/#788):
// the audit samples stamped pointers and diffs them against the bucket, and
// the orphan GC checks bucket keys against live activity rows. The backfill
// surface (unmigrated paging, guarded stamping, the per-user row counters)
// retired with the dropped timeseries table — there are no rows left to
// migrate or reconcile. They are deliberately on Store (rather than raw gorm
// handles handed to another package) so the SQL stays with the models it
// touches.

// TSBlobPointer is one stamped activity's identity + checksum + declared
// point count, the audit's sampling frame.
type TSBlobPointer struct {
	UserID     string `gorm:"column:user_id"`
	Label      string `gorm:"column:label_id"`
	SHA256     string `gorm:"column:ts_sha256"`
	PointCount int64  `gorm:"column:ts_point_count"`
}

// ListTSBlobPointers returns every blob-stamped (user_id, label_id,
// ts_sha256, ts_point_count) tuple, ordered. The activities table is small
// (tens of thousands of rows); the audit samples its 5% from this list and
// diff-checks the bucket's key set against it.
func (s *Store) ListTSBlobPointers(ctx context.Context) ([]TSBlobPointer, error) {
	var rows []TSBlobPointer
	err := s.db.WithContext(ctx).Model(&Activity{}).
		Select("user_id, label_id, ts_sha256, ts_point_count").
		Where("ts_blob_key IS NOT NULL").
		Order("user_id, label_id").
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list ts blob pointers: %w", err)
	}
	return rows, nil
}

// ExistingLabels reports which of labelIDs exist as activities rows for
// userID. The orphan GC batch-checks listed bucket keys against it.
func (s *Store) ExistingLabels(ctx context.Context, userID string, labelIDs []string) (map[string]bool, error) {
	out := map[string]bool{}
	for len(labelIDs) > 0 {
		chunk := labelIDs
		if len(chunk) > 500 {
			chunk = labelIDs[:500]
		}
		labelIDs = labelIDs[len(chunk):]
		var found []string
		if err := s.db.WithContext(ctx).Model(&Activity{}).
			Where("user_id = ? AND label_id IN ?", userID, chunk).
			Pluck("label_id", &found).Error; err != nil {
			return nil, fmt.Errorf("storage: existing labels for %s: %w", userID, err)
		}
		for _, l := range found {
			out[l] = true
		}
	}
	return out, nil
}
