// tsblob.go is the storage side of the timeseries→COS Phase 1 dual-write
// (devops#785): the Store's injected tsstore backend, the row→blob point
// conversion, and the pointer-column stamping/query surface the backfill,
// audit, and orphan GC build on. The dependency direction is storage→tsstore
// only (tsstore never imports storage — see the tsstore package comment).
package storage

import (
	"context"
	"fmt"

	"github.com/zhaochy1990/stride/internal/tsstore"
)

// SetTSBlobStore injects the timeseries blob backend the dual-write uses. A
// Store without one (CLI reconcile paths, tests that predate Phase 1) keeps
// the pre-blob behaviour: upserts omit the pointer columns instead of writing
// blobs, so they can never clobber a stamped pointer. The worker injects it
// right after Open; it is not safe to call concurrently with upserts.
func (s *Store) SetTSBlobStore(ts tsstore.Store) { s.tsBlob = ts }

// TSBlobPoints mirrors a timeseries row set into the tsstore codec's Point
// shape. A nil slice maps to a non-nil zero-length slice so encoding an
// activity without samples produces the "[]" (empty-blob) checksum, matching
// EncodePoints' own normalisation. Exported because the audit recomputes
// checksums from rows through the exact same conversion.
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
	if err := s.tsBlob.Put(ctx, key, payload); err != nil {
		return "", 0, "", false, fmt.Errorf("storage: put ts blob %s: %w", key, err)
	}
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

// --- backfill / audit / GC query surface ----------------------------------
//
// These methods exist for the Phase 1 tooling (devops#785): the backfill CLI
// streams unmigrated activities, the audit reads the per-user counters, and
// the orphan GC checks bucket keys against live rows. They are deliberately
// on Store (rather than raw gorm handles handed to another package) so the
// SQL stays with the models it touches.

// UnmigratedActivityUsers lists the distinct user_ids that still have
// activities with a NULL ts_blob_key, sorted. The backfill fans users out to
// its worker pool from this list.
func (s *Store) UnmigratedActivityUsers(ctx context.Context) ([]string, error) {
	var ids []string
	err := s.db.WithContext(ctx).Model(&Activity{}).
		Distinct().
		Where("ts_blob_key IS NULL").
		Order("user_id").
		Pluck("user_id", &ids).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list unmigrated activity users: %w", err)
	}
	return ids, nil
}

// PageUserActivitiesWithoutTSBlob keyset-pages one user's unmigrated
// activities (label_id > afterLabel, ascending), returning at most limit
// (user_id, label_id) pairs. Keyset — not OFFSET — so the stream stays cheap
// at any depth and a re-run resumes naturally: stamped rows drop out of the
// filter.
func (s *Store) PageUserActivitiesWithoutTSBlob(ctx context.Context, userID, afterLabel string, limit int) ([]Activity, error) {
	var rows []Activity
	q := s.db.WithContext(ctx).Model(&Activity{}).
		Select("user_id", "label_id").
		Where("user_id = ? AND ts_blob_key IS NULL", userID)
	if afterLabel != "" {
		q = q.Where("label_id > ?", afterLabel)
	}
	err := q.Order("label_id").Limit(limit).Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: page unmigrated activities for %s: %w", userID, err)
	}
	return rows, nil
}

// StampTSBlobColumns writes the four pointer columns onto one activity row,
// guarded by "ts_blob_key IS NULL" so the backfill loses races against the
// live dual-write path (whoever stamps first wins; the loser sees stamped=false
// and moves on — both wrote the same deterministic content).
func (s *Store) StampTSBlobColumns(ctx context.Context, userID, labelID, key string, pointCount int, sha256 string, hasGPS bool) (bool, error) {
	res := s.db.WithContext(ctx).Model(&Activity{}).
		Where("user_id = ? AND label_id = ? AND ts_blob_key IS NULL", userID, labelID).
		Updates(map[string]any{
			"ts_blob_key":    key,
			"ts_point_count": pointCount,
			"ts_sha256":      sha256,
			"has_gps":        hasGPS,
		})
	if res.Error != nil {
		return false, fmt.Errorf("storage: stamp ts blob columns %s/%s: %w", userID, labelID, res.Error)
	}
	return res.RowsAffected > 0, nil
}

// TSBlobUserAudit is one user's row of the per-user reconciliation counters.
type TSBlobUserAudit struct {
	UserID string
	// RowPoints is COUNT(*) of the user's timeseries rows; BlobPoints is
	// SUM(ts_point_count) over the user's blob-stamped activities. The
	// reconciliation passes when they are equal for every user.
	RowPoints  int64
	BlobPoints int64
	Migrated   int64 // activities with a blob pointer
	Unmigrated int64 // activities still pending backfill
	PointSumOK bool  // RowPoints == BlobPoints
	CompleteOK bool  // Unmigrated == 0
}

// TSBlobUserAudits returns the per-user reconciliation counters for every user
// that has timeseries rows, blob pointers, or pending activities (union of the
// three), sorted by user_id. Three GROUP BY queries, merged in Go — the
// timeseries scan walks the (user_id, label_id) index, the other two touch
// only the small activities table.
func (s *Store) TSBlobUserAudits(ctx context.Context) ([]TSBlobUserAudit, error) {
	byUser := map[string]*TSBlobUserAudit{}
	var order []string
	merge := func(id string) *TSBlobUserAudit {
		if a, ok := byUser[id]; ok {
			return a
		}
		a := &TSBlobUserAudit{UserID: id}
		byUser[id] = a
		order = append(order, id)
		return a
	}

	var rowCounts []struct {
		UserID string `gorm:"column:user_id"`
		N      int64  `gorm:"column:n"`
	}
	if err := s.db.WithContext(ctx).Model(&TimeseriesPoint{}).
		Select("user_id, COUNT(*) AS n").
		Group("user_id").
		Scan(&rowCounts).Error; err != nil {
		return nil, fmt.Errorf("storage: count timeseries per user: %w", err)
	}
	for _, r := range rowCounts {
		merge(r.UserID).RowPoints = r.N
	}

	var blobAggs []struct {
		UserID string `gorm:"column:user_id"`
		Cnt    int64  `gorm:"column:cnt"`
		Pts    int64  `gorm:"column:pts"`
	}
	if err := s.db.WithContext(ctx).Model(&Activity{}).
		Select("user_id, COUNT(*) AS cnt, COALESCE(SUM(ts_point_count), 0) AS pts").
		Where("ts_blob_key IS NOT NULL").
		Group("user_id").
		Scan(&blobAggs).Error; err != nil {
		return nil, fmt.Errorf("storage: sum ts_point_count per user: %w", err)
	}
	for _, r := range blobAggs {
		a := merge(r.UserID)
		a.Migrated, a.BlobPoints = r.Cnt, r.Pts
	}

	var pending []struct {
		UserID string `gorm:"column:user_id"`
		N      int64  `gorm:"column:n"`
	}
	if err := s.db.WithContext(ctx).Model(&Activity{}).
		Select("user_id, COUNT(*) AS n").
		Where("ts_blob_key IS NULL").
		Group("user_id").
		Scan(&pending).Error; err != nil {
		return nil, fmt.Errorf("storage: count pending activities per user: %w", err)
	}
	for _, r := range pending {
		merge(r.UserID).Unmigrated = r.N
	}

	out := make([]TSBlobUserAudit, 0, len(order))
	for _, id := range order {
		a := byUser[id]
		a.PointSumOK = a.RowPoints == a.BlobPoints
		a.CompleteOK = a.Unmigrated == 0
		out = append(out, *a)
	}
	return out, nil
}

// TSBlobPointer is one stamped activity's identity + checksum, the audit's
// sampling frame.
type TSBlobPointer struct {
	UserID string `gorm:"column:user_id"`
	Label  string `gorm:"column:label_id"`
	SHA256 string `gorm:"column:ts_sha256"`
}

// ListTSBlobPointers returns every blob-stamped (user_id, label_id, ts_sha256)
// triple, ordered. The activities table is small (tens of thousands of rows);
// the audit samples its 5% from this list and diff-checks the bucket's key set
// against it.
func (s *Store) ListTSBlobPointers(ctx context.Context) ([]TSBlobPointer, error) {
	var rows []TSBlobPointer
	err := s.db.WithContext(ctx).Model(&Activity{}).
		Select("user_id, label_id, ts_sha256").
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
