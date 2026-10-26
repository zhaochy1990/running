// Package tsblob implements the timeseries→COS Phase 1 tooling (devops#785):
// the stock backfill (stream unmigrated activities → encode+upload → stamp the
// pointer columns), the three-part reconciliation (per-user point sums, sha256
// sampling, bucket-vs-pointer object counts), and the orphan GC job. The
// operational pieces are deliberately entry-point-agnostic — the CLI wires
// backfill/audit, the worker registers the GC job handler — and they never
// run from tests against anything but a MemStore/FileStore backend.
package tsblob

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
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

// BackfillStore is the storage surface the backfill needs. *storage.Store
// satisfies it; the interface exists so tests can drive the real Store. The
// row read is the explicit Rows variant (devops#786): the backfill must source
// blobs from the rows themselves, never from the pointer-first read.
type BackfillStore interface {
	UnmigratedActivityUsers(ctx context.Context) ([]string, error)
	PageUserActivitiesWithoutTSBlob(ctx context.Context, userID, afterLabel string, limit int) ([]storage.Activity, error)
	ActivityTimeseriesRows(ctx context.Context, userID, labelID string) ([]storage.TimeseriesPoint, error)
	WriteActivityBlob(ctx context.Context, userID, labelID string, rows []storage.TimeseriesPoint) (key string, pointCount int, sha256 string, hasGPS bool, err error)
	StampTSBlobColumns(ctx context.Context, userID, labelID, key string, pointCount int, sha256 string, hasGPS bool) (bool, error)
}

// Backfill migrates stock activities to blobs. Resumability is structural, not
// checkpointed: the scan is WHERE ts_blob_key IS NULL, so an interrupted run
// re-executed simply continues where the stamped rows left off, and the stamp
// guard makes a concurrent live dual-write and the backfill agree on the same
// deterministic content whichever writes first.
type Backfill struct {
	store BackfillStore
	// Concurrency is the worker-pool width across users (devops#785 sizes the
	// 21-user stock at 4-8).
	Concurrency int
	// PageSize is the keyset page of activities fetched per round trip.
	PageSize int
	Log      Logger
}

// NewBackfill returns a backfill with the documented defaults (4 workers,
// pages of 200).
func NewBackfill(store BackfillStore) *Backfill {
	return &Backfill{store: store, Concurrency: 4, PageSize: 200}
}

// BackfillReport summarises one run.
type BackfillReport struct {
	Users       int      `json:"users"`
	Migrated    int64    `json:"migrated"`               // activities this run stamped
	Raced       int64    `json:"raced"`                  // already stamped between page and stamp (skipped)
	Failed      int64    `json:"failed"`                 // activities whose encode/upload/stamp errored
	Points      int64    `json:"points"`                 // total timeseries rows migrated
	Elapsed     string   `json:"elapsed"`                // wall time, rounded
	FirstErrors []string `json:"first_errors,omitempty"` // up to 20, for the operator
	OK          bool     `json:"ok"`                     // no failures
}

// maxRecordedErrors caps the retained error samples in the report; the counts
// stay exact even when the samples are truncated.
const maxRecordedErrors = 20

// Run walks every unmigrated user's unmigrated activities, uploads a blob per
// activity, and stamps the pointer columns. It returns when every user is
// drained (or ctx is cancelled); per-activity errors are recorded and skipped
// so one poisoned activity cannot strand the stock — a later run retries
// exactly the failed ones.
func (b *Backfill) Run(ctx context.Context) (BackfillReport, error) {
	started := time.Now()
	report := BackfillReport{OK: true}

	if b.Concurrency < 1 {
		b.Concurrency = 1
	}
	if b.PageSize < 1 {
		b.PageSize = 200
	}

	users, err := b.store.UnmigratedActivityUsers(ctx)
	if err != nil {
		return report, err
	}
	report.Users = len(users)

	var (
		mu      sync.Mutex
		wg      sync.WaitGroup
		next    int
		reports = make([]BackfillReport, b.Concurrency)
	)
	for w := 0; w < b.Concurrency && w < len(users); w++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			reports[slot] = b.runWorker(ctx, users, &next, &mu)
		}(w)
	}
	wg.Wait()
	if ctx.Err() != nil {
		report.Elapsed = time.Since(started).Round(time.Second).String()
		return report, ctx.Err()
	}
	for _, r := range reports {
		report.Migrated += r.Migrated
		report.Raced += r.Raced
		report.Failed += r.Failed
		report.Points += r.Points
		report.FirstErrors = append(report.FirstErrors, r.FirstErrors...)
	}
	if len(report.FirstErrors) > maxRecordedErrors {
		report.FirstErrors = report.FirstErrors[:maxRecordedErrors]
	}
	report.OK = report.Failed == 0
	report.Elapsed = time.Since(started).Round(time.Second).String()
	b.Log.printf("tsblob backfill done: users=%d migrated=%d raced=%d failed=%d points=%d elapsed=%s",
		report.Users, report.Migrated, report.Raced, report.Failed, report.Points, report.Elapsed)
	return report, nil
}

// runWorker claims users by index (cheaper than a channel for a 21-element
// list) and drains each with the keyset loop.
func (b *Backfill) runWorker(ctx context.Context, users []string, next *int, mu *sync.Mutex) BackfillReport {
	var report BackfillReport
	recordErr := func(format string, args ...any) {
		report.Failed++
		if len(report.FirstErrors) < maxRecordedErrors {
			report.FirstErrors = append(report.FirstErrors, fmt.Sprintf(format, args...))
		}
	}
	for {
		mu.Lock()
		i := *next
		*next++
		mu.Unlock()
		if i >= len(users) {
			return report
		}
		user := users[i]
		if err := b.backfillUser(ctx, user, &report, recordErr); err != nil {
			// A page-level fault (DB down) aborts this user; other workers keep
			// going and the error is reported per-activity style.
			recordErr("user %s aborted: %v", user, err)
			continue
		}
	}
}

// backfillUser keyset-pages one user's unmigrated activities.
func (b *Backfill) backfillUser(ctx context.Context, user string, report *BackfillReport, recordErr func(string, ...any)) error {
	after := ""
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		page, err := b.store.PageUserActivitiesWithoutTSBlob(ctx, user, after, b.PageSize)
		if err != nil {
			return err
		}
		if len(page) == 0 {
			return nil
		}
		for _, a := range page {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			rows, err := b.store.ActivityTimeseriesRows(ctx, user, a.LabelID)
			if err != nil {
				recordErr("user %s activity %s: read rows: %v", user, a.LabelID, err)
				continue
			}
			key, count, sum, hasGPS, err := b.store.WriteActivityBlob(ctx, user, a.LabelID, rows)
			if err != nil {
				recordErr("user %s activity %s: write blob: %v", user, a.LabelID, err)
				continue
			}
			stamped, err := b.store.StampTSBlobColumns(ctx, user, a.LabelID, key, count, sum, hasGPS)
			if err != nil {
				recordErr("user %s activity %s: stamp: %v", user, a.LabelID, err)
				continue
			}
			if stamped {
				report.Migrated++
				report.Points += int64(count)
			} else {
				// The live dual-write stamped it between page and stamp — same
				// deterministic content, nothing to do.
				report.Raced++
			}
		}
		after = page[len(page)-1].LabelID
		if len(page) < b.PageSize {
			return nil
		}
	}
}
