// calibration_user.go is the #999 single-user closed loop over the evolved v4:
// a read-only preview, an idempotent publish that activates the user's
// per-user override in one transaction with its snapshot, an explicit revoke,
// and a bounded derived recompute. Nothing here changes the global policy or
// any other user; activating the evolved v4 for a user is always an explicit,
// separately authorized operation (three-gate discipline: engineering
// admission, single-user trial authorization, statistical gate for rollout).
package compute

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/calibrationsource"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// UserCalibrationJobType is the registered job_type for the single-user
// calibration closed loop. It is internal-only (never user-initiable) and is
// not part of any pipeline: it runs only when an authorized operator enqueues
// it explicitly for one target user.
const UserCalibrationJobType = "user_calibration"

// UserCalibrationStore is the full surface the closed loop needs: candidate
// inputs for the evolved estimate, the effective-selection reader, the
// override policy writes, and the compute/ability derived recompute stores.
// *storage.Store satisfies it.
type UserCalibrationStore interface {
	CalibrationStore
	RevokeUserCalibrationOverride(ctx context.Context, user string, expectedRevision uint64, actor, note string) error
	PublishUserCalibrationOverride(ctx context.Context, snapshot *storage.RunningCalibrationSnapshot, pace []storage.RunningCalibrationPaceZone, hr []storage.RunningCalibrationHRZone, override storage.RunningCalibrationUserOverride) (uint64, error)
	RunningCalibrationSnapshotsForUser(ctx context.Context, user string) ([]storage.RunningCalibrationSnapshot, error)
	ComputeStore
	AbilityStore
}

type userCalibrationInput struct {
	Action   string `json:"action"`
	AsOfDate string `json:"as_of_day,omitempty"`
	Days     int    `json:"days,omitempty"`
	Actor    string `json:"actor,omitempty"`
	Note     string `json:"note,omitempty"`
}

// UserEvolvedPreview is the read-only preview result: the complete evolved
// offline report (centers, states, ranges, lineage — the acceptance-review and
// T6 display surface), the zones that would publish, the current effective
// selection, and whether publication would currently be accepted. It performs
// no writes of any kind.
type UserEvolvedPreview struct {
	User           string                              `json:"user"`
	AsOfDay        string                              `json:"as_of_day"`
	Selection      storage.CalibrationSelection        `json:"selection"`
	Result         calibration.OfflineResult           `json:"result"`
	Zones          calibration.ZoneSet                 `json:"zones"`
	Publishable    bool                                `json:"publishable"`
	RefusalReasons []string                            `json:"refusal_reasons,omitempty"`
	PriorSnapshot  *storage.RunningCalibrationSnapshot `json:"prior_snapshot,omitempty"`
}

// UserEvolvedPreviewStore is the minimal read surface PreviewUserEvolvedCalibration needs.
type UserEvolvedPreviewStore interface {
	calibrationsource.CandidateReader
	storage.CalibrationReader
	LatestRunningCalibrationSnapshotForIdentity(ctx context.Context, user string, algorithmVersion int, algorithmRevision, asOf string) (*storage.RunningCalibrationSnapshot, error)
}

// evolvedPriorFromSnapshot assembles the weak historical capability prior from
// the user's previous evolved snapshot (#998 fixed-order state chain). The
// persisted summary does not carry the trend stamp, so TrendPerDay stays at
// the declared zero value (aged-center semantics) — the 180-day window
// re-identifies the trend on every run.
func evolvedPriorFromSnapshot(row *storage.RunningCalibrationSnapshot, asOf time.Time) *calibration.HistoricalCapabilityPrior {
	if row == nil || row.ThresholdSpeedMps == nil || *row.ThresholdSpeedMps <= 0 {
		return nil
	}
	priorDay, err := time.Parse("2006-01-02", row.AsOfDate)
	if err != nil {
		return nil
	}
	age := asOf.Sub(priorDay).Hours() / 24
	if age < 0 {
		age = 0
	}
	return &calibration.HistoricalCapabilityPrior{
		V60Mps:           *row.ThresholdSpeedMps,
		AgeDays:          age,
		AsOfDate:         priorDay,
		InputFingerprint: calibration.ParseSource(row.SourceJSON).Fingerprint,
	}
}

// runUserEvolvedEstimate loads the user's candidate inputs as-of the requested
// Shanghai day, chains the prior from the previous evolved snapshot on an
// earlier day, and runs the evolved v4 joint fit. Repeatable inputs give a
// deterministic result (same event set, same output).
func runUserEvolvedEstimate(ctx context.Context, store UserEvolvedPreviewStore, user string, asOf time.Time) (calibration.OfflineResult, *storage.RunningCalibrationSnapshot, error) {
	history, health, metadata, err := calibrationsource.LoadCandidate(ctx, store, user, "", asOf, calibrationLookbackDays)
	if err != nil {
		return calibration.OfflineResult{}, nil, err
	}
	priorRow, err := store.LatestRunningCalibrationSnapshotForIdentity(ctx, user, calibration.CandidateVersion, calibration.EvolvedCandidateAlgorithmRevision, asOf.AddDate(0, 0, -1).Format("2006-01-02"))
	if err != nil {
		return calibration.OfflineResult{}, nil, err
	}
	result, err := calibration.EstimateEvolvedOffline(history, asOf, health, metadata, evolvedPriorFromSnapshot(priorRow, asOf))
	if err != nil {
		return calibration.OfflineResult{}, nil, err
	}
	return result, priorRow, nil
}

// evolvedPublicationRefusals applies the three-gate trial rule: prior_dominated
// and stale are declared estimate semantics and publish; unavailable channels
// or non-finite centers are invalid estimates and must refuse (nothing is
// written, the user's previous selection stays).
func evolvedPublicationRefusals(result calibration.OfflineResult) []string {
	var refusals []string
	if result.Evolved == nil || result.Evolved.Speed == nil || result.Evolved.HR == nil {
		return append(refusals, "evolved_report_missing")
	}
	finite := func(v *float64) bool { return v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) }
	for _, channel := range []struct {
		name   string
		state  calibration.EstimationState
		center *float64
	}{{"speed", result.Evolved.Speed.State, result.Snapshot.ThresholdSpeedMps}, {"hr", result.Evolved.HR.State, result.Snapshot.ThresholdHR}} {
		if channel.state == calibration.StateUnavailable {
			refusals = append(refusals, channel.name+"_estimate_unavailable")
			continue
		}
		if !finite(channel.center) {
			refusals = append(refusals, channel.name+"_center_not_finite")
		}
	}
	return refusals
}

// PreviewUserEvolvedCalibration computes the evolved v4 for one user entirely
// in memory: no snapshot, zone, override or derived row is written, and no
// cache side effects escape the call (the calibration cache is scoped to it).
func PreviewUserEvolvedCalibration(ctx context.Context, store UserEvolvedPreviewStore, user string, asOf time.Time) (UserEvolvedPreview, error) {
	ctx = storage.WithCalibrationCache(ctx)
	day := timefmt.ShanghaiDayStr(asOf)
	out := UserEvolvedPreview{User: user, AsOfDay: day, RefusalReasons: []string{}}
	current, err := storage.ReadCachedRunningCalibration(ctx, store, user, day, storage.CalibrationActive)
	if err != nil {
		return out, err
	}
	out.Selection = current.Selection
	result, priorRow, err := runUserEvolvedEstimate(ctx, store, user, asOf)
	if err != nil {
		return out, err
	}
	out.Result = result
	out.Zones = calibration.ComputeTrainingZones(result.Snapshot)
	out.RefusalReasons = evolvedPublicationRefusals(result)
	out.Publishable = len(out.RefusalReasons) == 0
	if priorRow != nil {
		out.PriorSnapshot = priorRow
	}
	return out, nil
}

// NewUserCalibration builds the single-user closed-loop job handler. j.UserID
// is the target athlete UUID (hard partition); InputJSON selects the action:
//
//	publish   — run the evolved v4 for the user and, if the estimate is valid,
//	            write the pinned-identity snapshot + zones and activate the
//	            user's override in one transaction. Idempotent: a retry with
//	            the same inputs and identity rewrites the same row and leaves
//	            an identical active override untouched.
//	revoke    — deactivate the user's override (CAS on its revision). Reads
//	            immediately fall back to the global selection; already-written
//	            derived rows are NOT rolled back (run recompute after revoking
//	            to rebuild them under the restored selection).
//	recompute — refresh the user's effective calibration snapshot, then rebuild
//	            the derived rows (load/zones/PMC/ability) for the last `days`
//	            days (default 30, capped 365) under the currently effective
//	            selection, seeded from the day before the window. Historical
//	            days resolve to their own as-of snapshots: today's new
//	            thresholds never backfill history, and formal training plans
//	            are never touched.
func NewUserCalibration(store UserCalibrationStore) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		user := j.UserID
		if _, err := uuid.Parse(user); err != nil {
			return "", job.NewPermanentError("bad_partition", fmt.Errorf("user calibration: partition key must be a user UUID: %w", err))
		}
		var in userCalibrationInput
		if strings.TrimSpace(j.InputJSON) != "" {
			if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
				return "", job.NewPermanentError("bad_payload", fmt.Errorf("user calibration: parse input: %w", err))
			}
		}
		asOf := timefmt.ShanghaiToday()
		if in.AsOfDate != "" {
			parsed, err := time.Parse("2006-01-02", in.AsOfDate)
			if err != nil || parsed.Format("2006-01-02") != in.AsOfDate {
				return "", job.NewPermanentError("bad_payload", fmt.Errorf("user calibration: as_of_day must be a Shanghai YYYY-MM-DD"))
			}
			asOf = parsed
		}
		switch in.Action {
		case "publish":
			return publishUserEvolved(ctx, store, user, asOf, in, hb)
		case "revoke":
			return revokeUserOverride(ctx, store, user, in)
		case "recompute":
			return recomputeUserDerived(ctx, store, user, asOf, in, hb)
		default:
			return "", job.NewPermanentError("bad_payload", fmt.Errorf("user calibration: action must be publish|revoke|recompute"))
		}
	}
}

func publishUserEvolved(ctx context.Context, store UserCalibrationStore, user string, asOf time.Time, in userCalibrationInput, hb job.Heartbeat) (string, error) {
	preview, err := PreviewUserEvolvedCalibration(ctx, store, user, asOf)
	if err != nil {
		return "", err
	}
	if !preview.Publishable {
		// Invalid estimate: nothing is written; the previous selection and all
		// existing rows survive untouched.
		return "", job.NewPermanentError("invalid_estimate", fmt.Errorf("user calibration: evolved estimate not publishable: %s", strings.Join(preview.RefusalReasons, ",")))
	}
	result := preview.Result
	row := toStorageSnapshot(user, result.Snapshot)
	row.AlgorithmRevision = result.AlgorithmRevision
	source := calibration.SummarizeSource(result)
	raw, err := json.Marshal(source)
	if err != nil {
		return "", err
	}
	text := string(raw)
	row.SourceJSON = &text
	paceZones, hrZones := toStorageZones(preview.Zones)
	override := storage.RunningCalibrationUserOverride{
		UserID:            user,
		AlgorithmVersion:  calibration.CandidateVersion,
		AlgorithmRevision: calibration.EvolvedCandidateAlgorithmRevision,
		Actor:             in.Actor,
		Note:              in.Note,
	}
	snapID, err := store.PublishUserCalibrationOverride(ctx, row, paceZones, hrZones, override)
	if err != nil {
		return "", err
	}
	_ = hb("publish", 90)
	// Report the reader-visible post-publish state: effective selection,
	// fingerprint and the authorizing override row.
	bundle, err := store.ReadEffectiveRunningCalibration(ctx, user, asOf.Format("2006-01-02"), storage.CalibrationActive)
	if err != nil {
		return "", err
	}
	stored, err := store.UserCalibrationOverride(ctx, user)
	if err != nil {
		return "", err
	}
	out := map[string]any{
		"status":                  "published",
		"user":                    user,
		"as_of_day":               asOf.Format("2006-01-02"),
		"calibration_snapshot_id": snapID,
		"algorithm_version":       bundle.Snapshot.AlgorithmVersion,
		"algorithm_revision":      bundle.Snapshot.AlgorithmRevision,
		"speed_state":             result.Evolved.Speed.State,
		"hr_state":                result.Evolved.HR.State,
		"fingerprint":             bundle.Fingerprint,
		"selection":               bundle.Selection,
	}
	if stored != nil {
		out["override_revision"] = stored.Revision
	}
	if preview.PriorSnapshot != nil {
		out["prior_snapshot_id"] = preview.PriorSnapshot.ID
		out["prior_as_of_day"] = preview.PriorSnapshot.AsOfDate
	}
	rawOut, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	_ = hb("publish", 100)
	return string(rawOut), nil
}

func revokeUserOverride(ctx context.Context, store UserCalibrationStore, user string, in userCalibrationInput) (string, error) {
	override, err := store.UserCalibrationOverride(ctx, user)
	if err != nil {
		return "", err
	}
	if override == nil {
		return "", job.NewPermanentError("override_not_active", fmt.Errorf("user calibration: no active override to revoke"))
	}
	if err := store.RevokeUserCalibrationOverride(ctx, user, override.Revision, in.Actor, in.Note); err != nil {
		return "", err
	}
	bundle, err := store.ReadEffectiveRunningCalibration(ctx, user, timefmt.ShanghaiToday().Format("2006-01-02"), storage.CalibrationActive)
	if err != nil {
		return "", err
	}
	out := map[string]any{
		"status":                    "revoked",
		"user":                      user,
		"revoked_override_revision": override.Revision,
		"restored":                  bundle.Selection,
	}
	rawOut, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(rawOut), nil
}

// recomputeUserDerived runs the documented explicit recompute order (ADR 0045)
// for one user and a bounded window: effective calibration refresh →
// per-activity load/zones + daily PMC (seeded from the day before the window)
// → ability snapshots + per-activity L1. It reuses the canonical compute and
// ability handlers so the recompute cannot drift from the daily sync path.
func recomputeUserDerived(ctx context.Context, store UserCalibrationStore, user string, asOf time.Time, in userCalibrationInput, hb job.Heartbeat) (string, error) {
	days := in.Days
	if days <= 0 {
		days = 30
	}
	if days > 365 {
		return "", job.NewPermanentError("bad_payload", fmt.Errorf("user calibration: recompute days capped at 365"))
	}
	day := asOf.Format("2006-01-02")

	// 1. Refresh the effective calibration snapshot under the current
	// selection (global or override — same unified resolver the daily sync
	// uses).
	refreshOut, err := runUserEffectiveCalibration(ctx, store, user, asOf)
	if err != nil {
		return "", err
	}
	_ = hb("calibration", 20)

	// 2. Derived load/zones/PMC over the window, incremental (seeded) — never a
	// zero-seed full-history rewrite.
	start := asOf.AddDate(0, 0, -(days - 1))
	acts, err := store.ActivitiesInWindow(ctx, user, "", start, asOf)
	if err != nil {
		return "", err
	}
	labelIDs := make([]string, 0, len(acts))
	for _, a := range acts {
		labelIDs = append(labelIDs, a.LabelID)
	}
	computeIn := map[string]any{"mode": "incremental", "label_ids": labelIDs}
	if len(labelIDs) == 0 {
		computeIn["health_dates"] = []string{day}
	}
	rawIn, err := json.Marshal(computeIn)
	if err != nil {
		return "", err
	}
	computeOut, err := NewComputeWithOptions(store, ActiveCalibrationOptions{})(ctx, &job.Job{UserID: user, InputJSON: string(rawIn)}, func(string, int) error { return nil })
	if err != nil {
		return "", err
	}
	_ = hb("compute", 70)

	// 3. Ability snapshots + per-activity L1 over the same window.
	abilityIn := map[string]any{"mode": "backfill", "days": days, "ref_date": day, "label_ids": labelIDs}
	rawAbility, err := json.Marshal(abilityIn)
	if err != nil {
		return "", err
	}
	abilityOut, err := NewAbilityWithOptions(store, ActiveCalibrationOptions{})(ctx, &job.Job{UserID: user, InputJSON: string(rawAbility)}, func(string, int) error { return nil })
	if err != nil {
		return "", err
	}
	_ = hb("ability", 100)

	rawOut, err := json.Marshal(map[string]any{
		"status":      "recomputed",
		"user":        user,
		"days":        days,
		"as_of_day":   day,
		"calibration": json.RawMessage(refreshOut),
		"compute":     json.RawMessage(computeOut),
		"ability":     json.RawMessage(abilityOut),
	})
	if err != nil {
		return "", err
	}
	return string(rawOut), nil
}

// evolvedCalibrationStore is the minimal surface the evolved refresh needs;
// both CalibrationStore and UserCalibrationStore satisfy it.
type evolvedCalibrationStore interface {
	UserEvolvedPreviewStore
	PublishRunningCalibration(context.Context, *storage.RunningCalibrationSnapshot, []storage.RunningCalibrationPaceZone, []storage.RunningCalibrationHRZone) (uint64, error)
}

// runUserEffectiveCalibration refreshes the user's calibration snapshot for
// asOf under the unified effective selection: an active override pinning the
// evolved revision refreshes the evolved identity (prior-chained, revision
// stamped); any other override refreshes its pinned version through the
// existing strategies; no override keeps the exact global daily-sync behavior.
func runUserEffectiveCalibration(ctx context.Context, store UserCalibrationStore, user string, asOf time.Time) (string, error) {
	override, err := store.UserCalibrationOverride(ctx, user)
	if err != nil {
		return "", err
	}
	if override != nil && override.AlgorithmVersion == calibration.CandidateVersion && override.AlgorithmRevision == calibration.EvolvedCandidateAlgorithmRevision {
		return runEvolvedCalibration(ctx, store, user, asOf)
	}
	version := 0
	if override != nil {
		version = override.AlgorithmVersion
	} else {
		policy, err := store.CalibrationPolicy(ctx)
		if err != nil {
			return "", err
		}
		version = policy.ActiveVersion
	}
	snapID, activities, err := runCalibrationVersion(ctx, store, user, asOf, version)
	if err != nil {
		return "", err
	}
	raw, _ := json.Marshal(calibrationResult{User: user, Status: "ok", CalibrationSnapshot: snapID, Activities: activities, AlgorithmVersion: version})
	return string(raw), nil
}

// runEvolvedCalibration computes and publishes the user's evolved snapshot row
// under the pinned revision identity (the override row is already active; this
// refresh never rewrites it).
func runEvolvedCalibration(ctx context.Context, store evolvedCalibrationStore, user string, asOf time.Time) (string, error) {
	result, priorRow, err := runUserEvolvedEstimate(ctx, store, user, asOf)
	if err != nil {
		return "", err
	}
	if refusals := evolvedPublicationRefusals(result); len(refusals) > 0 {
		return "", job.NewPermanentError("invalid_estimate", fmt.Errorf("user calibration: evolved refresh not publishable: %s", strings.Join(refusals, ",")))
	}
	row := toStorageSnapshot(user, result.Snapshot)
	row.AlgorithmRevision = result.AlgorithmRevision
	source := calibration.SummarizeSource(result)
	rawSource, err := json.Marshal(source)
	if err != nil {
		return "", err
	}
	text := string(rawSource)
	row.SourceJSON = &text
	paceZones, hrZones := toStorageZones(calibration.ComputeTrainingZones(result.Snapshot))
	snapID, err := store.PublishRunningCalibration(ctx, row, paceZones, hrZones)
	if err != nil {
		return "", err
	}
	out := map[string]any{"user": user, "status": "ok", "calibration_snapshot_id": snapID, "algorithm_version": calibration.CandidateVersion, "algorithm_revision": calibration.EvolvedCandidateAlgorithmRevision}
	if priorRow != nil {
		out["prior_snapshot_id"] = priorRow.ID
	}
	rawOut, _ := json.Marshal(out)
	return string(rawOut), nil
}
