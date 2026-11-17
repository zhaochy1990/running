// historical_metrics_recompute.go is the explicit historical-metrics recompute
// data layer (devops#1012, epic devops#1004 T08): one auditable run row per
// explicit request plus the STAGED artifact ledger the chunked executor writes
// into and the final publication transaction promotes into the production
// derived tables.
//
// Run: historical_metrics_recompute_runs holds at most one ACTIVE run per
// user. Like the T07 calibration run it claims atomically create-or-merge on
// the pinned input identity (analysis as-of day, 365-day target, binding
// revision, calibration policy, full-history data digest) plus the consumed
// frozen calibration bundle (the T07 run id and its bundle fingerprint — the
// set marker ADR 0046 freezes for exactly this consumer); a request under a
// different revision supersedes the active run.
//
// Staged: historical_metrics_recompute_staged holds the run's chunked derived
// artifacts (activity load/zones/L1 rows, daily PMC rows, the full-history PB
// set and the PB scan cursor) keyed (run, kind, item_key). Staged rows are
// BOTH the durable resume cursor (a chunk restarts from the first un-staged
// item — settled work is never recomputed) and the visibility gate: ordinary
// API/Coach reads never touch this table, so until the final publication
// transaction promotes the whole staged set the previous consistent derived
// rows keep serving (上一版一致结果，不混用 PMC 链和基线).
package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

// Historical-metrics run lifecycle states.
const (
	HistoricalMetricsStatePending           = "pending"
	HistoricalMetricsStateRunning           = "running"
	HistoricalMetricsStateCompleted         = "completed"
	HistoricalMetricsStateCompletedWithGaps = "completed_with_gaps"
	HistoricalMetricsStateSuperseded        = "superseded"
	HistoricalMetricsStateFailed            = "failed"
)

// Historical-metrics run phases (the ADR 0045 explicit recompute order:
// per-activity load/classification/zones → daily PMC → full-history PB →
// per-activity L1 → publish + current-ability refresh).
const (
	HistoricalMetricsPhaseActivity = "activity"
	HistoricalMetricsPhaseDaily    = "daily"
	HistoricalMetricsPhasePB       = "pb"
	HistoricalMetricsPhaseL1       = "l1"
	HistoricalMetricsPhasePublish  = "publish"
)

// Staged artifact kinds.
const (
	HistoricalMetricsKindActivityLoad   = "activity_load"
	HistoricalMetricsKindActivitySkip   = "activity_skip"
	HistoricalMetricsKindActivityZones  = "activity_zones"
	HistoricalMetricsKindDailyLoad      = "daily_load"
	HistoricalMetricsKindPersonalBest   = "personal_best"
	HistoricalMetricsKindPBProgress     = "pb_progress"
	HistoricalMetricsKindActivityL1     = "activity_l1"
	HistoricalMetricsKindActivityL1Skip = "activity_l1_skip"
)

// HistoricalMetricsRun is one explicit historical-metrics recompute run.
// Every input revision is PINNED at claim time and re-verified before each
// chunk stages and at final publication (fencing).
type HistoricalMetricsRun struct {
	RunID  string `gorm:"column:run_id;type:char(36);primaryKey"`
	UserID string `gorm:"column:user_id;type:char(36);not null;index"`
	// Provider is the bound watch provider at claim time (audit).
	Provider string `gorm:"column:provider;type:varchar(32);not null"`
	// AnalysisAsOfDay is the Shanghai day the 365-day target window ends on
	// and the anchor of the post-L1 current-ability refresh (当天四层 ability).
	AnalysisAsOfDay string `gorm:"column:analysis_as_of_day;type:char(10);not null"`
	TargetFromDay   string `gorm:"column:target_from_day;type:char(10);not null"`
	TargetToDay     string `gorm:"column:target_to_day;type:char(10);not null"`
	// Pinned input revisions.
	BindingRevision int64  `gorm:"column:binding_revision;type:bigint;not null"`
	PolicyVersion   int    `gorm:"column:policy_version;type:int;not null"`
	PolicyRevision  uint64 `gorm:"column:policy_revision;type:bigint unsigned;not null"`
	// InputFingerprint pins the data revision over the run's whole read
	// surface (full history — the PB stage consumes activities beyond the
	// 365-day window).
	InputFingerprint string `gorm:"column:input_fingerprint;type:char(64);not null"`
	// CalibrationDigestJSON freezes the claim-time calibration-window digest
	// so the fence can attribute a fingerprint mismatch to a rewritten
	// baseline (calibration_bundle_changed) instead of raw inputs.
	CalibrationDigestJSON string `gorm:"column:calibration_digest_json;type:varchar(255);not null;default:''"`
	// The frozen calibration baseline this run consumes as one consistent
	// vintage (ADR 0046): the T07 run and its bundle fingerprint.
	CalibrationRunID             string  `gorm:"column:calibration_run_id;type:char(36);not null"`
	CalibrationBundleFingerprint string  `gorm:"column:calibration_bundle_fingerprint;type:char(64);not null"`
	State                        string  `gorm:"column:state;type:varchar(32);not null;index"`
	SupersedeReason              *string `gorm:"column:supersede_reason;type:varchar(64)"`
	Phase                        string  `gorm:"column:phase;type:varchar(16);not null;default:'activity'"`
	ChunkSeq                     int     `gorm:"column:chunk_seq;type:int;not null;default:0"`
	// Counters are publishing-time aggregates of the staged ledger (audit);
	// the staged rows themselves are the authoritative progress.
	ActivitiesTotal   int `gorm:"column:activities_total;type:int;not null;default:0"`
	ActivitiesStaged  int `gorm:"column:activities_staged;type:int;not null;default:0"`
	ActivitiesSkipped int `gorm:"column:activities_skipped;type:int;not null;default:0"`
	DaysTotal         int `gorm:"column:days_total;type:int;not null;default:0"`
	DaysStaged        int `gorm:"column:days_staged;type:int;not null;default:0"`
	PersonalBests     int `gorm:"column:personal_bests;type:int;not null;default:0"`
	L1Written         int `gorm:"column:l1_written;type:int;not null;default:0"`
	L1Skipped         int `gorm:"column:l1_skipped;type:int;not null;default:0"`
	L1Unavailable     int `gorm:"column:l1_unavailable;type:int;not null;default:0"`
	// OutputFingerprint freezes the whole staged ledger at final publication.
	OutputFingerprint *string `gorm:"column:output_fingerprint;type:char(64)"`
	// PublishedAt records the promotion transaction's commit (the ability
	// refresh + finalize follow it).
	PublishedAt *time.Time `gorm:"column:published_at;type:datetime(6)"`
	LastJobID   *string    `gorm:"column:last_job_id;type:varchar(64)"`
	LastError   *string    `gorm:"column:last_error;type:text"`
	CreatedBy   string     `gorm:"column:created_by;type:varchar(64);not null;default:''"`
	CreatedAt   time.Time  `gorm:"column:created_at;type:datetime(6);not null"`
	UpdatedAt   time.Time  `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (HistoricalMetricsRun) TableName() string { return "historical_metrics_recompute_runs" }

// Terminal reports whether the run's state is final.
func (r HistoricalMetricsRun) Terminal() bool {
	switch r.State {
	case HistoricalMetricsStateCompleted, HistoricalMetricsStateCompletedWithGaps,
		HistoricalMetricsStateSuperseded, HistoricalMetricsStateFailed:
		return true
	}
	return false
}

// HistoricalMetricsStaged is one staged artifact of one run: the payload is
// the JSON-encoded production row (or a small progress/skip record), promoted
// verbatim by the publication transaction.
type HistoricalMetricsStaged struct {
	ID        int64     `gorm:"column:id;primaryKey"`
	RunID     string    `gorm:"column:run_id;type:char(36);not null;uniqueIndex:uq_histmet_staged,priority:1"`
	Kind      string    `gorm:"column:kind;type:varchar(24);not null;uniqueIndex:uq_histmet_staged,priority:2"`
	ItemKey   string    `gorm:"column:item_key;type:varchar(191);not null;uniqueIndex:uq_histmet_staged,priority:3"`
	Payload   string    `gorm:"column:payload;type:longtext;not null"`
	CreatedAt time.Time `gorm:"column:created_at;type:datetime(6);not null"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (HistoricalMetricsStaged) TableName() string { return "historical_metrics_recompute_staged" }

func historicalMetricsModels() []any {
	return []any{&HistoricalMetricsRun{}, &HistoricalMetricsStaged{}}
}

// AutoMigrateHistoricalMetrics creates/updates the explicit historical-metrics
// recompute tables (devops#1012). Called by `stride worker` (the only writer)
// and tests.
func (s *Store) AutoMigrateHistoricalMetrics(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(historicalMetricsModels()...); err != nil {
		return fmt.Errorf("storage: automigrate historical metrics recompute: %w", err)
	}
	return nil
}

// HistoricalMetricsClaimSpec parameterizes the atomic create-or-merge.
type HistoricalMetricsClaimSpec struct {
	RunID                        string
	UserID                       string
	Provider                     string
	AnalysisAsOfDay              string
	TargetFromDay                string
	TargetToDay                  string
	BindingRevision              int64
	PolicyVersion                int
	PolicyRevision               uint64
	InputFingerprint             string
	CalibrationDigestJSON        string
	CalibrationRunID             string
	CalibrationBundleFingerprint string
	ActivitiesTotal              int
	DaysTotal                    int
	CreatedBy                    string
	Now                          time.Time
}

// HistoricalMetricsClaimResult is the claim outcome.
type HistoricalMetricsClaimResult struct {
	Run            *HistoricalMetricsRun
	Created        bool
	SupersededFrom *string
}

// historicalMetricsIdentityString spells the pinned-revision identity both
// the claim's merge decision and historicalMetricsIdentity use — one format,
// spelled once (field drift between the two sides would silently break the
// create-or-merge contract).
func historicalMetricsIdentityString(asOf, from, to string, bindingRevision int64, policyVersion int, policyRevision uint64, inputFingerprint, calRunID, calBundleFP string) string {
	return fmt.Sprintf("%s|%s|%s|%d|%d/%d|%s|%s/%s", asOf, from, to,
		bindingRevision, policyVersion, policyRevision, inputFingerprint, calRunID, calBundleFP)
}

func historicalMetricsIdentity(r HistoricalMetricsRun) string {
	return historicalMetricsIdentityString(r.AnalysisAsOfDay, r.TargetFromDay, r.TargetToDay,
		r.BindingRevision, r.PolicyVersion, r.PolicyRevision, r.InputFingerprint,
		r.CalibrationRunID, r.CalibrationBundleFingerprint)
}

// ClaimOrCreateHistoricalMetricsRun atomically create-or-merges the user's
// active metrics run: same pinned identity (incl. the consumed calibration
// bundle) → merge; different identity → the active run is superseded
// (input_revision_changed) and a fresh run starts.
func (s *Store) ClaimOrCreateHistoricalMetricsRun(ctx context.Context, spec HistoricalMetricsClaimSpec) (*HistoricalMetricsClaimResult, error) {
	if _, err := uuid.Parse(spec.UserID); err != nil {
		return nil, fmt.Errorf("storage: historical metrics user must be a UUID: %w", err)
	}
	if spec.RunID == "" {
		return nil, fmt.Errorf("storage: historical metrics claim requires a pre-generated run id")
	}
	now := spec.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	res := &HistoricalMetricsClaimResult{}
	txErr := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var active []HistoricalMetricsRun
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ? AND state IN ?", spec.UserID,
				[]string{HistoricalMetricsStatePending, HistoricalMetricsStateRunning}).
			Order("created_at DESC").Find(&active).Error; err != nil {
			return err
		}
		newIdentity := historicalMetricsIdentityString(spec.AnalysisAsOfDay, spec.TargetFromDay, spec.TargetToDay,
			spec.BindingRevision, spec.PolicyVersion, spec.PolicyRevision, spec.InputFingerprint,
			spec.CalibrationRunID, spec.CalibrationBundleFingerprint)
		for i := range active {
			if historicalMetricsIdentity(active[i]) == newIdentity {
				res.Run, res.Created = &active[i], false
				return nil // merge: same pinned revision → same logical run
			}
		}
		for i := range active {
			reason := "input_revision_changed"
			if err := tx.Model(&HistoricalMetricsRun{}).
				Where("run_id = ? AND state IN ?", active[i].RunID,
					[]string{HistoricalMetricsStatePending, HistoricalMetricsStateRunning}).
				Updates(map[string]any{"state": HistoricalMetricsStateSuperseded,
					"supersede_reason": reason, "updated_at": now}).Error; err != nil {
				return err
			}
			id := active[i].RunID
			res.SupersededFrom = &id
		}
		row := HistoricalMetricsRun{
			RunID: spec.RunID, UserID: spec.UserID, Provider: spec.Provider,
			AnalysisAsOfDay: spec.AnalysisAsOfDay,
			TargetFromDay:   spec.TargetFromDay, TargetToDay: spec.TargetToDay,
			BindingRevision: spec.BindingRevision, PolicyVersion: spec.PolicyVersion,
			PolicyRevision: spec.PolicyRevision, InputFingerprint: spec.InputFingerprint,
			CalibrationDigestJSON:        spec.CalibrationDigestJSON,
			CalibrationRunID:             spec.CalibrationRunID,
			CalibrationBundleFingerprint: spec.CalibrationBundleFingerprint,
			State:                        HistoricalMetricsStatePending, Phase: HistoricalMetricsPhaseActivity,
			ActivitiesTotal: spec.ActivitiesTotal, DaysTotal: spec.DaysTotal,
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

// GetHistoricalMetricsRun reads one run row.
func (s *Store) GetHistoricalMetricsRun(ctx context.Context, runID string) (*HistoricalMetricsRun, error) {
	var rows []HistoricalMetricsRun
	if err := s.db.WithContext(ctx).Where("run_id = ?", runID).Limit(1).Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// ListHistoricalMetricsStaged returns the run's staged rows of one kind (all
// kinds when kind is empty), ordered by kind then item key.
func (s *Store) ListHistoricalMetricsStaged(ctx context.Context, runID, kind string) ([]*HistoricalMetricsStaged, error) {
	var rows []*HistoricalMetricsStaged
	q := s.db.WithContext(ctx).Where("run_id = ?", runID)
	if kind != "" {
		q = q.Where("kind = ?", kind)
	}
	if err := q.Order("kind ASC, item_key ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// StageHistoricalMetrics upserts staged artifact rows on (run, kind, item_key).
// Re-staging the same item is idempotent for the deterministic kinds (load/
// zones/daily/L1/skip markers); for the best-so-far kinds (personal_best,
// pb_progress) the newest writer advances the checkpoint state.
func (s *Store) StageHistoricalMetrics(ctx context.Context, rows []*HistoricalMetricsStaged) error {
	if len(rows) == 0 {
		return nil
	}
	now := time.Now().UTC()
	for _, r := range rows {
		r.CreatedAt, r.UpdatedAt = now, now
	}
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "run_id"}, {Name: "kind"}, {Name: "item_key"}},
		DoUpdates: clause.AssignmentColumns([]string{"payload", "updated_at"}),
	}).CreateInBatches(rows, 200).Error
}

// AdvanceHistoricalMetricsCheckpoint records chunk progress: the phase only
// moves FORWARD through the fixed order, chunk seq only grows, and the run
// flips pending → running on its first chunk. No-op for a terminal run.
func (s *Store) AdvanceHistoricalMetricsCheckpoint(ctx context.Context, runID, phase string, chunkSeq int, jobID string) error {
	order := map[string]int{
		HistoricalMetricsPhaseActivity: 1,
		HistoricalMetricsPhaseDaily:    2,
		HistoricalMetricsPhasePB:       3,
		HistoricalMetricsPhaseL1:       4,
		HistoricalMetricsPhasePublish:  5,
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var rows []HistoricalMetricsRun
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("run_id = ?", runID).Limit(1).Find(&rows).Error; err != nil {
			return err
		}
		if len(rows) == 0 {
			return fmt.Errorf("storage: historical metrics run %s not found", runID)
		}
		run := rows[0]
		if run.Terminal() {
			return nil // superseded between fence and here: drop the write
		}
		updates := map[string]any{"updated_at": time.Now().UTC()}
		if run.State == HistoricalMetricsStatePending {
			updates["state"] = HistoricalMetricsStateRunning
		}
		if order[phase] > order[run.Phase] {
			updates["phase"] = phase
		}
		if chunkSeq > run.ChunkSeq {
			updates["chunk_seq"] = chunkSeq
		}
		if jobID != "" {
			updates["last_job_id"] = jobID
		}
		return tx.Model(&HistoricalMetricsRun{}).Where("run_id = ?", runID).Updates(updates).Error
	})
}

// HistoricalMetricsStagedCounts aggregates the staged ledger's outcome counts
// (folded by PublishHistoricalMetricsRun over exactly what it promotes).
type HistoricalMetricsStagedCounts struct {
	ActivityLoad int64
	ActivitySkip int64
	DailyLoad    int64
	PersonalBest int64
	ActivityL1   int64
}

// HistoricalMetricsOutputFingerprint freezes the run's whole staged ledger
// into one fingerprint: sorted "kind|key|payload" triples hashed together —
// the set identity of exactly what the publication promoted.
func HistoricalMetricsOutputFingerprint(rows []*HistoricalMetricsStaged) string {
	sorted := make([]*HistoricalMetricsStaged, len(rows))
	copy(sorted, rows)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Kind != sorted[j].Kind {
			return sorted[i].Kind < sorted[j].Kind
		}
		return sorted[i].ItemKey < sorted[j].ItemKey
	})
	h := sha256.New()
	h.Write([]byte("metrics-bundle-v1"))
	for _, r := range sorted {
		fmt.Fprintf(h, "|%s/%s/%s", r.Kind, r.ItemKey, r.Payload)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// HistoricalCalibrationDigest is the aggregate change marker of the user's
// PUBLISHED calibration snapshots over the window the metrics run reads:
// row count, newest computed_at and a CRC sum over source_json (which carries
// each row's persisted fingerprint, ADR 0045). It closes the vintage hole: a
// later or concurrent calibration writer rewriting a window day changes the
// digest even when no raw input row moved, so the metrics run's fence
// supersedes instead of silently mixing baselines (ADR 0047 revision
// isolation).
type HistoricalCalibrationDigest struct {
	RowCount     int64
	MaxComputed  *time.Time
	SourceCRCSum int64
}

// HistoricalCalibrationDigest folds the window's published snapshot rows.
// SameAs reports value equality (the MaxComputed pointer must not be
// compared by identity).
func (d HistoricalCalibrationDigest) SameAs(o HistoricalCalibrationDigest) bool {
	if d.RowCount != o.RowCount || d.SourceCRCSum != o.SourceCRCSum {
		return false
	}
	switch {
	case d.MaxComputed == nil && o.MaxComputed == nil:
		return true
	case d.MaxComputed == nil || o.MaxComputed == nil:
		return false
	default:
		return d.MaxComputed.Equal(*o.MaxComputed)
	}
}

func (s *Store) HistoricalCalibrationDigest(ctx context.Context, userID, fromDay, toDay string) (HistoricalCalibrationDigest, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return HistoricalCalibrationDigest{}, err
	}
	var row struct {
		N     int64
		MaxUp *time.Time
		Crc   *int64
	}
	err = s.db.WithContext(ctx).Table("running_calibration_snapshot").
		Select("COUNT(*) AS n, MAX(computed_at) AS max_up, COALESCE(SUM(CRC32(source_json)), 0) AS crc").
		Where("user_id = ? AND algorithm_version = ?", uid, calibration.ModelVersion).
		Where("as_of_date >= ? AND as_of_date <= ?", fromDay, toDay).
		Scan(&row).Error
	if err != nil {
		return HistoricalCalibrationDigest{}, fmt.Errorf("storage: historical calibration digest: %w", err)
	}
	out := HistoricalCalibrationDigest{RowCount: row.N, MaxComputed: row.MaxUp}
	if row.Crc != nil {
		out.SourceCRCSum = *row.Crc
	}
	return out, nil
}

// HistoricalMetricsFingerprint pins one metrics run's input revision: the
// window, binding, policy, the full-history data digest, the published
// calibration-window digest, and the consumed frozen calibration bundle.
func HistoricalMetricsFingerprint(asOf, from, to string, bindingRevision int64, policy RunningCalibrationPolicy, d OnboardingAnalysisDigest, cal HistoricalCalibrationDigest, calRunID, calBundleFP string) string {
	maxUp := "-"
	if cal.MaxComputed != nil {
		maxUp = cal.MaxComputed.UTC().Format(time.RFC3339Nano)
	}
	payload := HistoricalRecomputeFingerprint(asOf, from, to, bindingRevision, policy, d) +
		fmt.Sprintf("|calsnap=%d/%s/%d", cal.RowCount, maxUp, cal.SourceCRCSum) +
		"|bundle=" + calRunID + "/" + calBundleFP
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

// PublishHistoricalMetricsRun promotes the run's whole staged ledger into the
// production derived tables in ONE transaction: per-activity load rows and
// daily PMC rows upsert, per-activity zone rows replace per activity, the PB
// set replaces wholesale (it is the complete new set), and L1 rows upsert.
// Activities the run skipped (no day bundle) keep their existing rows — only
// staged keys are touched. Inside the transaction the cheap invariants are
// re-verified (run still active, pinned binding revision, pinned policy
// revision, calibration run still terminal with the pinned bundle
// fingerprint); the data digest fence runs immediately before, mirroring the
// T07 calibration run's publish gate. Returns the promoted row counts.
func (s *Store) PublishHistoricalMetricsRun(ctx context.Context, runID string) (HistoricalMetricsStagedCounts, error) {
	var counts HistoricalMetricsStagedCounts
	staged, err := s.ListHistoricalMetricsStaged(ctx, runID, "")
	if err != nil {
		return counts, err
	}
	if len(staged) == 0 {
		return counts, fmt.Errorf("storage: historical metrics run %s has nothing staged to publish", runID)
	}
	var loads []ActivityTrainingLoad
	var daily []DailyTrainingLoad
	var pbs []PersonalBest
	var l1 []ActivityAbility
	skips := int64(0)
	zonesByLabel := map[string][]ActivityZone{}
	for _, r := range staged {
		switch r.Kind {
		case HistoricalMetricsKindActivitySkip:
			skips++
		case HistoricalMetricsKindActivityLoad:
			var row ActivityTrainingLoad
			if err := json.Unmarshal([]byte(r.Payload), &row); err != nil {
				return counts, fmt.Errorf("storage: staged activity_load %s: %w", r.ItemKey, err)
			}
			loads = append(loads, row)
		case HistoricalMetricsKindActivityZones:
			var rows []ActivityZone
			if err := json.Unmarshal([]byte(r.Payload), &rows); err != nil {
				return counts, fmt.Errorf("storage: staged activity_zones %s: %w", r.ItemKey, err)
			}
			zonesByLabel[r.ItemKey] = rows
		case HistoricalMetricsKindDailyLoad:
			var row DailyTrainingLoad
			if err := json.Unmarshal([]byte(r.Payload), &row); err != nil {
				return counts, fmt.Errorf("storage: staged daily_load %s: %w", r.ItemKey, err)
			}
			daily = append(daily, row)
		case HistoricalMetricsKindPersonalBest:
			var row PersonalBest
			if err := json.Unmarshal([]byte(r.Payload), &row); err != nil {
				return counts, fmt.Errorf("storage: staged personal_best %s: %w", r.ItemKey, err)
			}
			pbs = append(pbs, row)
		case HistoricalMetricsKindActivityL1:
			var row ActivityAbility
			if err := json.Unmarshal([]byte(r.Payload), &row); err != nil {
				return counts, fmt.Errorf("storage: staged activity_l1 %s: %w", r.ItemKey, err)
			}
			l1 = append(l1, row)
		}
	}
	counts = HistoricalMetricsStagedCounts{
		ActivityLoad: int64(len(loads)), ActivitySkip: skips,
		DailyLoad:    int64(len(daily)),
		PersonalBest: int64(len(pbs)), ActivityL1: int64(len(l1)),
	}
	now := time.Now().UTC()
	txErr := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var runs []HistoricalMetricsRun
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("run_id = ?", runID).Limit(1).Find(&runs).Error; err != nil {
			return err
		}
		if len(runs) == 0 {
			return fmt.Errorf("storage: historical metrics run %s not found", runID)
		}
		run := runs[0]
		if run.Terminal() {
			return fmt.Errorf("storage: historical metrics run %s is %s, refusing to publish", runID, run.State)
		}
		// Fence (cheap invariants inside the tx): pinned revisions still hold.
		var binding WatchBindingState
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ?", run.UserID).First(&binding).Error; err != nil {
			return err
		}
		if binding.Revision != run.BindingRevision {
			return fmt.Errorf("storage: historical metrics publish fence: binding_revision_changed")
		}
		policy, err := readCalibrationPolicy(tx)
		if err != nil {
			return err
		}
		if policy.ActiveVersion != run.PolicyVersion || policy.Revision != run.PolicyRevision {
			return fmt.Errorf("storage: historical metrics publish fence: policy_revision_changed")
		}
		var calRun HistoricalRecomputeRun
		if err := tx.Where("run_id = ?", run.CalibrationRunID).Limit(1).Find(&calRun).Error; err != nil {
			return err
		}
		if calRun.RunID == "" ||
			(calRun.State != HistoricalRecomputeStateCompleted && calRun.State != HistoricalRecomputeStateCompletedWithGaps) ||
			calRun.BundleFingerprint == nil || *calRun.BundleFingerprint != run.CalibrationBundleFingerprint {
			return fmt.Errorf("storage: historical metrics publish fence: calibration_bundle_changed")
		}

		// Promote, in the ADR 0045 order: activity load → zones → daily PMC
		// → PB → L1. Every write is idempotent (upsert / per-key replace /
		// whole-set replace), so a retry after a crash mid-publication re-runs
		// cleanly.
		if len(loads) > 0 {
			if err := tx.Clauses(clause.OnConflict{UpdateAll: true}).
				CreateInBatches(&loads, 200).Error; err != nil {
				return err
			}
		}
		for label, rows := range zonesByLabel {
			if err := tx.Where("user_id = ? AND label_id = ?", run.UserID, label).
				Delete(&ActivityZone{}).Error; err != nil {
				return err
			}
			if len(rows) > 0 {
				if err := tx.CreateInBatches(&rows, 100).Error; err != nil {
					return err
				}
			}
		}
		if len(daily) > 0 {
			if err := tx.Clauses(clause.OnConflict{UpdateAll: true}).
				CreateInBatches(&daily, 200).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("user_id = ?", run.UserID).Delete(&PersonalBest{}).Error; err != nil {
			return err
		}
		if len(pbs) > 0 {
			if err := tx.CreateInBatches(&pbs, 100).Error; err != nil {
				return err
			}
		}
		if len(l1) > 0 {
			if err := tx.Clauses(clause.OnConflict{UpdateAll: true}).
				CreateInBatches(&l1, 200).Error; err != nil {
				return err
			}
		}
		return tx.Model(&HistoricalMetricsRun{}).Where("run_id = ?", runID).
			Updates(map[string]any{"published_at": now, "updated_at": now}).Error
	})
	if txErr != nil {
		return counts, txErr
	}
	return counts, nil
}

// FinalizeHistoricalMetricsRun publishes the run's terminal outcome from the
// running/pending state with the frozen output fingerprint and staged counts.
// Guarded — a superseded run cannot finalize.
func (s *Store) FinalizeHistoricalMetricsRun(ctx context.Context, runID, state, outputFingerprint string, counts HistoricalMetricsStagedCounts, totals HistoricalMetricsTotals) error {
	if state != HistoricalMetricsStateCompleted && state != HistoricalMetricsStateCompletedWithGaps {
		return fmt.Errorf("storage: invalid historical metrics finalize state %q", state)
	}
	res := s.db.WithContext(ctx).Model(&HistoricalMetricsRun{}).
		Where("run_id = ? AND state IN ?", runID,
			[]string{HistoricalMetricsStatePending, HistoricalMetricsStateRunning}).
		Updates(map[string]any{
			"state":              state,
			"output_fingerprint": outputFingerprint,
			"activities_total":   totals.ActivitiesTotal,
			"activities_staged":  int(counts.ActivityLoad),
			"activities_skipped": int(counts.ActivitySkip),
			"days_total":         totals.DaysTotal,
			"days_staged":        int(counts.DailyLoad),
			"personal_bests":     int(counts.PersonalBest),
			"l1_written":         int(counts.ActivityL1),
			"l1_skipped":         totals.L1Skipped,
			"l1_unavailable":     totals.L1Unavailable,
			"updated_at":         time.Now().UTC(),
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("storage: historical metrics run %s not finalizable (not active)", runID)
	}
	return nil
}

// HistoricalMetricsTotals carries the executor-computed totals (window sizes
// and L1 skip outcomes) that are not derivable from the staged ledger alone.
type HistoricalMetricsTotals struct {
	ActivitiesTotal int
	DaysTotal       int
	L1Skipped       int
	L1Unavailable   int
}

// SupersedeHistoricalMetricsRun marks an active run superseded with a reason.
// Idempotent; only active states transition.
func (s *Store) SupersedeHistoricalMetricsRun(ctx context.Context, runID, reason string) error {
	return s.db.WithContext(ctx).Model(&HistoricalMetricsRun{}).
		Where("run_id = ? AND state IN ?", runID,
			[]string{HistoricalMetricsStatePending, HistoricalMetricsStateRunning}).
		Updates(map[string]any{"state": HistoricalMetricsStateSuperseded,
			"supersede_reason": reason, "updated_at": time.Now().UTC()}).Error
}

// FailHistoricalMetricsRun records a terminal failure.
func (s *Store) FailHistoricalMetricsRun(ctx context.Context, runID, msg string) error {
	return s.db.WithContext(ctx).Model(&HistoricalMetricsRun{}).
		Where("run_id = ? AND state IN ?", runID,
			[]string{HistoricalMetricsStatePending, HistoricalMetricsStateRunning}).
		Updates(map[string]any{"state": HistoricalMetricsStateFailed,
			"last_error": msg, "updated_at": time.Now().UTC()}).Error
}
