// gc.go is the timeseries bucket's orphan collector (devops#785 AC4, reshaped
// by devops#1005 for the immutable v2 layout). Orphans accrue from a Put whose
// row transaction was refused (a fenced-out stale worker's parting gift), from
// re-publishes that moved a pointer to a new immutable key, from account
// erasures whose inline prefix sweep missed, and from aborted sync runs.
//
// Liveness is judged by ACTUAL POINTERS (devops#1005): an object is live iff
// some activities row's ts_blob_key names it — label existence alone stopped
// being the rule when one label could have several objects across revisions.
// An unreferenced object is deletable only when it is older than the grace
// window AND not covered by a fresh upload intent (an in-flight Put whose row
// transaction has not resolved). Anything else survives: malformed keys,
// unknown ModTime, fresh objects. Deletion is batched; the Store's Delete is
// idempotent, so a re-run after a partial failure is a no-op for what already
// went.
//
// The job payload defaults to DRY-RUN: an absent/null dry_run flag reports
// without deleting (devops#1005 AC4); production deletes must say so
// explicitly ("dry_run": false).
package tsblob

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/tsstore"
)

// Logger is the progress-reporting sink: fmt.Printf in the CLI, anything else
// in tests. Nil falls back to the standard log package.
type Logger func(format string, args ...any)

func (l Logger) printf(format string, args ...any) {
	if l == nil {
		log.Printf(format, args...)
		return
	}
	l(format, args...)
}

// maxRecordedErrors caps the retained error samples in the report; the counts
// stay exact even when the samples are truncated.
const maxRecordedErrors = 20

// GCJobType is the registered job_type for the orphan collector.
const GCJobType = "ts_blob_gc"

// DefaultGCOlderThan is the grace window before an orphan may be deleted.
const DefaultGCOlderThan = 7 * 24 * time.Hour

// gcBatchSize caps keys per Delete call.
const gcBatchSize = 100

// GCStore is the storage surface the GC needs; *storage.Store satisfies it.
type GCStore interface {
	// ListReferencedTSBlobKeys is the ACTUAL-pointer liveness set (both key
	// layouts) — the GC's only notion of "still needed".
	ListReferencedTSBlobKeys(ctx context.Context) (map[string]bool, error)
	// ListActiveUploadIntents returns blob keys with an intent row newer than
	// the given instant (in-flight Put → row-transaction windows).
	ListActiveUploadIntents(ctx context.Context, since time.Time) (map[string]bool, error)
	// SweepStaleUploadIntents removes intent rows older than the instant —
	// janitorial, so crashed uploads do not accumulate rows.
	SweepStaleUploadIntents(ctx context.Context, before time.Time) (int64, error)
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
	Scanned        int64    `json:"scanned"`         // v1/v2-shaped objects seen
	KeptReferenced int64    `json:"kept_referenced"` // named by an activities pointer
	KeptIntent     int64    `json:"kept_intent"`     // unreferenced but an active upload covers it
	KeptRecent     int64    `json:"kept_recent"`     // unreferenced but inside the grace window
	UnknownAge     int64    `json:"unknown_age"`     // unreferenced, no intent, backend reported no ModTime — never deleted
	Malformed      int64    `json:"malformed"`       // keys that did not parse; kept, reported
	Orphans        int64    `json:"orphans"`         // deletable: unreferenced, intent-free, older than cutoff
	Deleted        int64    `json:"deleted"`         // actually deleted (0 under dry-run)
	IntentsSwept   int64    `json:"intents_swept"`   // stale intent rows removed
	DryRun         bool     `json:"dry_run"`
	FirstKeys      []string `json:"first_keys,omitempty"` // up to 20 deleted/dry-run keys
}

// Run sweeps the bucket once. dry-run reports without deleting.
func (g *GC) Run(ctx context.Context, dryRun bool) (GCReport, error) {
	if g.olderThan <= 0 {
		g.olderThan = DefaultGCOlderThan
	}
	cutoff := time.Now().UTC().Add(-g.olderThan)
	report := GCReport{DryRun: dryRun}

	referenced, err := g.store.ListReferencedTSBlobKeys(ctx)
	if err != nil {
		return report, err
	}
	// The intent protection uses the same cutoff as deletion age: an intent
	// older than the grace window belongs to a crashed upload, not an active
	// one, and must not keep its object alive forever.
	intents, err := g.store.ListActiveUploadIntents(ctx, cutoff)
	if err != nil {
		return report, err
	}

	var doomed []string
	for _, prefix := range tsstore.AllKeyPrefixes() {
		err = g.ts.List(ctx, prefix, func(info tsstore.ObjectInfo) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if _, _, ok := tsstore.ParseAnyBlobKey(info.Key); !ok {
				report.Malformed++
				return nil
			}
			report.Scanned++
			switch {
			case referenced[info.Key]:
				report.KeptReferenced++
			case intents[info.Key]:
				report.KeptIntent++
			case info.ModTime.IsZero():
				report.UnknownAge++
			case info.ModTime.After(cutoff):
				report.KeptRecent++
			default:
				report.Orphans++
				doomed = append(doomed, info.Key)
			}
			return nil
		})
		if err != nil {
			return report, err
		}
	}

	if !dryRun && len(doomed) > 0 {
		for i := 0; i < len(doomed); i += gcBatchSize {
			end := i + gcBatchSize
			if end > len(doomed) {
				end = len(doomed)
			}
			if err := g.ts.Delete(ctx, doomed[i:end]...); err != nil {
				return report, fmt.Errorf("tsblob gc: delete batch: %w", err)
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
	// Sweep stranded intent rows on every run (they protect nothing once
	// older than the grace window). Best-effort even under dry-run: these are
	// bookkeeping rows, not user data.
	swept, err := g.store.SweepStaleUploadIntents(ctx, cutoff)
	if err != nil {
		return report, fmt.Errorf("tsblob gc: sweep stale intents: %w", err)
	}
	report.IntentsSwept = swept
	g.Log.printf("tsblob gc done: scanned=%d kept_referenced=%d kept_intent=%d kept_recent=%d unknown_age=%d malformed=%d orphans=%d deleted=%d intents_swept=%d dry_run=%v",
		report.Scanned, report.KeptReferenced, report.KeptIntent, report.KeptRecent, report.UnknownAge, report.Malformed, report.Orphans, report.Deleted, report.IntentsSwept, report.DryRun)
	return report, nil
}

// gcJobInput is the optional ts_blob_gc job payload.
type gcJobInput struct {
	// DryRun reports the sweep without deleting. DEFAULTS TO TRUE (devops#1005
	// AC4): a nil value never deletes; a production run must set false.
	DryRun *bool `json:"dry_run"`
	// OlderThan overrides the grace window as a Go duration string (e.g.
	// "168h"). Empty keeps the 7-day default.
	OlderThan string `json:"older-than"`
}

// NewGCJobHandler returns the ts_blob_gc job handler for the worker registry.
// The job is enqueue-only (admin API); production runs are the operator's call
// and must opt into deletion with "dry_run": false.
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
		dryRun := true
		if in.DryRun != nil {
			dryRun = *in.DryRun
		}
		_ = hb("scan", 10)
		report, err := gc.Run(ctx, dryRun)
		if err != nil {
			return "", err
		}
		out, _ := json.Marshal(report)
		return string(out), nil
	}
}
