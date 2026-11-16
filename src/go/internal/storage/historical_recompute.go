// historical_recompute.go is the explicit historical-calibration recompute run
// data layer (devops#1011, epic devops#1004 T07): one auditable run row per
// explicit request plus the per-day evidence ledger.
//
// Run: historical_recompute_runs holds at most one ACTIVE (pending/running)
// run per user. The claim transaction create-or-merges atomically: a repeat
// request under the SAME pinned input revision (analysis as-of day, 365-day
// target, binding revision, calibration policy, input fingerprint) merges into
// the existing run (新的请求合并派发); a request under a DIFFERENT revision
// supersedes the active run and starts a fresh one — an old run's chunks can
// never publish as the new revision's result (旧块拒绝发布并 supersede).
//
// Day ledger: historical_recompute_days records every target day's explicit
// outcome (ready | partial | unavailable) with the published snapshot's
// fingerprint. It is BOTH the honesty record (证据缺失如实报告) and the
// durable resume cursor: a chunk restarts from the first day without a ledger
// row, so the same logical run survives across worker chunks and crashes
// without recomputing settled days.
package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Historical-recompute run lifecycle states.
const (
	HistoricalRecomputeStatePending           = "pending"
	HistoricalRecomputeStateRunning           = "running"
	HistoricalRecomputeStateCompleted         = "completed"
	HistoricalRecomputeStateCompletedWithGaps = "completed_with_gaps"
	HistoricalRecomputeStateSuperseded        = "superseded"
	HistoricalRecomputeStateFailed            = "failed"
)

// Historical-recompute per-day outcome statuses (the evidence ledger).
const (
	HistoricalRecomputeDayReady       = "ready"
	HistoricalRecomputeDayPartial     = "partial"
	HistoricalRecomputeDayUnavailable = "unavailable"
)

// HistoricalRecomputeRun is one explicit historical-calibration recompute run.
// Every revision input is PINNED at claim time and verified again before each
// chunk publishes and at final publication (fencing): binding revision,
// calibration policy version + revision, and the input fingerprint over the
// run's evidence window. A mid-run change supersedes the run instead of
// letting old chunks publish against new revisions.
type HistoricalRecomputeRun struct {
	RunID  string `gorm:"column:run_id;type:char(36);primaryKey"`
	UserID string `gorm:"column:user_id;type:char(36);not null;index"`
	// Provider is the bound watch provider at claim time (audit).
	Provider string `gorm:"column:provider;type:varchar(32);not null"`
	// AnalysisAsOfDay is the run's explicit analysis as-of day — the Shanghai
	// natural day the 365-day target window ends on. Deliberately independent
	// of any sync anchor or "today": the operator pins what the run targets
	// (AC1: 明确 analysis_as_of_day).
	AnalysisAsOfDay string `gorm:"column:analysis_as_of_day;type:char(10);not null"`
	// TargetFromDay/TargetToDay are the inclusive 365-day target window
	// (asOf-364 .. asOf).
	TargetFromDay string `gorm:"column:target_from_day;type:char(10);not null"`
	TargetToDay   string `gorm:"column:target_to_day;type:char(10);not null"`
	// Pinned input revisions.
	BindingRevision int64  `gorm:"column:binding_revision;type:bigint;not null"`
	PolicyVersion   int    `gorm:"column:policy_version;type:int;not null"`
	PolicyRevision  uint64 `gorm:"column:policy_revision;type:bigint unsigned;not null"`
	// InputFingerprint pins the data revision (see HistoricalRecomputeFingerprint).
	InputFingerprint string `gorm:"column:input_fingerprint;type:char(64);not null"`
	State            string `gorm:"column:state;type:varchar(32);not null;index"`
	// SupersedeReason names why an active run was superseded
	// (binding_revision_changed | policy_revision_changed | data_revision_changed |
	// input_revision_changed).
	SupersedeReason *string `gorm:"column:supersede_reason;type:varchar(64)"`
	// CheckpointDay is the last fully processed target day (audit hint; the
	// day ledger is the authoritative resume cursor).
	CheckpointDay *string `gorm:"column:checkpoint_day;type:char(10)"`
	ChunkSeq      int     `gorm:"column:chunk_seq;type:int;not null;default:0"`
	DaysTotal     int     `gorm:"column:days_total;type:int;not null;default:0"`
	DaysReady     int     `gorm:"column:days_ready;type:int;not null;default:0"`
	DaysPartial   int     `gorm:"column:days_partial;type:int;not null;default:0"`
	// DaysUnavailable counts evidence-free days (recorded, never retried).
	DaysUnavailable int `gorm:"column:days_unavailable;type:int;not null;default:0"`
	// BundleFingerprint is the frozen bundle fingerprint over the whole day
	// ledger, written at final publication (AC4: 保存 frozen bundle/fingerprint).
	BundleFingerprint *string `gorm:"column:bundle_fingerprint;type:char(64)"`
	// LastJobID is the newest chunk job dispatched for the run (merge check).
	LastJobID *string   `gorm:"column:last_job_id;type:varchar(64)"`
	LastError *string   `gorm:"column:last_error;type:text"`
	CreatedBy string    `gorm:"column:created_by;type:varchar(64);not null;default:''"`
	CreatedAt time.Time `gorm:"column:created_at;type:datetime(6);not null"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (HistoricalRecomputeRun) TableName() string { return "historical_recompute_runs" }

// Terminal reports whether the run's state is final.
func (r HistoricalRecomputeRun) Terminal() bool {
	switch r.State {
	case HistoricalRecomputeStateCompleted, HistoricalRecomputeStateCompletedWithGaps,
		HistoricalRecomputeStateSuperseded, HistoricalRecomputeStateFailed:
		return true
	}
	return false
}

// HistoricalRecomputeDay is one target day's explicit outcome in the run's
// evidence ledger. First writer wins (insert-only per (run, day)): a retried
// chunk re-observes the day and the unique key keeps one authoritative row.
type HistoricalRecomputeDay struct {
	ID         int64   `gorm:"column:id;primaryKey"`
	RunID      string  `gorm:"column:run_id;type:char(36);not null;uniqueIndex:uq_histrec_day,priority:1"`
	Day        string  `gorm:"column:day;type:char(10);not null;uniqueIndex:uq_histrec_day,priority:2"`
	Status     string  `gorm:"column:status;type:varchar(16);not null"`
	Reason     string  `gorm:"column:reason;type:varchar(64);not null;default:''"`
	SnapshotID *uint64 `gorm:"column:snapshot_id;type:bigint unsigned"`
	// Fingerprint is the published snapshot's persisted fingerprint (empty for
	// evidence-free days, which write no snapshot).
	Fingerprint string `gorm:"column:fingerprint;type:char(64);not null;default:''"`
	// VerifiedExisting marks days whose freshly computed fingerprint matched a
	// pre-existing same-day row (canonical 验证 rather than rebuild).
	VerifiedExisting bool      `gorm:"column:verified_existing;type:boolean;not null;default:false"`
	CreatedAt        time.Time `gorm:"column:created_at;type:datetime(6);not null"`
	UpdatedAt        time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (HistoricalRecomputeDay) TableName() string { return "historical_recompute_days" }

func historicalRecomputeModels() []any {
	return []any{&HistoricalRecomputeRun{}, &HistoricalRecomputeDay{}}
}

// AutoMigrateHistoricalRecompute creates/updates the explicit historical
// recompute tables (devops#1011). Called by `stride worker` (the only writer)
// and tests.
func (s *Store) AutoMigrateHistoricalRecompute(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(historicalRecomputeModels()...); err != nil {
		return fmt.Errorf("storage: automigrate historical recompute: %w", err)
	}
	return nil
}

// HistoricalRecomputeClaimSpec parameterizes the atomic create-or-merge. The
// caller pre-generates RunID (the idempotency key embeds it).
type HistoricalRecomputeClaimSpec struct {
	RunID            string
	UserID           string
	Provider         string
	AnalysisAsOfDay  string
	TargetFromDay    string
	TargetToDay      string
	BindingRevision  int64
	PolicyVersion    int
	PolicyRevision   uint64
	InputFingerprint string
	DaysTotal        int
	CreatedBy        string
	Now              time.Time
}

// HistoricalRecomputeClaimResult is the claim outcome: the run to execute and
// whether THIS call created it (false = merged into an existing active run).
type HistoricalRecomputeClaimResult struct {
	Run            *HistoricalRecomputeRun
	Created        bool
	SupersededFrom *string
}

// historicalRecomputeIdentity is the pinned-revision equality the merge
// decision uses: every field that names WHAT the run computes.
func historicalRecomputeIdentity(r HistoricalRecomputeRun) string {
	return fmt.Sprintf("%s|%s|%s|%d|%d/%d|%s", r.AnalysisAsOfDay, r.TargetFromDay, r.TargetToDay,
		r.BindingRevision, r.PolicyVersion, r.PolicyRevision, r.InputFingerprint)
}

// ClaimOrCreateHistoricalRecomputeRun atomically create-or-merges the user's
// active explicit recompute run. Same pinned identity → the same run returns
// (merge); a different identity → the active run is superseded with reason
// input_revision_changed and a fresh run is created. At most one active run
// per user exists at any time, so concurrent explicit requests collapse onto
// one dispatch (新的请求合并派发).
func (s *Store) ClaimOrCreateHistoricalRecomputeRun(ctx context.Context, spec HistoricalRecomputeClaimSpec) (*HistoricalRecomputeClaimResult, error) {
	if _, err := uuid.Parse(spec.UserID); err != nil {
		return nil, fmt.Errorf("storage: historical recompute user must be a UUID: %w", err)
	}
	if spec.RunID == "" {
		return nil, fmt.Errorf("storage: historical recompute claim requires a pre-generated run id")
	}
	now := spec.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	res := &HistoricalRecomputeClaimResult{}
	txErr := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var active []HistoricalRecomputeRun
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ? AND state IN ?", spec.UserID,
				[]string{HistoricalRecomputeStatePending, HistoricalRecomputeStateRunning}).
			Order("created_at DESC").Find(&active).Error; err != nil {
			return err
		}
		newIdentity := fmt.Sprintf("%s|%s|%s|%d|%d/%d|%s", spec.AnalysisAsOfDay, spec.TargetFromDay, spec.TargetToDay,
			spec.BindingRevision, spec.PolicyVersion, spec.PolicyRevision, spec.InputFingerprint)
		for i := range active {
			a := active[i]
			if historicalRecomputeIdentity(a) == newIdentity {
				res.Run, res.Created = &active[i], false
				return nil // merge: same pinned revision → same logical run
			}
		}
		// Different pinned revision (or none): every active run is superseded
		// before the new one exists — an old chunk may still finish its current
		// job, but its next publish fence refuses it.
		for i := range active {
			reason := "input_revision_changed"
			if err := tx.Model(&HistoricalRecomputeRun{}).
				Where("run_id = ? AND state IN ?", active[i].RunID,
					[]string{HistoricalRecomputeStatePending, HistoricalRecomputeStateRunning}).
				Updates(map[string]any{"state": HistoricalRecomputeStateSuperseded,
					"supersede_reason": reason, "updated_at": now}).Error; err != nil {
				return err
			}
			id := active[i].RunID
			res.SupersededFrom = &id
		}
		row := HistoricalRecomputeRun{
			RunID: spec.RunID, UserID: spec.UserID, Provider: spec.Provider,
			AnalysisAsOfDay: spec.AnalysisAsOfDay,
			TargetFromDay:   spec.TargetFromDay, TargetToDay: spec.TargetToDay,
			BindingRevision: spec.BindingRevision, PolicyVersion: spec.PolicyVersion,
			PolicyRevision: spec.PolicyRevision, InputFingerprint: spec.InputFingerprint,
			State: HistoricalRecomputeStatePending, DaysTotal: spec.DaysTotal,
			CreatedBy: spec.CreatedBy, CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		res.Run, res.Created = &row, true
		return nil
	})
	if txErr != nil {
		return nil, txErr
	}
	return res, nil
}

// GetHistoricalRecomputeRun reads one run row.
func (s *Store) GetHistoricalRecomputeRun(ctx context.Context, runID string) (*HistoricalRecomputeRun, error) {
	var rows []HistoricalRecomputeRun
	if err := s.db.WithContext(ctx).Where("run_id = ?", runID).Limit(1).Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// ActiveHistoricalRecomputeRunByUser returns the user's active run, or nil.
func (s *Store) ActiveHistoricalRecomputeRunByUser(ctx context.Context, userID string) (*HistoricalRecomputeRun, error) {
	var rows []HistoricalRecomputeRun
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND state IN ?", userID,
			[]string{HistoricalRecomputeStatePending, HistoricalRecomputeStateRunning}).
		Order("created_at DESC").Limit(1).Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// ListHistoricalRecomputeDays returns the run's whole evidence ledger, sorted
// by day (the resume decision reads it once per chunk).
func (s *Store) ListHistoricalRecomputeDays(ctx context.Context, runID string) ([]*HistoricalRecomputeDay, error) {
	var rows []*HistoricalRecomputeDay
	if err := s.db.WithContext(ctx).Where("run_id = ?", runID).Order("day ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// RecordHistoricalRecomputeDay inserts one day outcome. Insert-only per
// (run, day): on conflict nothing changes — the first writer's outcome is
// authoritative, so concurrent chunks cannot double-record or flip a settled
// day. Returns whether THIS call was the writer (false = a row already
// existed).
func (s *Store) RecordHistoricalRecomputeDay(ctx context.Context, row *HistoricalRecomputeDay) (bool, error) {
	now := time.Now().UTC()
	row.CreatedAt, row.UpdatedAt = now, now
	tx := s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "run_id"}, {Name: "day"}},
		DoNothing: true,
	}).Create(row)
	if tx.Error != nil {
		return false, tx.Error
	}
	return tx.RowsAffected > 0, nil
}

// HistoricalRecomputeDayCounts aggregates the ledger's outcome counts.
type HistoricalRecomputeDayCounts struct {
	Total       int
	Ready       int
	Partial     int
	Unavailable int
}

// HistoricalRecomputeCounts folds the run's day ledger into the outcome counts.
func (s *Store) HistoricalRecomputeCounts(ctx context.Context, runID string) (HistoricalRecomputeDayCounts, error) {
	var rows []struct {
		Status string
		N      int
	}
	if err := s.db.WithContext(ctx).Model(&HistoricalRecomputeDay{}).
		Select("status, COUNT(*) AS n").Where("run_id = ?", runID).
		Group("status").Scan(&rows).Error; err != nil {
		return HistoricalRecomputeDayCounts{}, err
	}
	var out HistoricalRecomputeDayCounts
	for _, r := range rows {
		out.Total += r.N
		switch r.Status {
		case HistoricalRecomputeDayReady:
			out.Ready += r.N
		case HistoricalRecomputeDayPartial:
			out.Partial += r.N
		case HistoricalRecomputeDayUnavailable:
			out.Unavailable += r.N
		}
	}
	return out, nil
}

// AdvanceHistoricalRecomputeCheckpoint records chunk progress: the checkpoint
// only moves FORWARD (a lagging concurrent writer cannot regress it), and the
// run flips pending → running on its first chunk. No-op for a terminal run.
func (s *Store) AdvanceHistoricalRecomputeCheckpoint(ctx context.Context, runID, checkpointDay string, chunkSeq int, jobID string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var rows []HistoricalRecomputeRun
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("run_id = ?", runID).Limit(1).Find(&rows).Error; err != nil {
			return err
		}
		if len(rows) == 0 {
			return fmt.Errorf("storage: historical recompute run %s not found", runID)
		}
		run := rows[0]
		if run.Terminal() {
			return nil // superseded between the fence check and here: drop the write
		}
		updates := map[string]any{"updated_at": time.Now().UTC()}
		if run.State == HistoricalRecomputeStatePending {
			updates["state"] = HistoricalRecomputeStateRunning
		}
		if checkpointDay != "" && (run.CheckpointDay == nil || checkpointDay > *run.CheckpointDay) {
			updates["checkpoint_day"] = checkpointDay
		}
		if chunkSeq > run.ChunkSeq {
			updates["chunk_seq"] = chunkSeq
		}
		if jobID != "" {
			updates["last_job_id"] = jobID
		}
		return tx.Model(&HistoricalRecomputeRun{}).Where("run_id = ?", runID).Updates(updates).Error
	})
}

// FinalizeHistoricalRecomputeRun publishes the run's terminal outcome from the
// running/pending state: the frozen bundle fingerprint and the ledger's
// outcome counts land atomically. Guarded — a superseded run cannot finalize.
func (s *Store) FinalizeHistoricalRecomputeRun(ctx context.Context, runID, state, bundleFingerprint string, counts HistoricalRecomputeDayCounts) error {
	if state != HistoricalRecomputeStateCompleted && state != HistoricalRecomputeStateCompletedWithGaps {
		return fmt.Errorf("storage: invalid historical recompute finalize state %q", state)
	}
	res := s.db.WithContext(ctx).Model(&HistoricalRecomputeRun{}).
		Where("run_id = ? AND state IN ?", runID,
			[]string{HistoricalRecomputeStatePending, HistoricalRecomputeStateRunning}).
		Updates(map[string]any{
			"state":              state,
			"bundle_fingerprint": bundleFingerprint,
			"days_total":         counts.Total,
			"days_ready":         counts.Ready,
			"days_partial":       counts.Partial,
			"days_unavailable":   counts.Unavailable,
			"updated_at":         time.Now().UTC(),
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("storage: historical recompute run %s not finalizable (not active)", runID)
	}
	return nil
}

// SupersedeHistoricalRecomputeRun marks an active run superseded with a
// reason. Idempotent; only active states transition.
func (s *Store) SupersedeHistoricalRecomputeRun(ctx context.Context, runID, reason string) error {
	return s.db.WithContext(ctx).Model(&HistoricalRecomputeRun{}).
		Where("run_id = ? AND state IN ?", runID,
			[]string{HistoricalRecomputeStatePending, HistoricalRecomputeStateRunning}).
		Updates(map[string]any{"state": HistoricalRecomputeStateSuperseded,
			"supersede_reason": reason, "updated_at": time.Now().UTC()}).Error
}

// FailHistoricalRecomputeRun records a terminal failure (chunk budget or
// unrecoverable executor error).
func (s *Store) FailHistoricalRecomputeRun(ctx context.Context, runID, msg string) error {
	return s.db.WithContext(ctx).Model(&HistoricalRecomputeRun{}).
		Where("run_id = ? AND state IN ?", runID,
			[]string{HistoricalRecomputeStatePending, HistoricalRecomputeStateRunning}).
		Updates(map[string]any{"state": HistoricalRecomputeStateFailed,
			"last_error": msg, "updated_at": time.Now().UTC()}).Error
}

// HistoricalRecomputeFingerprint pins one explicit recompute run's input
// revision: the analysis as-of day, the 365-day target window, the binding
// revision, the calibration policy version + revision, and the evidence-window
// data digest (see OnboardingAnalysisDigest). It hashes INPUT DATA, never
// artifact ids: a same-day snapshot whose inputs changed underneath it still
// invalidates the run (同日 snapshot ID 不变不能阻止重算).
func HistoricalRecomputeFingerprint(asOf, targetFrom, targetTo string, bindingRevision int64, policy RunningCalibrationPolicy, d OnboardingAnalysisDigest) string {
	maxSync := "-"
	if d.ActivityMaxSyncedAt != nil {
		maxSync = d.ActivityMaxSyncedAt.UTC().Format(time.RFC3339Nano)
	}
	healthMax := "-"
	if d.HealthMaxDate != nil {
		healthMax = *d.HealthMaxDate
	}
	hrvMax := "-"
	if d.HRVMaxDate != nil {
		hrvMax = *d.HRVMaxDate
	}
	candidate := -1
	if policy.CandidateVersion != nil {
		candidate = *policy.CandidateVersion
	}
	payload := fmt.Sprintf("hist-v1|asof=%s|target=%s..%s|binding=%d|policy=%d/%d/%d|act=%d/%s/%.2f/%.2f|health=%d/%s/%d/%d/%d|hrv=%d/%s/%d",
		asOf, targetFrom, targetTo, bindingRevision,
		policy.ActiveVersion, policy.Revision, candidate,
		d.ActivityCount, maxSync, d.ActivityDistanceSum, d.ActivityDurationSum,
		d.HealthDayCount, healthMax, d.HealthRHRSum, d.HealthSleepSum, d.HealthScoreSum,
		d.HRVDayCount, hrvMax, d.HRVAvgSum)
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

// HistoricalRecomputeBundleFingerprint freezes the run's whole day ledger into
// one fingerprint: sorted "day|status|fingerprint" triples hashed together.
// It is the set-identity marker the final publication stores (AC4) and later
// derived recompute steps (load/PMC/ability) can consume as one consistent
// baseline bundle instead of a mixed vintage.
func HistoricalRecomputeBundleFingerprint(days []HistoricalRecomputeDay) string {
	sorted := make([]HistoricalRecomputeDay, len(days))
	copy(sorted, days)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j].Day < sorted[j-1].Day; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	payload := "bundle-v1"
	for _, d := range sorted {
		fp := d.Fingerprint
		if fp == "" {
			fp = "-"
		}
		payload += "|" + d.Day + "/" + d.Status + "/" + fp
	}
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}
