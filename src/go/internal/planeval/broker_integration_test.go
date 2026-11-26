package planeval

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/zhaochy1990/stride/internal/storage"
	"go.uber.org/zap"
)

// This test uses the same isolated MySQL seam as the HTTP suite and a real MQ;
// Kubernetes is kept at its native fake-client seam, never the shared stack.
func TestPlanEval_RealQueueCleanupAndDuplicateDelivery(t *testing.T) {
	url := os.Getenv("PLAN_EVAL_TEST_AMQP_URL")
	management := os.Getenv("PLAN_EVAL_TEST_MANAGEMENT_URL")
	if url == "" || management == "" {
		t.Skip("set PLAN_EVAL_TEST_AMQP_URL and PLAN_EVAL_TEST_MANAGEMENT_URL for MQ integration")
	}
	h := openHarness(t)
	broker, err := NewBroker(url, management, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	if err := broker.Publish(context.Background(), "missing-"+uuid.NewString(), ExecuteMessage{SchemaVersion: 1, SnapshotExecutionID: uuid.NewString()}); err == nil {
		t.Fatal("unroutable publish was confirmed")
	}
	expired, cancelExpired := context.WithCancel(context.Background())
	cancelExpired()
	if err := broker.EnsureQueue(expired, "canceled-"+uuid.NewString()); err == nil {
		t.Fatal("canceled declaration ignored context")
	}
	h.svc.broker = broker
	ctx := context.Background()
	view, _, serr := h.svc.CreateTask(ctx, "admin-1", uuid.NewString(), CreateTaskRequest{AgentVersion: h.version})
	if serr != nil {
		t.Fatal(serr)
	}
	conn, err := amqp.Dial(url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ch, err := conn.Channel()
	if err != nil {
		t.Fatal(err)
	}
	defer ch.QueueDelete(QueueName(h.version), false, false, false)
	// This is the actual unacknowledged message, not a synthetic management count.
	raw, ok, err := ch.Get(QueueName(h.version), false)
	if err != nil || !ok {
		t.Fatalf("delivery: ok=%v %v", ok, err)
	}
	var pointer ExecuteMessage
	if err := json.Unmarshal(raw.Body, &pointer); err != nil || pointer.SnapshotExecutionID != view.Executions[0].ID {
		t.Fatalf("pointer: %s %v", raw.Body, err)
	}
	id := pointer.SnapshotExecutionID
	if _, serr := h.svc.Claim(ctx, claimRequest{SnapshotExecutionID: id, AgentVersion: h.version, WorkerID: "w", ClaimRequestID: "claim-1"}); serr != nil {
		t.Fatal(serr)
	}
	request := submitRequest{PlanEvalWorkerLease: storage.PlanEvalWorkerLease{AgentVersion: h.version, WorkerID: "w", LeaseEpoch: 1}, SubmitID: "submit-1", Result: reportedResult{Kind: "artifact", ArtifactType: "master_plan", Content: "{invalid-json"}}
	first, serr := h.svc.Submit(ctx, id, request)
	if serr != nil {
		t.Fatal(serr)
	}
	// The worker loses the first response and resends exactly the same result.
	replay, serr := h.svc.Submit(ctx, id, request)
	if serr != nil || *first.(*storage.PlanEvalGenerateAck) != *replay.(*storage.PlanEvalGenerateAck) {
		t.Fatalf("lost acknowledgment replay: %+v %v", replay, serr)
	}
	depth, err := broker.QueueDepth(ctx, QueueName(h.version))
	if err != nil || depth.Unacked != 1 || depth.Ready != 0 {
		t.Fatalf("actual in-flight depth: %+v %v", depth, err)
	}
	if serr := h.svc.Cleanup(ctx, h.version); serr == nil || serr.Code != "cleanup_blocked" {
		t.Fatalf("in-flight message did not block cleanup: %v", serr)
	}
	// Requeue the already-persisted Generate and ACK its terminal claim.
	if err := raw.Nack(false, true); err != nil {
		t.Fatal(err)
	}
	raw, ok, err = ch.Get(QueueName(h.version), false)
	if err != nil || !ok {
		t.Fatalf("redelivery: ok=%v %v", ok, err)
	}
	claim, serr := h.svc.Claim(ctx, claimRequest{SnapshotExecutionID: id, AgentVersion: h.version, WorkerID: "new-worker", ClaimRequestID: "claim-2"})
	if serr != nil || claim.(claimTerminal).ArtifactID == nil {
		t.Fatalf("terminal claim: %+v %v", claim, serr)
	}
	if err := raw.Ack(false); err != nil {
		t.Fatal(err)
	}
	// Management totals can race the network ACK; retry only the observation.
	deadline := time.Now().Add(5 * time.Second)
	for {
		depth, err = broker.QueueDepth(ctx, QueueName(h.version))
		if err != nil {
			t.Fatal(err)
		}
		if depth == (QueueDepth{}) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ACK did not drain queue: %+v", depth)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if serr := h.svc.Cleanup(ctx, h.version); serr != nil {
		t.Fatal(serr)
	}
	if _, err := ch.QueueDeclarePassive(QueueName(h.version), true, false, false, false, nil); err != nil {
		t.Fatalf("cleanup deleted queue: %v", err)
	}
	detail, serr := h.svc.TaskDetail(ctx, view.ID)
	if serr != nil || detail.Executions[0].Artifact == nil {
		t.Fatalf("history after cleanup: %+v %v", detail, serr)
	}
}
