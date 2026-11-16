// onboardingsync.go is the first-sync session data layer (devops#1006, epic
// devops#1004 T02): the per-binding onboarding sync session, the reliable
// stage-dispatch records, the range work items and the per-stage coverage rows.
//
// Session: onboarding_sync_sessions holds at most one non-superseded session
// per (user, binding revision). The binding revision comes from
// watch_binding_state (devops#1005) read under the claim transaction's lock, so
// the create-or-claim is atomic against both concurrent clients and rebinds: a
// repeat POST for the same binding claims the same session; a rebind (revision
// bump) supersedes the old session rows and starts a fresh one — an old
// session's late writes can never leak into the new binding's identity.
//
// Dispatch records: onboarding_sync_dispatches is the durable intent to run one
// stage. The row is written status=pending in the SAME transaction as the
// session, so shell_ready (session + reliable dispatch record persisted) holds
// from the commit onward even if the process crashes before the job pointer is
// published. The reconcile sweep moves pending → dispatched by enqueuing the
// job under the row's stable idempotency key (dedup survives crashes at the
// create/enqueue boundary) and records the terminal job outcome (the completion
// boundary).
//
// Work items + coverage: onboarding_sync_work_items carries the server-chosen
// range items (recent activities window / recent health window) with their
// complete-fetch credentials — a done item's credential is what an explicit
// retry reuses instead of re-fetching. onboarding_sync_stage_coverage keeps
// target / scanned / observed ranges and gaps separate per stage: target is
// what the server aims to cover, scanned what has been walked, observed what
// data actually exists; completed_with_gaps never equals full coverage.
package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	gomysql "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Onboarding session lifecycle states. waiting_legacy means an old full
// `onboarding` pipeline run was already in flight when the session was claimed
// — the session waits and reconciles against it instead of starting a
// duplicate pipeline (devops#1006 AC6).
const (
	OnboardingSyncStateWaitingLegacy = "waiting_legacy"
	OnboardingSyncStateDispatching   = "dispatching"
	OnboardingSyncStateRunning       = "running"
	OnboardingSyncStateCompleted     = "completed"
	// OnboardingSyncStateCompletedWithGaps is terminal like completed, but at
	// least one stage recorded permanent gaps — never reported as full
	// coverage (completed_with_gaps ≠ 完整覆盖).
	OnboardingSyncStateCompletedWithGaps = "completed_with_gaps"
	OnboardingSyncStateFailed            = "failed"
	// OnboardingSyncStateSuperseded marks a session isolated by a rebind.
	OnboardingSyncStateSuperseded = "superseded"
)

// Stage names. T02 owns the recent raw-data stage; later tickets (T03/T04
// executors, T05 analysis, T06 historical) add stages on the same tables.
const OnboardingSyncStageRecentRaw = "recent_raw"

// Dispatch record states.
const (
	OnboardingSyncDispatchPending    = "pending"
	OnboardingSyncDispatchDispatched = "dispatched"
	OnboardingSyncDispatchDone       = "done"
	OnboardingSyncDispatchFailed     = "failed"
)

// Work item states. pending = not yet fetched; done = complete fetch, the
// credential column holds the complete-fetch proof a retry reuses; gap =
// permanently unobtainable (recorded, never faked as success); failed =
// retryable error.
const (
	OnboardingSyncItemPending = "pending"
	OnboardingSyncItemDone    = "done"
	OnboardingSyncItemGap     = "gap"
	OnboardingSyncItemFailed  = "failed"
)

// Stage coverage states.
const (
	OnboardingSyncCoveragePending           = "pending"
	OnboardingSyncCoverageRunning           = "running"
	OnboardingSyncCoverageCompleted         = "completed"
	OnboardingSyncCoverageCompletedWithGaps = "completed_with_gaps"
	OnboardingSyncCoverageFailed            = "failed"
)

// OnboardingSyncSession is one first-sync session for a user's current binding.
type OnboardingSyncSession struct {
	SessionID       string `gorm:"column:session_id;type:char(36);primaryKey"`
	UserID          string `gorm:"column:user_id;type:char(36);not null;index"`
	Provider        string `gorm:"column:provider;type:varchar(32);not null"`
	BindingRevision int64  `gorm:"column:binding_revision;type:bigint;not null"`
	// AnchorDay is the fixed Shanghai natural day the session's windows are
	// computed from (YYYY-MM-DD, Shanghai calendar day of AnchorAtUTC).
	AnchorDay   string    `gorm:"column:anchor_day;type:char(10);not null"`
	AnchorAtUTC time.Time `gorm:"column:anchor_at_utc;type:datetime(6);not null"`
	State       string    `gorm:"column:state;type:varchar(32);not null"`
	// ShellReady records that the session AND its reliable dispatch records
	// were durably persisted — the only condition under which a client may be
	// told the shell is ready (进入首页). Set in the claim transaction.
	ShellReady bool `gorm:"column:shell_ready;not null;default:false"`
	// LegacyRunID links an in-flight old full `onboarding` pipeline run the
	// session waits on and reconciles against (nullable).
	LegacyRunID *string   `gorm:"column:legacy_run_id;type:varchar(64)"`
	RetryCount  int       `gorm:"column:retry_count;type:int;not null;default:0"`
	LastError   *string   `gorm:"column:last_error;type:text"`
	CreatedAt   time.Time `gorm:"column:created_at;type:datetime(6);not null"`
	UpdatedAt   time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (OnboardingSyncSession) TableName() string { return "onboarding_sync_sessions" }

// Terminal reports whether the session's state is final. A superseded session
// is terminal too — rebind-isolated rows never resume.
func (s OnboardingSyncSession) Terminal() bool {
	switch s.State {
	case OnboardingSyncStateCompleted, OnboardingSyncStateCompletedWithGaps,
		OnboardingSyncStateFailed, OnboardingSyncStateSuperseded:
		return true
	}
	return false
}

// OnboardingSyncDispatch is the durable intent to run one stage of a session.
// One row per (session, stage); IdempotencyKey carries the generation's stable
// key (session + stage + range + binding revision + retry generation) so the
// crash-recovery re-enqueue dedupes against the original job.
type OnboardingSyncDispatch struct {
	ID             int64     `gorm:"column:id;primaryKey"`
	SessionID      string    `gorm:"column:session_id;type:char(36);not null;uniqueIndex:idx_onbsync_dispatch_stage"`
	Stage          string    `gorm:"column:stage;type:varchar(32);not null;uniqueIndex:idx_onbsync_dispatch_stage"`
	IdempotencyKey string    `gorm:"column:idempotency_key;type:varchar(191);not null"`
	JobID          *string   `gorm:"column:job_id;type:varchar(64)"`
	Status         string    `gorm:"column:status;type:varchar(16);not null"`
	Attempts       int       `gorm:"column:attempts;type:int;not null;default:0"`
	CreatedAt      time.Time `gorm:"column:created_at;type:datetime(6);not null"`
	UpdatedAt      time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (OnboardingSyncDispatch) TableName() string { return "onboarding_sync_dispatches" }

// OnboardingSyncWorkItem is one server-chosen range item of a stage.
type OnboardingSyncWorkItem struct {
	ID        int64  `gorm:"column:id;primaryKey"`
	SessionID string `gorm:"column:session_id;type:char(36);not null;index"`
	Stage     string `gorm:"column:stage;type:varchar(32);not null"`
	// Kind selects the data channel: activities | health | dashboard.
	Kind      string `gorm:"column:kind;type:varchar(16);not null"`
	RangeFrom string `gorm:"column:range_from;type:char(10);not null"`
	RangeTo   string `gorm:"column:range_to;type:char(10);not null"`
	Status    string `gorm:"column:status;type:varchar(16);not null"`
	// FetchCredential is the complete-fetch proof, written ONLY after the
	// item's full fetch succeeded — the record an explicit retry reuses.
	FetchCredential *string   `gorm:"column:fetch_credential;type:varchar(191)"`
	Error           *string   `gorm:"column:error;type:text"`
	CreatedAt       time.Time `gorm:"column:created_at;type:datetime(6);not null"`
	UpdatedAt       time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (OnboardingSyncWorkItem) TableName() string { return "onboarding_sync_work_items" }

// OnboardingSyncStageCoverage separates, per stage, the target window (what the
// server aims to cover), the scanned window (what has been walked) and the
// observed window (what data actually exists) plus recorded gaps. No column is
// inferred from another: a scanned range with no observed data is a gap, not
// coverage.
type OnboardingSyncStageCoverage struct {
	ID        int64  `gorm:"column:id;primaryKey"`
	SessionID string `gorm:"column:session_id;type:char(36);not null;uniqueIndex:idx_onbsync_coverage_stage"`
	Stage     string `gorm:"column:stage;type:varchar(32);not null;uniqueIndex:idx_onbsync_coverage_stage"`
	Status    string `gorm:"column:status;type:varchar(32);not null"`
	// Target / scanned / observed windows, Shanghai natural days
	// (YYYY-MM-DD). observed_* stay NULL until an executor reports them.
	TargetFrom   string  `gorm:"column:target_from;type:char(10);not null"`
	TargetTo     string  `gorm:"column:target_to;type:char(10);not null"`
	ScannedFrom  *string `gorm:"column:scanned_from;type:char(10)"`
	ScannedTo    *string `gorm:"column:scanned_to;type:char(10)"`
	ObservedFrom *string `gorm:"column:observed_from;type:char(10)"`
	ObservedTo   *string `gorm:"column:observed_to;type:char(10)"`
	// GapsJSON lists recorded gaps as [{"from":..,"to":..,"reason":..}].
	GapsJSON  *string   `gorm:"column:gaps_json;type:text"`
	JobID     *string   `gorm:"column:job_id;type:varchar(64)"`
	LastError *string   `gorm:"column:last_error;type:text"`
	CreatedAt time.Time `gorm:"column:created_at;type:datetime(6);not null"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (OnboardingSyncStageCoverage) TableName() string { return "onboarding_sync_stage_coverage" }

// onboardingSyncModels is the migration set for AutoMigrateOnboardingSync.
func onboardingSyncModels() []any {
	return []any{
		&OnboardingSyncSession{}, &OnboardingSyncDispatch{},
		&OnboardingSyncWorkItem{}, &OnboardingSyncStageCoverage{},
	}
}

// AutoMigrateOnboardingSync creates/updates the first-sync session tables
// (devops#1006). Called by both `stride api` and `stride worker` so either
// process can run against a fresh database.
func (s *Store) AutoMigrateOnboardingSync(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(onboardingSyncModels()...); err != nil {
		return fmt.Errorf("storage: automigrate onboarding sync: %w", err)
	}
	return nil
}

// OnboardingSyncWorkItemSpec describes one range work item to create inside the
// claim transaction. RangeFrom/RangeTo are inclusive Shanghai natural days.
type OnboardingSyncWorkItemSpec struct {
	Kind      string
	RangeFrom string
	RangeTo   string
}

// OnboardingSyncClaimSpec parameterizes the atomic create-or-claim.
type OnboardingSyncClaimSpec struct {
	UserID   string
	Provider string
	// SessionID optionally pre-generates the session id — the idempotency key
	// embeds it, so the caller must know it before the transaction. Empty
	// means the claim generates one.
	SessionID string
	// AnchorDay / AnchorAtUTC pin the fixed scan anchor (Shanghai calendar).
	AnchorDay   string
	AnchorAtUTC time.Time
	// StageNames lists the stages to create dispatch + coverage rows for, in
	// order. T02 passes exactly [recent_raw].
	StageNames []string
	// WorkItems maps stage → range items (created with the session).
	WorkItems map[string][]OnboardingSyncWorkItemSpec
	// IdempotencyKey builds the stage's stable job key from the values the
	// spec requires it to contain: session, stage, ranges, input revision.
	IdempotencyKey func(stage, sessionID string, bindingRevision int64) string
}

// OnboardingSyncClaimResult reports what the transaction did. Claimed=true
// means an existing session for the same binding was returned (repeat POST);
// Created=true means a new session row was written.
type OnboardingSyncClaimResult struct {
	Session *OnboardingSyncSession
	Claimed bool
	Created bool
}

// ErrOnboardingSyncStaleBinding reports that the claim raced a rebind: the
// binding revision changed between the caller's pre-check and the transaction.
// The caller re-resolves the provider and retries the claim.
var ErrOnboardingSyncStaleBinding = errors.New("storage: onboarding sync claim raced a rebind")

// ClaimOrCreateOnboardingSyncSession atomically creates or claims the user's
// first-sync session for their CURRENT binding revision:
//
//   - lock the binding row; a missing row is created at revision 1 (first-seen
//     legacy user whose bind predates devops#1005);
//   - a live or terminal session already bound to the current revision is
//     claimed as-is (multi-client / repeat POST → the same session);
//   - sessions for older revisions are superseded in the same transaction
//     (rebind isolation);
//   - a new session is written together with its stage dispatch records
//     (status=pending — the reliable dispatch intent), work items and coverage
//     rows, and ShellReady=true. Everything is durable at commit, so a crash
//     right after the transaction loses nothing the sweep cannot recover.
//
// Concurrent first-seen claims (multi-client POST on a brand-new binding) race
// on the binding-row insert and can trip InnoDB's gap-lock deadlock detector;
// the whole transaction is retried on MySQL 1213/1205, which is safe — every
// step is guarded or unique-keyed, so a retried loser either finds the winner's
// session and claims it or deadlocks again within the bounded attempts.
func (s *Store) ClaimOrCreateOnboardingSyncSession(ctx context.Context, spec OnboardingSyncClaimSpec) (*OnboardingSyncClaimResult, error) {
	var out *OnboardingSyncClaimResult
	err := withDeadlockRetry(func() error {
		res, err := s.claimOrCreateOnboardingSyncSession(ctx, spec)
		out = res
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// withDeadlockRetry re-runs fn on MySQL deadlock (1213) and lock-wait-timeout
// (1205) errors, up to three extra attempts with a short backoff. Both are
// transient serialization losses the caller's transaction can simply re-run.
func withDeadlockRetry(fn func() error) error {
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		err = fn()
		if !isRetryableLockError(err) {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 10 * time.Millisecond)
	}
	return err
}

func isRetryableLockError(err error) bool {
	var myerr *gomysql.MySQLError
	if errors.As(err, &myerr) {
		return myerr.Number == 1213 || myerr.Number == 1205
	}
	return false
}

func (s *Store) claimOrCreateOnboardingSyncSession(ctx context.Context, spec OnboardingSyncClaimSpec) (*OnboardingSyncClaimResult, error) {
	uid, err := canonicalUserID(spec.UserID)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	var out OnboardingSyncClaimResult
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Binding revision under lock — the identity the session binds to.
		var binding WatchBindingState
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ?", uid).First(&binding).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			p := spec.Provider
			binding = WatchBindingState{UserID: uid, Provider: &p, Revision: 1, UpdatedAt: now}
			if err := tx.Create(&binding).Error; err != nil {
				return fmt.Errorf("storage: claim: create binding: %w", err)
			}
		} else if err != nil {
			return fmt.Errorf("storage: claim: read binding: %w", err)
		}
		if binding.Provider == nil || *binding.Provider != spec.Provider {
			// The credential pre-check saw a provider the binding row does not
			// carry — a rebind raced us. Caller re-resolves and retries.
			return ErrOnboardingSyncStaleBinding
		}
		rev := binding.Revision

		// Supersede any session bound to an older revision (rebind isolation).
		if err := tx.Model(&OnboardingSyncSession{}).
			Where("user_id = ? AND binding_revision < ? AND state <> ?", uid, rev, OnboardingSyncStateSuperseded).
			Updates(map[string]any{"state": OnboardingSyncStateSuperseded, "updated_at": now}).Error; err != nil {
			return fmt.Errorf("storage: claim: supersede stale sessions: %w", err)
		}

		// Claim an existing session for the current revision, if any.
		var existing OnboardingSyncSession
		err = tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ? AND binding_revision = ?", uid, rev).
			Order("created_at DESC").First(&existing).Error
		switch {
		case err == nil:
			out.Session = &existing
			out.Claimed = true
			return nil
		case !errors.Is(err, gorm.ErrRecordNotFound):
			return fmt.Errorf("storage: claim: read existing session: %w", err)
		}

		// Create the session + dispatch intents + work items + coverage rows.
		sess := OnboardingSyncSession{
			UserID: uid, Provider: spec.Provider,
			BindingRevision: rev, AnchorDay: spec.AnchorDay, AnchorAtUTC: spec.AnchorAtUTC,
			State: OnboardingSyncStateDispatching, ShellReady: true,
			CreatedAt: now, UpdatedAt: now,
		}
		if spec.SessionID != "" {
			if _, err := uuid.Parse(spec.SessionID); err != nil {
				return fmt.Errorf("storage: claim: bad session id: %w", err)
			}
			sess.SessionID = spec.SessionID
		} else {
			sess.SessionID = uuid.NewString()
		}
		if err := tx.Create(&sess).Error; err != nil {
			return fmt.Errorf("storage: claim: create session: %w", err)
		}
		for _, stage := range spec.StageNames {
			key := ""
			if spec.IdempotencyKey != nil {
				key = spec.IdempotencyKey(stage, sess.SessionID, rev)
			}
			if key == "" {
				return fmt.Errorf("storage: claim: stage %q has no idempotency key", stage)
			}
			disp := OnboardingSyncDispatch{
				SessionID: sess.SessionID, Stage: stage,
				IdempotencyKey: key,
				Status:         OnboardingSyncDispatchPending, CreatedAt: now, UpdatedAt: now,
			}
			if err := tx.Create(&disp).Error; err != nil {
				return fmt.Errorf("storage: claim: create dispatch: %w", err)
			}
			cov := OnboardingSyncStageCoverage{
				SessionID: sess.SessionID, Stage: stage,
				Status: OnboardingSyncCoveragePending, CreatedAt: now, UpdatedAt: now,
			}
			for _, item := range spec.WorkItems[stage] {
				row := OnboardingSyncWorkItem{
					SessionID: sess.SessionID, Stage: stage, Kind: item.Kind,
					RangeFrom: item.RangeFrom, RangeTo: item.RangeTo,
					Status: OnboardingSyncItemPending, CreatedAt: now, UpdatedAt: now,
				}
				if err := tx.Create(&row).Error; err != nil {
					return fmt.Errorf("storage: claim: create work item: %w", err)
				}
				// The stage's target window spans its items' union; items are
				// created ordered, so first from / last to wins.
				if cov.TargetFrom == "" || item.RangeFrom < cov.TargetFrom {
					cov.TargetFrom = item.RangeFrom
				}
				if item.RangeTo > cov.TargetTo {
					cov.TargetTo = item.RangeTo
				}
			}
			if err := tx.Create(&cov).Error; err != nil {
				return fmt.Errorf("storage: claim: create coverage: %w", err)
			}
		}
		out.Session = &sess
		out.Created = true
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// GetOnboardingSyncSession returns the user's current (non-superseded) session,
// newest first, or nil when the user has none.
func (s *Store) GetOnboardingSyncSession(ctx context.Context, userID string) (*OnboardingSyncSession, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var sess OnboardingSyncSession
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND state <> ?", uid, OnboardingSyncStateSuperseded).
		Order("created_at DESC").First(&sess).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("storage: get onboarding sync session: %w", err)
	}
	return &sess, nil
}

// GetOnboardingSyncSessionByID returns the session row by id, or nil.
func (s *Store) GetOnboardingSyncSessionByID(ctx context.Context, sessionID string) (*OnboardingSyncSession, error) {
	var sess OnboardingSyncSession
	err := s.db.WithContext(ctx).Where("session_id = ?", sessionID).First(&sess).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("storage: get onboarding sync session by id: %w", err)
	}
	return &sess, nil
}

// SetOnboardingSyncSessionState CAS-updates the session's state from any of
// the expected states. errMsg (nullable) replaces last_error; a failure
// transition passes the reason, others pass nil to clear it.
func (s *Store) SetOnboardingSyncSessionState(ctx context.Context, sessionID, to string, errMsg *string, from ...string) error {
	q := s.db.WithContext(ctx).Model(&OnboardingSyncSession{}).Where("session_id = ?", sessionID)
	if len(from) > 0 {
		q = q.Where("state IN ?", from)
	}
	res := q.Updates(map[string]any{
		"state": to, "last_error": errMsg, "updated_at": time.Now().UTC(),
	})
	if res.Error != nil {
		return fmt.Errorf("storage: set onboarding sync session state: %w", res.Error)
	}
	return nil
}

// TouchOnboardingSyncSession bumps updated_at without changing state, so the
// finalize scan's bounded oldest-first window rotates (a session still
// mid-flight cannot starve younger sessions out of the window).
func (s *Store) TouchOnboardingSyncSession(ctx context.Context, sessionID string) error {
	res := s.db.WithContext(ctx).Model(&OnboardingSyncSession{}).
		Where("session_id = ?", sessionID).Update("updated_at", time.Now().UTC())
	if res.Error != nil {
		return fmt.Errorf("storage: touch onboarding sync session: %w", res.Error)
	}
	return nil
}

// RecordOnboardingSyncLegacyRun links an in-flight legacy full run to the
// session and moves it to waiting_legacy (idempotent).
func (s *Store) RecordOnboardingSyncLegacyRun(ctx context.Context, sessionID, runID string) error {
	res := s.db.WithContext(ctx).Model(&OnboardingSyncSession{}).
		Where("session_id = ?", sessionID).
		Updates(map[string]any{
			"legacy_run_id": runID, "state": OnboardingSyncStateWaitingLegacy,
			"updated_at": time.Now().UTC(),
		})
	if res.Error != nil {
		return fmt.Errorf("storage: record onboarding sync legacy run: %w", res.Error)
	}
	return nil
}

// ListOnboardingSyncDispatches returns the session's dispatch rows.
func (s *Store) ListOnboardingSyncDispatches(ctx context.Context, sessionID string) ([]*OnboardingSyncDispatch, error) {
	var rows []*OnboardingSyncDispatch
	err := s.db.WithContext(ctx).Where("session_id = ?", sessionID).Order("stage ASC").Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list onboarding sync dispatches: %w", err)
	}
	return rows, nil
}

// ListPendingOnboardingSyncDispatches returns dispatch rows still pending
// whose session is not superseded — the crash-recovery re-enqueue set. Only
// rows older than grace are returned so an in-flight create's enqueue is never
// raced by the sweep.
func (s *Store) ListPendingOnboardingSyncDispatches(ctx context.Context, grace time.Duration, limit int) ([]*OnboardingSyncDispatch, error) {
	cutoff := time.Now().UTC().Add(-grace)
	var rows []*OnboardingSyncDispatch
	err := s.db.WithContext(ctx).
		Joins("JOIN onboarding_sync_sessions s ON s.session_id = onboarding_sync_dispatches.session_id").
		Where("onboarding_sync_dispatches.status = ? AND s.state <> ? AND onboarding_sync_dispatches.updated_at < ?",
			OnboardingSyncDispatchPending, OnboardingSyncStateSuperseded, cutoff).
		Order("onboarding_sync_dispatches.updated_at ASC").Limit(limit).Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list pending onboarding sync dispatches: %w", err)
	}
	return rows, nil
}

// ListDispatchedOnboardingSyncDispatches returns non-terminal dispatched rows
// for non-superseded sessions — the completion-boundary observation set.
func (s *Store) ListDispatchedOnboardingSyncDispatches(ctx context.Context, limit int) ([]*OnboardingSyncDispatch, error) {
	var rows []*OnboardingSyncDispatch
	err := s.db.WithContext(ctx).
		Joins("JOIN onboarding_sync_sessions s ON s.session_id = onboarding_sync_dispatches.session_id").
		Where("onboarding_sync_dispatches.status = ? AND s.state <> ?",
			OnboardingSyncDispatchDispatched, OnboardingSyncStateSuperseded).
		Order("onboarding_sync_dispatches.updated_at ASC").Limit(limit).Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list dispatched onboarding sync dispatches: %w", err)
	}
	return rows, nil
}

// MarkOnboardingSyncDispatchDispatched moves a dispatch to dispatched with its
// job id, guarded on still-pending (a concurrent sweep or retry loses the race
// silently — the winner's write stands).
func (s *Store) MarkOnboardingSyncDispatchDispatched(ctx context.Context, id int64, jobID string) error {
	res := s.db.WithContext(ctx).Model(&OnboardingSyncDispatch{}).
		Where("id = ? AND status = ?", id, OnboardingSyncDispatchPending).
		Updates(map[string]any{
			"status": OnboardingSyncDispatchDispatched, "job_id": jobID,
			"attempts": gorm.Expr("attempts + 1"), "updated_at": time.Now().UTC(),
		})
	if res.Error != nil {
		return fmt.Errorf("storage: mark onboarding sync dispatch dispatched: %w", res.Error)
	}
	return nil
}

// TouchOnboardingSyncDispatch bumps updated_at without changing state. The
// sweep's observation window is ordered oldest-first and bounded; a row whose
// job is still running is touched so it rotates to the back and cannot starve
// younger rows out of the window.
func (s *Store) TouchOnboardingSyncDispatch(ctx context.Context, id int64) error {
	res := s.db.WithContext(ctx).Model(&OnboardingSyncDispatch{}).
		Where("id = ?", id).Update("updated_at", time.Now().UTC())
	if res.Error != nil {
		return fmt.Errorf("storage: touch onboarding sync dispatch: %w", res.Error)
	}
	return nil
}

// MarkOnboardingSyncDispatchTerminal records the job's terminal outcome.
func (s *Store) MarkOnboardingSyncDispatchTerminal(ctx context.Context, id int64, status string) error {
	res := s.db.WithContext(ctx).Model(&OnboardingSyncDispatch{}).
		Where("id = ? AND status = ?", id, OnboardingSyncDispatchDispatched).
		Updates(map[string]any{"status": status, "updated_at": time.Now().UTC()})
	if res.Error != nil {
		return fmt.Errorf("storage: mark onboarding sync dispatch terminal: %w", res.Error)
	}
	return nil
}

// RequeueOnboardingSyncDispatchForRetry arms a terminal dispatch for one more
// generation: back to pending under a fresh idempotency key (the retry
// generation is part of the key, so the re-enqueue creates a new job while
// crash recovery within the generation still dedupes).
func (s *Store) RequeueOnboardingSyncDispatchForRetry(ctx context.Context, id int64, idempotencyKey string) error {
	res := s.db.WithContext(ctx).Model(&OnboardingSyncDispatch{}).
		Where("id = ? AND status IN ?", id, []string{OnboardingSyncDispatchFailed, OnboardingSyncDispatchPending, OnboardingSyncDispatchDispatched}).
		Updates(map[string]any{
			"status": OnboardingSyncDispatchPending, "idempotency_key": idempotencyKey,
			"updated_at": time.Now().UTC(),
		})
	if res.Error != nil {
		return fmt.Errorf("storage: requeue onboarding sync dispatch: %w", res.Error)
	}
	return nil
}

// BumpOnboardingSyncRetryCount increments and returns the session's retry
// generation (the retry-key input). Idempotent per explicit retry request that
// actually requeues work.
func (s *Store) BumpOnboardingSyncRetryCount(ctx context.Context, sessionID string) (int, error) {
	res := s.db.WithContext(ctx).Model(&OnboardingSyncSession{}).
		Where("session_id = ?", sessionID).
		Updates(map[string]any{
			"retry_count": gorm.Expr("retry_count + 1"), "updated_at": time.Now().UTC(),
		})
	if res.Error != nil {
		return 0, fmt.Errorf("storage: bump onboarding sync retry: %w", res.Error)
	}
	var sess OnboardingSyncSession
	if err := s.db.WithContext(ctx).Where("session_id = ?", sessionID).First(&sess).Error; err != nil {
		return 0, fmt.Errorf("storage: reload onboarding sync retry: %w", err)
	}
	return sess.RetryCount, nil
}

// ListOnboardingSyncWorkItems returns the session's work items (optionally one
// stage), ordered by kind then range — the set an explicit retry scans for
// done items to reuse.
func (s *Store) ListOnboardingSyncWorkItems(ctx context.Context, sessionID, stage string) ([]*OnboardingSyncWorkItem, error) {
	q := s.db.WithContext(ctx).Where("session_id = ?", sessionID)
	if stage != "" {
		q = q.Where("stage = ?", stage)
	}
	var rows []*OnboardingSyncWorkItem
	err := q.Order("kind ASC, range_from ASC").Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list onboarding sync work items: %w", err)
	}
	return rows, nil
}

// MarkOnboardingSyncWorkItem records a work item outcome. A done item carries
// its complete-fetch credential; a gap records its reason. Status transitions
// are one-way out of pending (a done item is never re-fetched by a retry — the
// credential is reused).
func (s *Store) MarkOnboardingSyncWorkItem(ctx context.Context, id int64, status string, credential string, errMsg *string) error {
	updates := map[string]any{"status": status, "updated_at": time.Now().UTC()}
	if status == OnboardingSyncItemDone && credential != "" {
		updates["fetch_credential"] = credential
	}
	if errMsg != nil {
		updates["error"] = *errMsg
	}
	res := s.db.WithContext(ctx).Model(&OnboardingSyncWorkItem{}).
		Where("id = ? AND status = ?", id, OnboardingSyncItemPending).
		Updates(updates)
	if res.Error != nil {
		return fmt.Errorf("storage: mark onboarding sync work item: %w", res.Error)
	}
	return nil
}

// ResetFailedOnboardingSyncWorkItems arms one stage's failed items for the
// retry generation: failed → pending (error cleared). Done items keep their
// credentials — a retry reuses them, never re-fetches; gap items stay gaps
// (permanently unobtainable).
func (s *Store) ResetFailedOnboardingSyncWorkItems(ctx context.Context, sessionID, stage string) (int64, error) {
	res := s.db.WithContext(ctx).Model(&OnboardingSyncWorkItem{}).
		Where("session_id = ? AND stage = ? AND status = ?", sessionID, stage, OnboardingSyncItemFailed).
		Updates(map[string]any{
			"status": OnboardingSyncItemPending, "error": nil, "updated_at": time.Now().UTC(),
		})
	if res.Error != nil {
		return 0, fmt.Errorf("storage: reset failed onboarding sync work items: %w", res.Error)
	}
	return res.RowsAffected, nil
}

// GetOnboardingSyncStageCoverage returns the session's coverage row for a
// stage, or nil.
func (s *Store) GetOnboardingSyncStageCoverage(ctx context.Context, sessionID, stage string) (*OnboardingSyncStageCoverage, error) {
	var cov OnboardingSyncStageCoverage
	err := s.db.WithContext(ctx).
		Where("session_id = ? AND stage = ?", sessionID, stage).First(&cov).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("storage: get onboarding sync stage coverage: %w", err)
	}
	return &cov, nil
}

// ListOnboardingSyncStageCoverage returns all coverage rows for a session.
func (s *Store) ListOnboardingSyncStageCoverage(ctx context.Context, sessionID string) ([]*OnboardingSyncStageCoverage, error) {
	var rows []*OnboardingSyncStageCoverage
	err := s.db.WithContext(ctx).Where("session_id = ?", sessionID).Order("stage ASC").Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list onboarding sync stage coverage: %w", err)
	}
	return rows, nil
}

// UpdateOnboardingSyncStageCoverage persists an executor's or the sweep's
// coverage report (scanned/observed windows, gaps, status). The whole row is
// written; the caller (the sweep, in one transaction per stage) owns
// consistency.
func (s *Store) UpdateOnboardingSyncStageCoverage(ctx context.Context, cov *OnboardingSyncStageCoverage) error {
	cov.UpdatedAt = time.Now().UTC()
	if err := s.db.WithContext(ctx).Model(&OnboardingSyncStageCoverage{}).
		Where("id = ?", cov.ID).Updates(map[string]any{
		"status": cov.Status, "scanned_from": cov.ScannedFrom, "scanned_to": cov.ScannedTo,
		"observed_from": cov.ObservedFrom, "observed_to": cov.ObservedTo,
		"gaps_json": cov.GapsJSON, "job_id": cov.JobID, "last_error": cov.LastError,
		"updated_at": cov.UpdatedAt,
	}).Error; err != nil {
		return fmt.Errorf("storage: update onboarding sync stage coverage: %w", err)
	}
	return nil
}

// ListOnboardingSyncSessionsInStates returns up to limit sessions in any of
// the states — the sweep's waiting_legacy and finalize scans.
func (s *Store) ListOnboardingSyncSessionsInStates(ctx context.Context, states []string, limit int) ([]*OnboardingSyncSession, error) {
	var rows []*OnboardingSyncSession
	err := s.db.WithContext(ctx).
		Where("state IN ?", states).Order("updated_at ASC").Limit(limit).Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list onboarding sync sessions in states: %w", err)
	}
	return rows, nil
}
