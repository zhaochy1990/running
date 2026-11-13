package storage

import (
	"encoding/json"
	"errors"
	"reflect"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/job"
)

// MasterPlanJobType is the job type that produces a season-plan candidate.
const MasterPlanJobType = "generate_master_plan"

// ErrCandidateInvalid marks content that claims to be a generated candidate but
// carries a malformed identity or does not match its source job.
var ErrCandidateInvalid = errors.New("storage: invalid plan candidate")

// CandidateJobID validates the candidate identity fields carried by content and
// returns the source job id. Content without candidate fields is legacy (the
// pre-#955 apply path) and returns "" without error.
func CandidateJobID(content map[string]any, userID, token string) (string, error) {
	_, hasWeeks := content["weekly_docs"]
	rawID, hasID := content["candidate_job_id"]
	if !hasWeeks && !hasID {
		return "", nil
	}
	id, ok := rawID.(string)
	if !hasWeeks || !ok {
		return "", ErrCandidateInvalid
	}
	if _, err := uuid.Parse(id); err != nil {
		return "", ErrCandidateInvalid
	}
	if content["candidate_user_id"] != userID || (token != "" && token != id) {
		return "", ErrCandidateInvalid
	}
	return id, nil
}

// CandidateArtifactMatches reports whether job is the completed, user-owned
// plan job that recorded exactly this candidate content. Activation calls it
// once for an early rejection and again under the job row lock, so the rule has
// one definition.
func CandidateArtifactMatches(candidate map[string]any, userID string, source *job.Job) bool {
	if source == nil || source.UserID != userID || source.Type != MasterPlanJobType || source.Status != job.StatusDone {
		return false
	}
	id, ok := candidate["candidate_job_id"].(string)
	if !ok || id != source.ID {
		return false
	}
	var result struct {
		Content map[string]any `json:"content"`
	}
	if json.Unmarshal([]byte(source.ResultJSON), &result) != nil {
		return false
	}
	return reflect.DeepEqual(result.Content, candidate)
}
