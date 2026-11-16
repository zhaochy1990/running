// auxiliary.go is the auxiliary stage executor (devops#1010 AC5, epic
// devops#1004 T06): race detection and route shapes recorded as independent
// retryable work items over the session's activity span. The stage runs NO
// provider calls and holds NO per-user watch lease (neither task publishes
// activities), so a route-shape failure never blocks raw readiness and the
// race task's chunking exists purely to bound one run's LLM scoring cost.
//
// Completion honesty: race candidates that were evaluated and NOT confirmed
// stay in the RaceCandidates query forever (a negative result is not a row),
// so the race item's checkpoint carries the evaluated-label set — the item is
// done only when every current candidate has been evaluated. Route shapes are
// one pass: the filler fills every shapeable row and reports its per-activity
// failures; rows whose GPS trace is too sparse to draw are the vendor-honest
// "no drawable shape" negative and never re-block the stage.
package onboardingrecent

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/onboardingsync"
	"github.com/zhaochy1990/stride/internal/storage"
)

// DefaultAuxRaceChunk bounds one auxiliary race chunk (LLM-scored candidates
// per job run).
const DefaultAuxRaceChunk = 50

// AuxiliaryConfig wires the auxiliary stage's two tasks to the EXISTING job
// handlers (racedetection.New / routethumbnails.NewShapes) so the onboarding
// path runs the same detection and shape code the sync pipelines run — no
// second implementation.
type AuxiliaryConfig struct {
	Race   job.Handler
	Shapes job.Handler
	// RaceChunk caps candidates per chunk; 0 = DefaultAuxRaceChunk.
	RaceChunk int
}

// auxiliaryStore is the storage slice the auxiliary executor adds on top of
// Store: the candidate queries its completion is derived from.
type auxiliaryStore interface {
	Store
	RaceCandidates(ctx context.Context, userID string, labelIDs []string) ([]storage.RaceCandidate, error)
	RouteThumbShapeCandidates(ctx context.Context, userID string) ([]string, error)
	SaveOnboardingSyncWorkItemCheckpoint(ctx context.Context, id int64, checkpoint string) error
}

// raceCheckpoint records which candidate labels the race task has already
// evaluated (they may legitimately remain unconfirmed — a negative result).
type raceCheckpoint struct {
	Processed []string `json:"processed,omitempty"`
}

func runAuxiliary(ctx context.Context, cfg Config, in stageJobInput, sess *storage.OnboardingSyncSession, hb job.Heartbeat) (string, error) {
	if cfg.Aux == nil {
		return "", job.NewPermanentError("aux_not_configured",
			fmt.Errorf("onboardingrecent: auxiliary stage dispatched but no handlers wired"))
	}
	store, ok := cfg.Store.(auxiliaryStore)
	if !ok {
		return "", job.NewPermanentError("store_not_aux_capable",
			fmt.Errorf("onboardingrecent: store does not implement the auxiliary candidate reads"))
	}
	if _, err := store.ResetFailedOnboardingSyncWorkItems(ctx, sess.SessionID, in.Stage); err != nil {
		return "", err
	}
	items, err := store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, in.Stage)
	if err != nil {
		return "", err
	}

	unfinished := 0
	for _, it := range items {
		if it.Status == storage.OnboardingSyncItemDone || it.Status == storage.OnboardingSyncItemGap {
			continue
		}
		switch it.Kind {
		case storage.OnboardingSyncItemKindRaceDetection:
			more, err := runAuxRace(ctx, cfg, store, sess, it, hb)
			if err != nil {
				return "", err
			}
			if more {
				unfinished++
			}
		case storage.OnboardingSyncItemKindRouteShapes:
			more, err := runAuxShapes(ctx, cfg, store, sess, it, hb)
			if err != nil {
				return "", err
			}
			if more {
				unfinished++
			}
		default:
			return "", job.NewPermanentError("bad_work_item",
				fmt.Errorf("onboardingrecent: unknown auxiliary work item kind %q", it.Kind))
		}
	}
	if unfinished > 0 {
		return auxProgressResult(in.Stage, items), nil
	}
	items, err = store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, in.Stage)
	if err != nil {
		return "", err
	}
	return stageResultFromItems(in.Stage, items), nil
}

// runAuxRace evaluates one bounded chunk of the unevaluated race candidates
// and reports whether work remains. Evaluated candidates accumulate in the
// item's checkpoint — the RaceCandidates query cannot express "evaluated and
// rejected", so the checkpoint is the only completion truth.
func runAuxRace(ctx context.Context, cfg Config, store auxiliaryStore, sess *storage.OnboardingSyncSession, it *storage.OnboardingSyncWorkItem, hb job.Heartbeat) (more bool, err error) {
	candidates, err := store.RaceCandidates(ctx, sess.UserID, nil)
	if err != nil {
		return false, err
	}
	evaluated := map[string]bool{}
	var cp raceCheckpoint
	if it.Checkpoint != nil && *it.Checkpoint != "" {
		if err := json.Unmarshal([]byte(*it.Checkpoint), &cp); err != nil {
			return false, fmt.Errorf("onboardingrecent: parse race checkpoint: %w", err)
		}
		for _, id := range cp.Processed {
			evaluated[id] = true
		}
	}
	var todo []string
	for _, c := range candidates {
		if !evaluated[c.LabelID] {
			todo = append(todo, c.LabelID)
		}
	}
	if len(todo) == 0 {
		// Every candidate in the span is evaluated (confirmed or rejected):
		// the task is complete. The credential records the evaluated tally;
		// the observed window is the task's full span (task-shaped stage).
		cred := fmt.Sprintf("stride:v1:range:%s:%s..%s:obs=%s..%s:n=%d",
			storage.OnboardingSyncItemKindRaceDetection, it.RangeFrom, it.RangeTo, it.RangeFrom, it.RangeTo, len(cp.Processed))
		if err := store.MarkOnboardingSyncWorkItem(ctx, it.ID, storage.OnboardingSyncItemDone, cred, nil); err != nil {
			return false, err
		}
		return false, nil
	}
	chunk := cfg.Aux.RaceChunk
	if chunk <= 0 {
		chunk = DefaultAuxRaceChunk
	}
	if len(todo) > chunk {
		todo = todo[:chunk]
	}
	input, err := json.Marshal(map[string]any{"label_ids": todo})
	if err != nil {
		return false, err
	}
	synthetic := &job.Job{ID: fmt.Sprintf("onbsync-aux-race-%s", sess.SessionID), UserID: sess.UserID, InputJSON: string(input)}
	if _, err := cfg.Aux.Race(ctx, synthetic, hb); err != nil {
		// Candidate failures are joined by the handler; a partial batch is a
		// retryable failure of THIS chunk (already-evaluated labels stay in
		// the checkpoint — the retry continues behind them).
		msg := err.Error()
		_ = store.MarkOnboardingSyncWorkItem(ctx, it.ID, storage.OnboardingSyncItemFailed, "", &msg)
		return false, err
	}
	cp.Processed = append(cp.Processed, todo...)
	sort.Strings(cp.Processed)
	blob, err := json.Marshal(cp)
	if err != nil {
		return false, err
	}
	if err := store.SaveOnboardingSyncWorkItemCheckpoint(ctx, it.ID, string(blob)); err != nil {
		return false, err
	}
	remaining := 0
	reval := make(map[string]bool, len(cp.Processed))
	for _, id := range cp.Processed {
		reval[id] = true
	}
	for _, c := range candidates {
		if !reval[c.LabelID] {
			remaining++
		}
	}
	if remaining == 0 {
		// This chunk drained the last unevaluated candidates: the task is
		// complete NOW (marking it on the next entry would leave a pending
		// item behind a completed run — 假完成 by omission).
		cred := fmt.Sprintf("stride:v1:range:%s:%s..%s:obs=%s..%s:n=%d",
			storage.OnboardingSyncItemKindRaceDetection, it.RangeFrom, it.RangeTo, it.RangeFrom, it.RangeTo, len(cp.Processed))
		if err := store.MarkOnboardingSyncWorkItem(ctx, it.ID, storage.OnboardingSyncItemDone, cred, nil); err != nil {
			return false, err
		}
		return false, nil
	}
	return true, nil
}

// runAuxShapes runs the shape filler once and settles the item: per-activity
// failures fail the chunk (retryable), and rows left shapeless after a clean
// pass are the honest "no drawable GPS trace" negative — recorded on the
// credential, never a blocker (route failure does not block raw ready).
func runAuxShapes(ctx context.Context, cfg Config, store auxiliaryStore, sess *storage.OnboardingSyncSession, it *storage.OnboardingSyncWorkItem, hb job.Heartbeat) (more bool, err error) {
	synthetic := &job.Job{ID: fmt.Sprintf("onbsync-aux-shapes-%s", sess.SessionID), UserID: sess.UserID}
	outJSON, err := cfg.Aux.Shapes(ctx, synthetic, hb)
	if err != nil {
		msg := err.Error()
		_ = store.MarkOnboardingSyncWorkItem(ctx, it.ID, storage.OnboardingSyncItemFailed, "", &msg)
		return false, err
	}
	var res struct {
		Generated int `json:"generated"`
		NoGPS     int `json:"no_gps"`
		Failed    int `json:"failed"`
	}
	_ = json.Unmarshal([]byte(outJSON), &res)
	cred := fmt.Sprintf("stride:v1:range:%s:%s..%s:obs=%s..%s:n=%d",
		storage.OnboardingSyncItemKindRouteShapes, it.RangeFrom, it.RangeTo, it.RangeFrom, it.RangeTo, res.Generated)
	if err := store.MarkOnboardingSyncWorkItem(ctx, it.ID, storage.OnboardingSyncItemDone, cred, nil); err != nil {
		return false, err
	}
	return false, nil
}

// auxProgressResult is the in_progress StageResult while auxiliary chunks
// remain: the target span is the scanned span (the pass is bounded by
// candidate chunks, not days); observed stays unset until the items settle.
func auxProgressResult(stage string, items []*storage.OnboardingSyncWorkItem) string {
	res := onboardingsync.StageResult{Stage: stage, Status: onboardingsync.StageStatusInProgress}
	for _, it := range items {
		if res.ScannedFrom == nil || it.RangeFrom < *res.ScannedFrom {
			s := it.RangeFrom
			res.ScannedFrom = &s
		}
		if res.ScannedTo == nil || it.RangeTo > *res.ScannedTo {
			s := it.RangeTo
			res.ScannedTo = &s
		}
	}
	out, err := json.Marshal(res)
	if err != nil {
		return "{}"
	}
	return string(out)
}
