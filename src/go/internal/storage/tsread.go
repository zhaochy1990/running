// tsread.go is the read half of the timeseries→blob migration, Phase 2
// (devops#786): pointer-first reads with row fallback. Store.ActivityTimeseries
// serves from the blob when the activities row carries a ts_blob_key, verifies
// what it decoded against the row's ts_point_count/ts_sha256, and falls back to
// the row query on any failure — during the dual-write window rows are still
// written, so a blob problem degrades latency, never correctness.
//
// Observability (devops#786 AC4) is structured log fields via log/slog: one
// line per blob GET/PUT with key/latency/bytes and one per row-fallback with a
// reason — stable `event` values so log aggregation (Grafana optional, later)
// can count and percentile them without parsing free text.
package storage

import (
	"container/list"
	"context"
	"errors"
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

// readActivityBlob returns the activity's points decoded from the blob store
// when the row carries a usable pointer. ok=false means "serve this read from
// rows" — either a mundane state (no backend injected, activity absent, or the
// pointer not stamped yet — pre-backfill stock) or a verified failure, each
// logged with a reason so the soak window sees every fallback. It never
// returns an error: falling back IS the error handling (dual-write keeps rows
// authoritative-equivalent until Phase 3).
func (s *Store) readActivityBlob(ctx context.Context, uid, labelID string) ([]TimeseriesPoint, bool) {
	if s.tsBlob == nil {
		return nil, false
	}
	var p tsBlobPointerRow
	err := s.db.WithContext(ctx).Model(&Activity{}).
		Select("ts_blob_key", "ts_point_count", "ts_sha256").
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Take(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		// No activity row → no timeseries rows either (children are keyed the
		// same way); the row query returns the same empty answer.
		return nil, false
	}
	if err != nil {
		slog.Error("tsblob: pointer query failed, falling back to rows",
			slog.String("event", "tsblob_row_fallback"),
			slog.String("reason", "pointer_query_error"),
			slog.String("user_id", uid), slog.String("label_id", labelID),
			slog.String("error", err.Error()))
		return nil, false
	}
	if p.TsBlobKey == nil || *p.TsBlobKey == "" {
		return nil, false // not migrated yet; row storage is the only copy
	}
	key := *p.TsBlobKey
	rowSHA := ""
	if p.TsSHA256 != nil {
		rowSHA = *p.TsSHA256
	}
	if cached, ok := s.tsCache.get(key, rowSHA); ok {
		return cloneTimeseriesPoints(cached), true
	}

	start := time.Now()
	payload, err := s.tsBlob.Get(ctx, key)
	if err != nil {
		slog.Error("tsblob: blob get failed, falling back to rows",
			slog.String("event", "tsblob_row_fallback"),
			slog.String("reason", "get_error"),
			slog.String("key", key),
			slog.Duration("latency", time.Since(start)),
			slog.String("error", err.Error()))
		return nil, false
	}
	blob, err := tsstore.DecodePoints(payload)
	if err != nil {
		slog.Error("tsblob: blob decode failed, falling back to rows",
			slog.String("event", "tsblob_row_fallback"),
			slog.String("reason", "decode_error"),
			slog.String("key", key),
			slog.Duration("latency", time.Since(start)),
			slog.String("error", err.Error()))
		return nil, false
	}
	// Verify the decoded blob against the pointer columns before serving it:
	// identity (the envelope must be the activity we asked for), the point
	// count, and the checksum. Any drift means the row and blob disagree —
	// during dual-write the row half is intact, so serve it and let the
	// mismatch surface here rather than as wrong data.
	if blob.UserID != uid || blob.LabelID != labelID {
		slog.Error("tsblob: blob identity mismatch, falling back to rows",
			slog.String("event", "tsblob_row_fallback"),
			slog.String("reason", "identity_mismatch"),
			slog.String("key", key),
			slog.String("blob_user_id", blob.UserID), slog.String("blob_label_id", blob.LabelID),
			slog.String("want_user_id", uid), slog.String("want_label_id", labelID))
		return nil, false
	}
	if p.TsPointCount != nil && *p.TsPointCount != blob.PointCount {
		slog.Error("tsblob: point count mismatch, falling back to rows",
			slog.String("event", "tsblob_row_fallback"),
			slog.String("reason", "point_count_mismatch"),
			slog.String("key", key),
			slog.Int("row_ts_point_count", *p.TsPointCount),
			slog.Int("blob_point_count", blob.PointCount))
		return nil, false
	}
	if p.TsSHA256 != nil && *p.TsSHA256 != blob.SHA256 {
		slog.Error("tsblob: checksum mismatch, falling back to rows",
			slog.String("event", "tsblob_row_fallback"),
			slog.String("reason", "sha_mismatch"),
			slog.String("key", key),
			slog.String("row_ts_sha256", *p.TsSHA256),
			slog.String("blob_sha256", blob.SHA256))
		return nil, false
	}

	pts := blobRowsFromPoints(uid, labelID, blob.Points)
	s.tsCache.put(key, blob.SHA256, pts)
	slog.Info("tsblob: blob get ok",
		slog.String("event", "tsblob_get_ok"),
		slog.String("key", key),
		slog.Duration("latency", time.Since(start)),
		slog.Int("bytes", len(payload)),
		slog.Int("points", len(pts)))
	return cloneTimeseriesPoints(pts), true
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
