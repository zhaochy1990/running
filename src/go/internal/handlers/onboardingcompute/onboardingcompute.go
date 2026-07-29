// Package onboardingcompute implements the onboarding_compute job handler: one
// merged compute pass over a user's synced watch data that derives the athlete
// baselines (calibration + personal bests), then training load, then ability,
// persisting the results to MySQL (ADR 0013). It is the second step of the
// onboarding pipeline (full_sync -> onboarding_compute).
//
// The compute is ported from Python stride_core (running_calibration,
// training_load, ability, pb_records) and grows in dependency-ordered slices;
// each stage below is filled and reconcile-gated on its own. This scaffold wires
// the handler end-to-end (partition guard, staged heartbeats, JSON result) so the
// pipeline is live before the math lands.
package onboardingcompute

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/job"
)

// JobType is the catalog/handler name. Keep in sync with internal/catalog.
const JobType = "onboarding_compute"

// Heartbeat percent bands for the three compute stages (ADR 0013). The terminal
// 100 is set by the dispatcher's finishDone on success; ability ends at 99 here
// so a mid-run heartbeat never pre-empts that.
const (
	pctCalibration  = 33
	pctTrainingLoad = 66
	pctAbility      = 99
)

// result is the ResultJSON payload summarising what the pass wrote.
type result struct {
	User   string `json:"user"`
	Status string `json:"status"`
}

// New builds the onboarding_compute handler. j.PartitionKey is the user UUID.
func New() job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		user := j.PartitionKey
		if _, err := uuid.Parse(user); err != nil {
			return "", job.NewPermanentError("bad_partition",
				fmt.Errorf("onboarding_compute: partition key must be a user UUID: %w", err))
		}

		// Stage 1 — calibration baselines + personal bests. (calibration slice)
		_ = hb("calibration", pctCalibration)

		// Stage 2 — per-activity dose + daily CTL/ATL/Form. (training-load slice)
		_ = hb("training_load", pctTrainingLoad)

		// Stage 3 — L2/L3/L4 ability + race estimates. (ability slice)
		_ = hb("ability", pctAbility)

		out, _ := json.Marshal(result{User: user, Status: "scaffold"})
		return string(out), nil
	}
}
