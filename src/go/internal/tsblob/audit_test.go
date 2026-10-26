// audit_test.go drives the reconciliation with an in-memory store fake and a
// MemStore bucket — no MySQL, no real bucket, exercising exactly the
// comparison logic (checksum recompute, envelope cross-check, set diff).
package tsblob

import (
	"context"
	"fmt"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsstore"
)

// fakeAuditStore serves canned counters, pointers, and row sets.
type fakeAuditStore struct {
	audits   []storage.TSBlobUserAudit
	pointers []storage.TSBlobPointer
	rows     map[string][]storage.TimeseriesPoint // "user/label" -> rows
}

func (f *fakeAuditStore) TSBlobUserAudits(context.Context) ([]storage.TSBlobUserAudit, error) {
	return f.audits, nil
}

func (f *fakeAuditStore) ListTSBlobPointers(context.Context) ([]storage.TSBlobPointer, error) {
	return f.pointers, nil
}

func (f *fakeAuditStore) ActivityTimeseriesRows(_ context.Context, userID, labelID string) ([]storage.TimeseriesPoint, error) {
	return f.rows[userID+"/"+labelID], nil
}

func auditRows(n int) []storage.TimeseriesPoint {
	rows := make([]storage.TimeseriesPoint, n)
	for i := range rows {
		sec := int64(i + 1)
		rows[i].Timestamp = &sec
	}
	return rows
}

// putBlob uploads rows through the real codec so the bucket side is exact.
func putBlob(t *testing.T, ts *tsstore.MemStore, userID, labelID string, rows []storage.TimeseriesPoint) (sha string) {
	t.Helper()
	payload, sum, err := tsstore.EncodePoints(userID, labelID, storage.TSBlobPoints(rows))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := ts.Put(context.Background(), tsstore.BlobKey(userID, labelID), payload); err != nil {
		t.Fatalf("put: %v", err)
	}
	return sum
}

// consistentWorld seeds a fully-migrated single-user world: one activity with
// 3 points, blob uploaded, counters equal, nothing pending.
func consistentWorld(t *testing.T, ts *tsstore.MemStore) *fakeAuditStore {
	t.Helper()
	rows := auditRows(3)
	sha := putBlob(t, ts, "u1", "a1", rows)
	return &fakeAuditStore{
		audits: []storage.TSBlobUserAudit{{
			UserID: "u1", RowPoints: 3, BlobPoints: 3, Migrated: 1,
			PointSumOK: true, CompleteOK: true,
		}},
		pointers: []storage.TSBlobPointer{{UserID: "u1", Label: "a1", SHA256: sha}},
		rows:     map[string][]storage.TimeseriesPoint{"u1/a1": rows},
	}
}

func TestAuditor_ConsistentWorldPasses(t *testing.T) {
	ts := tsstore.NewMemStore()
	a := NewAuditor(consistentWorld(t, ts), ts)
	report, err := a.Run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !report.OK || !report.PointSumOK || !report.CompleteOK || !report.Sample.SampleOK || !report.Objects.ObjectsOK {
		t.Fatalf("consistent world report = %+v, want all green", report)
	}
	if report.Sample.Sampled != 1 || report.Sample.OK != 1 {
		t.Fatalf("sample = %d/%d, want 1/1", report.Sample.OK, report.Sample.Sampled)
	}
	if report.Objects.BucketObjects != 1 || report.Objects.Pointers != 1 {
		t.Fatalf("objects = %d vs %d, want 1 vs 1", report.Objects.BucketObjects, report.Objects.Pointers)
	}
}

func TestAuditor_PointSumMismatchFails(t *testing.T) {
	ts := tsstore.NewMemStore()
	fake := consistentWorld(t, ts)
	audits := fake.audits
	audits[0].RowPoints = 4 // a row drifted in without a blob update
	audits[0].PointSumOK = false
	a := NewAuditor(fake, ts)
	report, err := a.Run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.PointSumOK || report.OK {
		t.Fatalf("point-sum mismatch passed: %+v", report)
	}
}

func TestAuditor_RowDriftFailsSample(t *testing.T) {
	ts := tsstore.NewMemStore()
	fake := consistentWorld(t, ts)
	// The blob and the row's ts_sha256 still agree; the ROWS have drifted (an
	// out-of-band write path touched timeseries). Re-encoding the rows must
	// disagree with the stamped checksum.
	fake.rows["u1/a1"] = auditRows(4)
	a := NewAuditor(fake, ts)
	report, err := a.Run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Sample.SampleOK || report.Sample.Mismatch != 1 || len(report.Sample.Problems) != 1 {
		t.Fatalf("row drift not caught: %+v", report.Sample)
	}
	if report.OK {
		t.Fatal("overall OK with a sample mismatch")
	}
}

func TestAuditor_MissingBlobFailsSampleAndObjects(t *testing.T) {
	ts := tsstore.NewMemStore()
	fake := consistentWorld(t, ts)
	// Simulate the pointer naming an object nobody uploaded.
	if err := ts.Delete(context.Background(), tsstore.BlobKey("u1", "a1")); err != nil {
		t.Fatalf("delete: %v", err)
	}
	a := NewAuditor(fake, ts)
	report, err := a.Run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Sample.SampleOK || report.Sample.Mismatch != 1 {
		t.Fatalf("missing blob not caught by sample: %+v", report.Sample)
	}
	if report.Objects.ObjectsOK || report.Objects.BucketObjects != 0 || report.Objects.Pointers != 1 {
		t.Fatalf("missing blob not caught by object count: %+v", report.Objects)
	}
	if len(report.Objects.PointerOnly) != 1 || report.Objects.PointerOnly[0] != tsstore.BlobKey("u1", "a1") {
		t.Fatalf("pointer_only = %v, want the named key", report.Objects.PointerOnly)
	}
}

func TestAuditor_OrphanObjectFailsObjects(t *testing.T) {
	ts := tsstore.NewMemStore()
	fake := consistentWorld(t, ts)
	// A bucket object no row points at (the GC's future work).
	putBlob(t, ts, "u1", "deleted-activity", auditRows(2))
	a := NewAuditor(fake, ts)
	report, err := a.Run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Objects.ObjectsOK || report.Objects.BucketObjects != 2 {
		t.Fatalf("orphan not caught: %+v", report.Objects)
	}
	if len(report.Objects.BucketOnly) != 1 {
		t.Fatalf("bucket_only = %v, want the orphan named", report.Objects.BucketOnly)
	}
	// The orphan is not a pointer, so the sample still passes; the overall
	// verdict must still fail on the object check.
	if !report.Sample.SampleOK {
		t.Fatalf("sample falsely failed: %+v", report.Sample)
	}
	if report.OK {
		t.Fatal("overall OK with an orphan object")
	}
}

func TestAuditor_SampleDeterministicAndSized(t *testing.T) {
	ts := tsstore.NewMemStore()
	fake := &fakeAuditStore{rows: map[string][]storage.TimeseriesPoint{}}
	for i := 0; i < 100; i++ {
		userID := fmt.Sprintf("u%02d", i)
		rows := auditRows(1)
		sha := putBlob(t, ts, userID, "a", rows)
		fake.pointers = append(fake.pointers, storage.TSBlobPointer{UserID: userID, Label: "a", SHA256: sha})
		fake.rows[userID+"/a"] = rows
	}
	fake.audits = []storage.TSBlobUserAudit{{UserID: "many", RowPoints: 100, BlobPoints: 100, Migrated: 100, PointSumOK: true, CompleteOK: true}}

	a := NewAuditor(fake, ts) // 5% of 100
	first, err := a.Run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if first.Sample.Sampled != 5 || first.Sample.OK != 5 || !first.OK {
		t.Fatalf("sample = %d/%d ok=%v, want 5/5 green", first.Sample.OK, first.Sample.Sampled, first.OK)
	}
	second, _ := a.Run(context.Background())
	if second.Sample.Sampled != first.Sample.Sampled {
		t.Fatal("sample not deterministic across runs")
	}
}
