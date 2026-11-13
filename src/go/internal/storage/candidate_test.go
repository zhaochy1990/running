package storage

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/job"
)

func candidateFixture(t *testing.T, userID string) (map[string]any, string) {
	t.Helper()
	id := uuid.NewString()
	content := map[string]any{
		"candidate_job_id":  id,
		"candidate_user_id": userID,
		"weekly_docs":       []any{},
		"start_date":        "2026-11-16",
	}
	return content, id
}

func TestCandidateJobIDValidatesIdentity(t *testing.T) {
	userID := uuid.NewString()
	content, id := candidateFixture(t, userID)

	if got, err := CandidateJobID(map[string]any{"goal": map[string]any{}}, userID, ""); err != nil || got != "" {
		t.Fatalf("legacy content = %q, %v", got, err)
	}
	if got, err := CandidateJobID(content, userID, id); err != nil || got != id {
		t.Fatalf("valid candidate = %q, %v", got, err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"missing job id":      func(c map[string]any) { delete(c, "candidate_job_id") },
		"invalid job id":      func(c map[string]any) { c["candidate_job_id"] = "nope" },
		"foreign user":        func(c map[string]any) { c["candidate_user_id"] = uuid.NewString() },
		"missing user":        func(c map[string]any) { delete(c, "candidate_user_id") },
		"missing weekly docs": func(c map[string]any) { delete(c, "weekly_docs") },
	} {
		broken, _ := candidateFixture(t, userID)
		mutate(broken)
		if _, err := CandidateJobID(broken, userID, ""); !errors.Is(err, ErrCandidateInvalid) {
			t.Fatalf("%s: err = %v, want invalid", name, err)
		}
	}
	if _, err := CandidateJobID(content, userID, uuid.NewString()); !errors.Is(err, ErrCandidateInvalid) {
		t.Fatalf("wrong token err = %v, want invalid", err)
	}
}

func TestCandidateArtifactMatchesCompletedOwnerJob(t *testing.T) {
	userID := uuid.NewString()
	content, id := candidateFixture(t, userID)
	result, err := json.Marshal(map[string]any{"content": content})
	if err != nil {
		t.Fatal(err)
	}
	source := &job.Job{ID: id, UserID: userID, Type: MasterPlanJobType, Status: job.StatusDone, ResultJSON: string(result)}
	if !CandidateArtifactMatches(content, userID, source) {
		t.Fatal("exact artifact must match")
	}
	for name, mutate := range map[string]func(*job.Job){
		"foreign owner":  func(j *job.Job) { j.UserID = uuid.NewString() },
		"wrong type":     func(j *job.Job) { j.Type = "generate_rolling_block" },
		"not done":       func(j *job.Job) { j.Status = job.StatusRunning },
		"changed result": func(j *job.Job) { j.ResultJSON = `{"content":{"changed":true}}` },
		"wrong job id":   func(j *job.Job) { j.ID = uuid.NewString() },
	} {
		broken := *source
		mutate(&broken)
		if CandidateArtifactMatches(content, userID, &broken) {
			t.Fatalf("%s must not match", name)
		}
	}
	if CandidateArtifactMatches(content, userID, nil) {
		t.Fatal("nil job must not match")
	}
}
