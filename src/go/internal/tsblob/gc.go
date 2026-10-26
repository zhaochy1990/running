// gc.go is the timeseries bucket's orphan collector (devops#785 AC4): a worker
// job that deletes blob objects whose activity row no longer exists, once they
// are older than the grace window. Orphans accrue from the dual-write ordering
// (a Put whose row transaction failed and was superseded), from account
// erasure (rows deleted, blobs intentionally left for this job), and from the
// migration's own aborted runs. The 7-day default swallows every in-flight
// race — an MQ retry cycle is minutes, not days.
//
// Rule: bucket key parses, activities row absent, ModTime strictly older than
// the cutoff → delete. Anything else survives: malformed keys, unknown
// ModTime, fresh objects. Deletion is batched; the Store's Delete is
// idempotent, so a re-run after a partial failure is a no-op for what already
// went.
package tsblob

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/tsstore"
)

// GCJobType is the registered job_type for the orphan collector.
const GCJobType = "ts_blob_gc"

// DefaultGCOlderThan is the grace window before an orphan may be deleted.
const DefaultGCOlderThan = 7 * 24 * time.Hour

// gcBatchSize caps keys per existence-check query and per Delete call.
const gcBatchSize = 100

// GCStore is the storage surface the GC needs; *storage.Store satisfies it.
type GCStore interface {
	ExistingLabels(ctx context.Context, userID string, labelIDs []string) (map[string]bool, error)
}

// GC collects orphaned timeseries blobs.
type GC struct {
	store     GCStore
	ts        tsstore.Store
	olderThan time.Duration
	Log       Logger
}

// NewGC returns a collector with the 7-day default grace window.
func NewGC(store GCStore, ts tsstore.Store) *GC {
	return &GC{store: store, ts: ts, olderThan: DefaultGCOlderThan}
}

// GCReport summarises one sweep.
type GCReport struct {
	Scanned    int64    `json:"scanned"`     // BlobKey-shaped objects seen
	KeptRows   int64    `json:"kept_rows"`   // activity row still exists
	KeptRecent int64    `json:"kept_recent"` // orphaned but inside the grace window
	UnknownAge int64    `json:"unknown_age"` // orphaned but backend reported no ModTime — never deleted
	Malformed  int64    `json:"malformed"`   // keys that did not parse; kept, reported
	Orphans    int64    `json:"orphans"`     // deletable: rowless and older than cutoff
	Deleted    int64    `json:"deleted"`     // actually deleted (0 under dry-run)
	DryRun     bool     `json:"dry_run"`
	FirstKeys  []string `json:"first_keys,omitempty"` // up to 20 deleted/dry-run keys
}

// Run sweeps the bucket once. dry-run reports without deleting.
func (g *GC) Run(ctx context.Context, dryRun bool) (GCReport, error) {
	if g.olderThan <= 0 {
		g.olderThan = DefaultGCOlderThan
	}
	cutoff := time.Now().UTC().Add(-g.olderThan)
	report := GCReport{DryRun: dryRun}

	var (
		user     string // "" = no segment open
		labels   []string
		keys     []string
		modTimes []time.Time
	)

	// flush checks one user's accumulated segment against the activities table
	// and schedules the deletions it earns.
	flush := func() error {
		if len(labels) == 0 {
			return nil
		}
		existing, err := g.store.ExistingLabels(ctx, user, labels)
		if err != nil {
			return fmt.Errorf("tsblob gc: existing labels for %s: %w", user, err)
		}
		var doomed []string
		for i, label := range labels {
			if existing[label] {
				report.KeptRows++
				continue
			}
			if modTimes[i].IsZero() {
				report.UnknownAge++
				continue
			}
			if modTimes[i].After(cutoff) {
				report.KeptRecent++
				continue
			}
			report.Orphans++
			doomed = append(doomed, keys[i])
		}
		if !dryRun && len(doomed) > 0 {
			for i := 0; i < len(doomed); i += gcBatchSize {
				end := i + gcBatchSize
				if end > len(doomed) {
					end = len(doomed)
				}
				if err := g.ts.Delete(ctx, doomed[i:end]...); err != nil {
					return fmt.Errorf("tsblob gc: delete batch: %w", err)
				}
				report.Deleted += int64(end - i)
			}
		}
		for _, k := range doomed {
			if len(report.FirstKeys) >= maxRecordedErrors {
				break
			}
			report.FirstKeys = append(report.FirstKeys, k)
		}
		labels, keys, modTimes = nil, nil, nil
		return nil
	}

	err := g.ts.List(ctx, tsstore.KeyPrefix, func(info tsstore.ObjectInfo) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		userID, labelID, ok := tsstore.ParseBlobKey(info.Key)
		if !ok {
			report.Malformed++
			return nil
		}
		report.Scanned++
		if userID != user {
			if err := flush(); err != nil {
				return err
			}
			user = userID
		}
		labels = append(labels, labelID)
		keys = append(keys, info.Key)
		modTimes = append(modTimes, info.ModTime)
		// Segments grow to the batch cap at most between flushes even for a
		// single user with a huge history.
		if len(labels) >= gcBatchSize {
			if err := flush(); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return report, err
	}
	if err := flush(); err != nil {
		return report, err
	}
	g.Log.printf("tsblob gc done: scanned=%d kept_rows=%d kept_recent=%d unknown_age=%d malformed=%d orphans=%d deleted=%d dry_run=%v",
		report.Scanned, report.KeptRows, report.KeptRecent, report.UnknownAge, report.Malformed, report.Orphans, report.Deleted, report.DryRun)
	return report, nil
}

// gcJobInput is the optional ts_blob_gc job payload.
type gcJobInput struct {
	// DryRun reports the sweep without deleting.
	DryRun bool `json:"dry_run"`
	// OlderThan overrides the grace window as a Go duration string (e.g.
	// "168h"). Empty keeps the 7-day default.
	OlderThan string `json:"older-than"`
}

// NewGCJobHandler returns the ts_blob_gc job handler for the worker registry.
// The job is enqueue-only (admin API); production runs are the operator's call.
func NewGCJobHandler(store GCStore, ts tsstore.Store) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		var in gcJobInput
		if j.InputJSON != "" {
			if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
				return "", job.NewPermanentError("bad_payload", fmt.Errorf("tsblob gc: parse input: %w", err))
			}
		}
		gc := NewGC(store, ts)
		if in.OlderThan != "" {
			d, err := time.ParseDuration(in.OlderThan)
			if err != nil || d <= 0 {
				return "", job.NewPermanentError("bad_payload",
					fmt.Errorf("tsblob gc: older-than %q is not a positive duration", in.OlderThan))
			}
			gc.olderThan = d
		}
		_ = hb("scan", 10)
		report, err := gc.Run(ctx, in.DryRun)
		if err != nil {
			return "", err
		}
		out, _ := json.Marshal(report)
		return string(out), nil
	}
}
