package routethumbnails

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

// The tombstone must never fail and never write: an old in-flight pipeline run
// lands here and needs its label_ids batch threaded through to the downstream
// ability step, with a skipped result explaining why nothing happened.
func TestDeprecatedTombstoneIsANoopThatEchoesLabelIDs(t *testing.T) {
	h := NewDeprecated(zap.NewNop())
	result, err := h(context.Background(), &job.Job{
		ID:        "job-1",
		UserID:    testUser,
		InputJSON: `{"mode":"incremental","label_ids":["a1b2","c3d4"]}`,
	}, noopHeartbeat)
	if err != nil {
		t.Fatalf("deprecated tombstone errored: %v", err)
	}

	var got struct {
		Skipped  string   `json:"skipped"`
		LabelIDs []string `json:"label_ids"`
	}
	if err := json.Unmarshal([]byte(result), &got); err != nil {
		t.Fatalf("decode result %s: %v", result, err)
	}
	if got.Skipped != "png_pipeline_retired" {
		t.Fatalf("skipped = %q, want png_pipeline_retired", got.Skipped)
	}
	if len(got.LabelIDs) != 2 || got.LabelIDs[0] != "a1b2" || got.LabelIDs[1] != "c3d4" {
		t.Fatalf("label_ids = %v, want the batch echoed through", got.LabelIDs)
	}
}

// Even a malformed payload must not fail the tombstone — its whole job is to
// let a retired trigger die quietly rather than poison a pipeline.
func TestDeprecatedTombstoneToleratesBadPayload(t *testing.T) {
	h := NewDeprecated(zap.NewNop())
	result, err := h(context.Background(), &job.Job{
		ID:        "job-2",
		UserID:    testUser,
		InputJSON: `{"force":tr`,
	}, noopHeartbeat)
	if err != nil {
		t.Fatalf("deprecated tombstone errored on bad payload: %v", err)
	}
	if !strings.Contains(result, "png_pipeline_retired") {
		t.Fatalf("result = %s, want the skipped marker", result)
	}
}

// The sync step behaves like the shape backfill (fills every drawable gap) and
// additionally echoes the sync's label_ids batch through its result, which is
// what keeps the downstream ability step's L1 batch correct after the retired
// PNG step stopped doing that job (devops#829).
func TestShapesStepFillsGapsAndEchoesLabelIDs(t *testing.T) {
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{
			"run-1": gpsTrace(20),
			"run-2": gpsTrace(20),
		},
		rows: map[string]*string{"run-1": nil, "run-2": nil},
	}

	h := NewShapes(store)
	result, err := h(context.Background(), &job.Job{
		UserID:    testUser,
		InputJSON: `{"mode":"incremental","label_ids":["a1b2"]}`,
	}, noopHeartbeat)
	if err != nil {
		t.Fatalf("shapes step: %v", err)
	}

	got := decodeShapeResult(t, result)
	if got.Candidates != 2 || got.Generated != 2 || got.Failed != 0 {
		t.Fatalf("result = %+v, want 2 candidates generated, none failed", got)
	}
	if len(got.LabelIDs) != 1 || got.LabelIDs[0] != "a1b2" {
		t.Fatalf("label_ids = %v, want [a1b2] echoed through", got.LabelIDs)
	}
	for _, id := range []string{"run-1", "run-2"} {
		if store.rows[id] == nil {
			t.Fatalf("activity %s still has no route_thumb_json", id)
		}
	}
}

// A malformed step input fails permanently rather than retrying a doomed fill,
// matching the sync-pipeline contract the retired PNG step held.
func TestShapesStepRejectsBadPayload(t *testing.T) {
	h := NewShapes(&fakeShapeStore{})
	_, err := h(context.Background(), &job.Job{
		UserID:    testUser,
		InputJSON: `{"label_ids":`,
	}, noopHeartbeat)
	pe, ok := job.AsPermanent(err)
	if !ok || pe.Code != "bad_payload" {
		t.Fatalf("err = %v, want permanent bad_payload", err)
	}
}

// The step shares the backfill's partition contract.
func TestShapesStepRejectsNonUUIDUser(t *testing.T) {
	h := NewShapes(&fakeShapeStore{})
	_, err := h(context.Background(), &job.Job{UserID: "not-a-uuid"}, noopHeartbeat)
	pe, ok := job.AsPermanent(err)
	if !ok || pe.Code != "bad_partition" {
		t.Fatalf("err = %v, want permanent bad_partition", err)
	}
}
