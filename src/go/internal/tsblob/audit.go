// audit.go is the timeseries migration's reconciliation (devops#785 AC3), the
// check the ~2-day soak window re-runs daily (#778 decision 3). Three parts:
//
//  1. per user, COUNT(*) of timeseries rows vs SUM(ts_point_count) of stamped
//     activities — equal means migrated blobs account for every stored row;
//  2. a deterministic sample of stamped activities whose sha256 is recomputed
//     from the rows AND cross-checked against the bucket blob's envelope;
//  3. bucket object count vs pointer count — plus the exact set diff, so a
//     missing blob or an orphan is named, not just counted.
//
// Read-only: it never writes a blob or a row, so running it cannot disturb
// what it measures.
package tsblob

import (
	"context"
	"fmt"
	"sort"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsstore"
)

// AuditStore is the storage surface the audit needs; *storage.Store satisfies
// it.
type AuditStore interface {
	TSBlobUserAudits(ctx context.Context) ([]storage.TSBlobUserAudit, error)
	ListTSBlobPointers(ctx context.Context) ([]storage.TSBlobPointer, error)
	ActivityTimeseries(ctx context.Context, userID, labelID string) ([]storage.TimeseriesPoint, error)
}

// Auditor reconciles rows, pointer columns, and bucket objects.
type Auditor struct {
	store AuditStore
	ts    tsstore.Store
	// SampleRate is the fraction of stamped activities whose checksums are
	// recomputed (devops#785: 5%). Samples are deterministic — every k-th
	// pointer in (user, label) order — so a re-run re-checks the same set.
	SampleRate float64
	Log        Logger
}

// NewAuditor returns an auditor with the documented 5% default.
func NewAuditor(store AuditStore, ts tsstore.Store) *Auditor {
	return &Auditor{store: store, ts: ts, SampleRate: 0.05}
}

// AuditReport carries each part's verdict; OK is their conjunction.
type AuditReport struct {
	Users []storage.TSBlobUserAudit `json:"users"`
	// PointSumOK: every user's timeseries row count equals its stamped
	// ts_point_count sum.
	PointSumOK bool `json:"point_sum_ok"`
	// CompleteOK: no activity is left unstamped (backfill fully drained).
	CompleteOK bool `json:"complete_ok"`
	Sample     struct {
		Sampled  int      `json:"sampled"`
		OK       int      `json:"ok"`
		Mismatch int      `json:"mismatch"`
		Problems []string `json:"problems,omitempty"` // up to 20, named
		SampleOK bool     `json:"sample_ok"`
	} `json:"sample"`
	Objects struct {
		BucketObjects int64    `json:"bucket_objects"`
		Pointers      int64    `json:"pointers"`
		BucketOnly    []string `json:"bucket_only,omitempty"`  // orphans-in-waiting, up to 20
		PointerOnly   []string `json:"pointer_only,omitempty"` // missing blobs, up to 20
		ObjectsOK     bool     `json:"objects_ok"`
	} `json:"objects"`
	OK bool `json:"ok"`
}

// maxAuditProblems caps each named-problem list; counts stay exact.
const maxAuditProblems = 20

// Run executes all three checks. The report's OK is the soak gate: every part
// green. A non-nil error means the audit itself could not run (DB/bucket
// fault) — that is an operator-visible incident, not a reconciliation verdict.
func (a *Auditor) Run(ctx context.Context) (AuditReport, error) {
	var report AuditReport
	report.PointSumOK, report.CompleteOK = true, true
	report.Sample.SampleOK = true
	report.Objects.ObjectsOK = true

	users, err := a.store.TSBlobUserAudits(ctx)
	if err != nil {
		return report, err
	}
	report.Users = users
	for _, u := range users {
		if !u.PointSumOK {
			report.PointSumOK = false
		}
		if !u.CompleteOK {
			report.CompleteOK = false
		}
	}

	pointers, err := a.store.ListTSBlobPointers(ctx)
	if err != nil {
		return report, err
	}
	report.Objects.Pointers = int64(len(pointers))

	if err := a.auditSample(ctx, pointers, &report); err != nil {
		return report, err
	}
	if err := a.auditObjects(ctx, pointers, &report); err != nil {
		return report, err
	}

	report.OK = report.PointSumOK && report.CompleteOK && report.Sample.SampleOK && report.Objects.ObjectsOK
	a.Log.printf("tsblob audit: point_sum_ok=%v complete_ok=%v sample=%d/%d ok objects=%d vs pointers=%d ok=%v verdict=%v",
		report.PointSumOK, report.CompleteOK, report.Sample.OK, report.Sample.Sampled,
		report.Objects.BucketObjects, report.Objects.Pointers, report.Objects.ObjectsOK, report.OK)
	return report, nil
}

// auditSample recomputes checksums for the deterministic sample: re-encode
// the row set, compare with the row's ts_sha256, then fetch and decode the
// bucket blob and compare its envelope checksum and point count too.
func (a *Auditor) auditSample(ctx context.Context, pointers []storage.TSBlobPointer, report *AuditReport) error {
	rate := a.SampleRate
	if rate <= 0 {
		rate = 0.05
	}
	if rate > 1 {
		rate = 1
	}
	step := int(1 / rate)
	if step < 1 {
		step = 1
	}
	problem := func(format string, args ...any) {
		report.Sample.Mismatch++
		report.Sample.SampleOK = false
		if len(report.Sample.Problems) < maxAuditProblems {
			report.Sample.Problems = append(report.Sample.Problems, fmt.Sprintf(format, args...))
		}
	}
	for i := 0; i < len(pointers); i += step {
		p := pointers[i]
		report.Sample.Sampled++
		rows, err := a.store.ActivityTimeseries(ctx, p.UserID, p.Label)
		if err != nil {
			problem("%s/%s: read rows: %v", p.UserID, p.Label, err)
			continue
		}
		_, recomputed, err := tsstore.EncodePoints(p.UserID, p.Label, storage.TSBlobPoints(rows))
		if err != nil {
			problem("%s/%s: re-encode: %v", p.UserID, p.Label, err)
			continue
		}
		if recomputed != p.SHA256 {
			problem("%s/%s: row ts_sha256 %s != recomputed %s (rows drifted from the stamped blob)",
				p.UserID, p.Label, p.SHA256, recomputed)
			continue
		}
		payload, err := a.ts.Get(ctx, tsstore.BlobKey(p.UserID, p.Label))
		if err != nil {
			problem("%s/%s: bucket get: %v (pointer points at nothing?)", p.UserID, p.Label, err)
			continue
		}
		blob, err := tsstore.DecodePoints(payload)
		if err != nil {
			problem("%s/%s: blob decode: %v (corrupt object)", p.UserID, p.Label, err)
			continue
		}
		if blob.SHA256 != p.SHA256 || blob.PointCount != len(rows) {
			problem("%s/%s: blob (%s, %d pts) != row (%s, %d rows)",
				p.UserID, p.Label, blob.SHA256, blob.PointCount, p.SHA256, len(rows))
			continue
		}
		report.Sample.OK++
	}
	return nil
}

// auditObjects lists the bucket and diffs it against the pointer set.
func (a *Auditor) auditObjects(ctx context.Context, pointers []storage.TSBlobPointer, report *AuditReport) error {
	pointerKeys := make(map[string]bool, len(pointers))
	for _, p := range pointers {
		pointerKeys[tsstore.BlobKey(p.UserID, p.Label)] = true
	}
	bucketKeys := map[string]bool{}
	if err := a.ts.List(ctx, tsstore.KeyPrefix, func(info tsstore.ObjectInfo) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		bucketKeys[info.Key] = true
		return nil
	}); err != nil {
		return fmt.Errorf("tsblob: list bucket: %w", err)
	}
	report.Objects.BucketObjects = int64(len(bucketKeys))

	for key := range bucketKeys {
		if !pointerKeys[key] && len(report.Objects.BucketOnly) < maxAuditProblems {
			report.Objects.BucketOnly = append(report.Objects.BucketOnly, key)
		}
	}
	for key := range pointerKeys {
		if !bucketKeys[key] && len(report.Objects.PointerOnly) < maxAuditProblems {
			report.Objects.PointerOnly = append(report.Objects.PointerOnly, key)
		}
	}
	sort.Strings(report.Objects.BucketOnly)
	sort.Strings(report.Objects.PointerOnly)
	// Count equality is the AC; the set diff names whatever caused a gap (and
	// catches the equal-counts-different-sets case too).
	report.Objects.ObjectsOK = report.Objects.BucketObjects == report.Objects.Pointers &&
		len(report.Objects.BucketOnly) == 0 && len(report.Objects.PointerOnly) == 0
	return nil
}
