// audit.go is the timeseries migration's residual reconciliation (devops#785
// AC3, reshaped by devops#788): with the row table dropped, the blob is the
// only copy, so the reconciliation is blob-internal. Two parts:
//
//  1. a deterministic sample of stamped activities checked blob-internally —
//     decode must succeed, the envelope checksum must equal the row's
//     ts_sha256, and the envelope count must equal ts_point_count;
//  2. bucket object count vs pointer count — plus the exact set diff, so a
//     missing blob or an orphan is named, not just counted.
//
// The pre-Phase-4 parts that reconciled against timeseries rows (per-user
// COUNT(*) vs SUM(ts_point_count), row re-encode) retired with the table: the
// final row-based audit ran 2026-11-09 against the frozen rows and is
// archived on devops#788.
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
	ListTSBlobPointers(ctx context.Context) ([]storage.TSBlobPointer, error)
}

// Auditor reconciles pointer columns and bucket objects.
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
	Sample struct {
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

// Run executes both checks. The report's OK is the soak gate: every part
// green. A non-nil error means the audit itself could not run (DB/bucket
// fault) — that is an operator-visible incident, not a reconciliation verdict.
func (a *Auditor) Run(ctx context.Context) (AuditReport, error) {
	var report AuditReport
	report.Sample.SampleOK = true
	report.Objects.ObjectsOK = true

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

	report.OK = report.Sample.SampleOK && report.Objects.ObjectsOK
	a.Log.printf("tsblob audit: sample=%d/%d ok objects=%d vs pointers=%d ok=%v verdict=%v",
		report.Sample.OK, report.Sample.Sampled,
		report.Objects.BucketObjects, report.Objects.Pointers, report.Objects.ObjectsOK, report.OK)
	return report, nil
}

// auditSample checks the deterministic sample blob-internally: the pointer
// columns are the only record beside the object itself, so decode must
// succeed, the envelope checksum must equal ts_sha256, and the envelope count
// must equal ts_point_count.
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
		if blob.SHA256 != p.SHA256 || int64(blob.PointCount) != p.PointCount {
			problem("%s/%s: blob (%s, %d pts) != pointer (%s, %d pts)",
				p.UserID, p.Label, blob.SHA256, blob.PointCount, p.SHA256, p.PointCount)
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
