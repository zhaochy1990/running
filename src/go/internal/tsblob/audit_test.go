// audit_test.go drives the reconciliation with an in-memory store fake and a
// MemStore bucket — no MySQL, no real bucket, exercising exactly the
// comparison logic (envelope cross-check against the pointer columns, set
// diff).
package tsblob

import (
	"context"
	"fmt"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsstore"
)

// fakeAuditStore serves canned pointers.
type fakeAuditStore struct {
	pointers []storage.TSBlobPointer
}

func (f *fakeAuditStore) ListTSBlobPointers(context.Context) ([]storage.TSBlobPointer, error) {
	return f.pointers, nil
}

// auditRows builds the point payload the codec encodes.
func auditRows(n int) []storage.TimeseriesPoint {
	rows := make([]storage.TimeseriesPoint, n)
	for i := range rows {
		sec := int64(i + 1)
		rows[i].Timestamp = &sec
	}
	return rows
}

// putBlob uploads rows through the real codec so the bucket side is exact.
func putBlob(t *testing.T, ts *tsstore.MemStore, userID, labelID string, rows []storage.TimeseriesPoint) (sha string, count int) {
	t.Helper()
	payload, sum, err := tsstore.EncodePoints(userID, labelID, storage.TSBlobPoints(rows))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := ts.Put(context.Background(), tsstore.BlobKey(userID, labelID), payload); err != nil {
		t.Fatalf("put: %v", err)
	}
	return sum, len(rows)
}

// consistentWorld seeds a fully-consistent single-user world: one stamped
// activity whose blob matches its pointer columns.
func consistentWorld(t *testing.T, ts *tsstore.MemStore) *fakeAuditStore {
	t.Helper()
	rows := auditRows(3)
	sha, count := putBlob(t, ts, "u1", "a1", rows)
	return &fakeAuditStore{
		pointers: []storage.TSBlobPointer{{UserID: "u1", Label: "a1", SHA256: sha, PointCount: int64(count)}},
	}
}

func TestAuditor_ConsistentWorldPasses(t *testing.T) {
	ts := tsstore.NewMemStore()
	a := NewAuditor(consistentWorld(t, ts), ts)
	report, err := a.Run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !report.OK || !report.Sample.SampleOK || !report.Objects.ObjectsOK {
		t.Fatalf("consistent world report = %+v, want all green", report)
	}
	if report.Sample.Sampled != 1 || report.Sample.OK != 1 {
		t.Fatalf("sample = %d/%d, want 1/1", report.Sample.OK, report.Sample.Sampled)
	}
	if report.Objects.BucketObjects != 1 || report.Objects.Pointers != 1 {
		t.Fatalf("objects = %d vs %d, want 1 vs 1", report.Objects.BucketObjects, report.Objects.Pointers)
	}
}

func TestAuditor_ChecksumDriftFailsSample(t *testing.T) {
	ts := tsstore.NewMemStore()
	fake := consistentWorld(t, ts)
	// The stamped ts_sha256 names content the object no longer carries (a
	// pointer drifted from its blob) — the envelope cross-check must catch it.
	fake.pointers[0].SHA256 = "deadbeef"
	a := NewAuditor(fake, ts)
	report, err := a.Run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Sample.SampleOK || report.Sample.Mismatch != 1 || len(report.Sample.Problems) != 1 {
		t.Fatalf("checksum drift not caught: %+v", report.Sample)
	}
	if report.OK {
		t.Fatal("overall OK with a sample mismatch")
	}
}

func TestAuditor_CountDriftFailsSample(t *testing.T) {
	ts := tsstore.NewMemStore()
	fake := consistentWorld(t, ts)
	// The stamped ts_point_count disagrees with the envelope's own count.
	fake.pointers[0].PointCount = 99
	a := NewAuditor(fake, ts)
	report, err := a.Run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Sample.SampleOK || report.Sample.Mismatch != 1 {
		t.Fatalf("count drift not caught: %+v", report.Sample)
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
	// A bucket object no pointer names (the GC's work).
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
	fake := &fakeAuditStore{}
	for i := 0; i < 100; i++ {
		userID := fmt.Sprintf("u%02d", i)
		rows := auditRows(1)
		sha, count := putBlob(t, ts, userID, "a", rows)
		fake.pointers = append(fake.pointers, storage.TSBlobPointer{UserID: userID, Label: "a", SHA256: sha, PointCount: int64(count)})
	}

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
