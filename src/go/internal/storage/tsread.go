// tsread.go is the read half of the timeseries→blob migration, in its Phase 4
// final shape (devops#788): the blob is the only copy. Store.ActivityTimeseries
// serves from the blob when the activities row carries a ts_blob_key, verifies
// what it decoded against the row's ts_point_count/ts_sha256, and returns an
// error on any failure — with the row table dropped there is no fallback copy,
// so a failed verified read must fail loudly (the design's §5.1 answer to a
// dangling pointer is ResyncActivity repair, not stale data). Unstamped
// activities are the zero-point shape since Phase 3 and read as empty.
//
// Observability (devops#786 AC4) is structured log fields via log/slog: one
// line per blob GET with key/latency/bytes and one per failed read with a
// reason — stable `event` values so log aggregation (Grafana optional, later)
// can count and percentile them without parsing free text.
package storage

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"gorm.io/gorm"

	"github.com/zhaochy1990/stride/internal/tsstore"
)

// tsReadCacheEntries bounds the decoded-point-set LRU: ~64 activities
// (devops#786 AC2). A full compute reads the same activity through up to four
// sources (calibration/ability/load/PB), so the cache's job is "one GET per
// activity per pass", not long-term serving. 64 entries of ~1-2 MB (a long
// run's decoded points) keeps the worker's footprint in the low hundreds of MB
// worst case while covering the four-source overlap and the thumbnail job's
// back-to-back reads.
const tsReadCacheEntries = 64

// tsCacheEntry is one cached activity: the sha256 the points were decoded
// under, and the decoded rows. points is owned by the cache — callers get a
// copy (cloneTimeseriesPoints) so no consumer can mutate what the next reader
// receives.
type tsCacheEntry struct {
	key    string
	sha256 string
	points []TimeseriesPoint
}

// tsPointCache is a mutex-guarded LRU keyed by blob key. A get only hits when
// the row's current ts_sha256 matches the entry's — a resync overwrites the
// blob at the same deterministic key with new content and a new sha, so the
// checksum comparison is the invalidation: stale entries miss, get re-GETted,
// and are replaced. Zero-configuration and process-local by design.
type tsPointCache struct {
	mu    sync.Mutex
	max   int
	ll    *list.List // front = most recently used; element.Value is *tsCacheEntry
	items map[string]*list.Element
}

func newTSPointCache(max int) *tsPointCache {
	return &tsPointCache{
		max:   max,
		ll:    list.New(),
		items: make(map[string]*list.Element, max),
	}
}

// get returns the cached points when key is present AND was decoded under
// sha256. The returned slice is cache-owned: copy before handing it out.
func (c *tsPointCache) get(key, sha256 string) ([]TimeseriesPoint, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[key]
	if !ok {
		return nil, false
	}
	e := el.Value.(*tsCacheEntry)
	if e.sha256 != sha256 {
		// The blob was overwritten since this entry was decoded; drop it so the
		// refill starts clean instead of leaving an unreachable element.
		c.ll.Remove(el)
		delete(c.items, key)
		return nil, false
	}
	c.ll.MoveToFront(el)
	return e.points, true
}

// put stores points under (key, sha256) and takes ownership of the slice.
// It evicts the least recently used entry when full.
func (c *tsPointCache) put(key, sha256 string, points []TimeseriesPoint) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		e := el.Value.(*tsCacheEntry)
		e.sha256, e.points = sha256, points
		c.ll.MoveToFront(el)
		return
	}
	if c.max > 0 && c.ll.Len() >= c.max {
		if old := c.ll.Back(); old != nil {
			c.ll.Remove(old)
			delete(c.items, old.Value.(*tsCacheEntry).key)
		}
	}
	c.items[key] = c.ll.PushFront(&tsCacheEntry{key: key, sha256: sha256, points: points})
}

// tsBlobPointerRow is the pointer-column projection the read path needs.
type tsBlobPointerRow struct {
	TsBlobKey    *string `gorm:"column:ts_blob_key"`
	TsPointCount *int    `gorm:"column:ts_point_count"`
	TsSHA256     *string `gorm:"column:ts_sha256"`
}

// readActivityBlob returns the activity's points decoded from the blob store.
// An absent activity or an unstamped pointer is the empty answer (since Phase 3
// an unstamped activity is a zero-point one — there is no pre-backfill stock
// any more), and every blob-side failure is returned as an error with a
// structured `tsblob_read_failed` line naming the reason — with the row table
// gone there is no fallback copy, so serving anything but the verified blob
// would be serving wrong data.
func (s *Store) readActivityBlob(ctx context.Context, uid, labelID string) ([]TimeseriesPoint, error) {
	readFailed := func(reason, key string, fields ...any) error {
		args := append([]any{
			slog.String("event", "tsblob_read_failed"),
			slog.String("reason", reason),
			slog.String("user_id", uid), slog.String("label_id", labelID),
			slog.String("key", key),
		}, fields...)
		slog.Error("tsblob: verified blob read failed", args...)
		return fmt.Errorf("storage: read ts blob %s/%s: %s", uid, labelID, reason)
	}
	var p tsBlobPointerRow
	err := s.db.WithContext(ctx).Model(&Activity{}).
		Select("ts_blob_key", "ts_point_count", "ts_sha256").
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Take(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		// No activity row → no points; empty keeps the historical read
		// contract for absent activities.
		return nil, nil
	}
	if err != nil {
		return nil, readFailed("pointer_query_error", "", slog.String("error", err.Error()))
	}
	if p.TsBlobKey == nil || *p.TsBlobKey == "" {
		return nil, nil // zero-point activity (Phase 3 semantics): no blob, no data
	}
	key := *p.TsBlobKey
	if s.tsBlob == nil {
		return nil, readFailed("no_backend", key)
	}
	rowSHA := ""
	if p.TsSHA256 != nil {
		rowSHA = *p.TsSHA256
	}
	if cached, ok := s.tsCache.get(key, rowSHA); ok {
		return cloneTimeseriesPoints(cached), nil
	}

	start := time.Now()
	payload, err := s.tsBlob.Get(ctx, key)
	if err != nil {
		return nil, readFailed("get_error", key,
			slog.Duration("latency", time.Since(start)), slog.String("error", err.Error()))
	}
	blob, err := tsstore.DecodePoints(payload)
	if err != nil {
		return nil, readFailed("decode_error", key,
			slog.Duration("latency", time.Since(start)), slog.String("error", err.Error()))
	}
	// Verify the decoded blob against the pointer columns before serving it:
	// identity (the envelope must be the activity we asked for), the point
	// count, and the checksum. Any drift means the blob and the stamped
	// pointer disagree — with no row copy left, error out and let the
	// ResyncActivity repair path (design §5.1) heal the dangling pointer.
	if blob.UserID != uid || blob.LabelID != labelID {
		return nil, readFailed("identity_mismatch", key,
			slog.String("blob_user_id", blob.UserID), slog.String("blob_label_id", blob.LabelID))
	}
	if p.TsPointCount != nil && *p.TsPointCount != blob.PointCount {
		return nil, readFailed("point_count_mismatch", key,
			slog.Int("row_ts_point_count", *p.TsPointCount),
			slog.Int("blob_point_count", blob.PointCount))
	}
	if p.TsSHA256 != nil && *p.TsSHA256 != blob.SHA256 {
		return nil, readFailed("sha_mismatch", key,
			slog.String("row_ts_sha256", *p.TsSHA256),
			slog.String("blob_sha256", blob.SHA256))
	}

	pts := blobRowsFromPoints(uid, labelID, blob.Points)
	s.tsCache.put(key, blob.SHA256, pts)
	slog.Info("tsblob: blob get ok",
		slog.String("event", "tsblob_get_ok"),
		slog.String("key", key),
		slog.Duration("latency", time.Since(start)),
		slog.Int("bytes", len(payload)),
		slog.Int("points", len(pts)))
	return cloneTimeseriesPoints(pts), nil
}

// blobRowsFromPoints is the reverse of TSBlobPoints: the codec's Point shape
// back into row form, tenant-stamped. Order is preserved — encode wrote the
// rows in insertion order and decode returns the same array order, so the
// blob path matches the row query's "ORDER BY id".
func blobRowsFromPoints(uid, labelID string, pts []tsstore.Point) []TimeseriesPoint {
	rows := make([]TimeseriesPoint, len(pts))
	for i, p := range pts {
		rows[i] = TimeseriesPoint{
			UserID: uid, LabelID: labelID,
			Timestamp: p.Ts, Distance: p.Dist, HeartRate: p.Hr, Speed: p.Spd,
			AdjustedPace: p.Pace, Cadence: p.Cad, Altitude: p.Alt, Power: p.Pwr,
			GroundContactTimeMs:   p.Gct,
			VerticalOscillationMm: p.Vosc,
			VerticalRatioPct:      p.Vratio,
			CadenceLengthCm:       p.Cdl,
			Slope:                 p.Slope,
			HeartLevel:            p.Hlvl,
			GPSLat:                p.Lat,
			GPSLon:                p.Lon,
		}
	}
	return rows
}

// cloneTimeseriesPoints copies the slice (not the pointed-to values — readers
// never write through them) so a cached entry can be handed to any consumer
// without aliasing the cache.
func cloneTimeseriesPoints(pts []TimeseriesPoint) []TimeseriesPoint {
	if pts == nil {
		return nil
	}
	out := make([]TimeseriesPoint, len(pts))
	copy(out, pts)
	return out
}
