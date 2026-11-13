package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/job"
)

func TestCandidateJobMustBelongToTargetAndMatchConfirmedContent(t *testing.T) {
	h := newMPHarness(t)
	owner, other, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	content := mustAppliedContent(t, uuid.NewString())
	content["candidate_job_id"] = id
	content["candidate_user_id"] = owner
	content["weekly_docs"] = []any{}
	result, err := json.Marshal(map[string]any{"content": content})
	if err != nil {
		t.Fatal(err)
	}
	jobs := &fakeJobGetter{rows: map[string]*job.Job{id: {ID: id, UserID: owner, Type: "generate_master_plan", Status: job.StatusDone, ResultJSON: string(result)}}}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&h.key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatal(err)
	}
	h.svc = NewService(Config{Auth: NewAuthenticator(testToken, verifier), MasterPlanStore: h.store, Jobs: jobs})

	foreign := doApplyFromContent(t, h, h.bearer(t, other), map[string]any{"content": content, "apply_token": id})
	if foreign.Code != http.StatusUnprocessableEntity || h.store.current[other] != nil {
		t.Fatalf("foreign status=%d", foreign.Code)
	}
	tampered := mustAppliedContent(t, uuid.NewString())
	tampered["candidate_job_id"], tampered["candidate_user_id"], tampered["weekly_docs"] = id, owner, []any{}
	modified := doApplyFromContent(t, h, h.bearer(t, owner), map[string]any{"content": tampered, "apply_token": id})
	if modified.Code != http.StatusUnprocessableEntity || h.store.current[owner] != nil {
		t.Fatalf("tampered status=%d", modified.Code)
	}
	wrongToken := doApplyFromContent(t, h, h.bearer(t, owner), map[string]any{"content": content, "apply_token": uuid.NewString()})
	if wrongToken.Code != http.StatusUnprocessableEntity || h.store.current[owner] != nil {
		t.Fatalf("wrong token status=%d", wrongToken.Code)
	}
	admin := h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin")
	foreignAdmin := doApply(t, h, admin, other, applyRequestBody(content, false, nil, nil))
	if foreignAdmin.Code != http.StatusUnprocessableEntity || h.store.current[other] != nil {
		t.Fatalf("foreign admin status=%d", foreignAdmin.Code)
	}
	legitimate := doApplyFromContent(t, h, h.bearer(t, owner), map[string]any{"content": content, "apply_token": id})
	if legitimate.Code != http.StatusCreated {
		t.Fatalf("legitimate status=%d body=%s", legitimate.Code, legitimate.Body.String())
	}
}

func registerCandidateFixture(t *testing.T, h *mpHarness, uid string, content map[string]any) string {
	t.Helper()
	id := uuid.NewString()
	content["candidate_job_id"] = id
	content["candidate_user_id"] = uid
	result, err := json.Marshal(map[string]any{"content": content})
	if err != nil {
		t.Fatal(err)
	}
	jobs := &fakeJobGetter{rows: map[string]*job.Job{id: {ID: id, UserID: uid, Type: "generate_master_plan", Status: job.StatusDone, ResultJSON: string(result)}}}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&h.key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatal(err)
	}
	h.svc = NewService(Config{Auth: NewAuthenticator(testToken, verifier), MasterPlanStore: h.store, Jobs: jobs})
	return id
}
