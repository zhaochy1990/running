// binding.go is the activity write-isolation foundation (devops#1005, epic
// devops#1004 T01): the binding revision, the cross-worker per-user execution
// lease, and the blob upload-intent registry.
//
// Binding revision: watch_binding_state holds ONE row per user whose revision
// is monotonic and never resets. It changes exactly on the identity events the
// spec names — unbind (credential delete → tombstone), provider switch, or a
// different provider account id — and NOT on a token refresh (same identity
// re-save is a no-op). A first-seen legacy user gets revision 1; a backfill
// that fills a previously-NULL provider account id does not bump.
//
// Execution lease: watch_exec_leases holds ONE row per user while a worker
// runs their sync. The fencing token increments on every takeover, so a stale
// worker (crashed, partitioned, or simply slower than the lease TTL) can never
// pass the fence check inside the publish transaction with its old token —
// this is the per-user mutual exclusion the job-level heartbeat lease does
// not provide (two jobs for one user can run on two workers).
//
// Upload intents: ts_upload_intents records the immutable v2 object key a
// writer is about to Put, from just before the Put until the row transaction
// resolves. The GC treats a fresh intent as "active upload" and never deletes
// the key — belt and braces on top of the grace window for the blob-succeeded/
// transaction-failed window.
package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// WatchBindingState is the per-user provider-binding identity and its
// monotonic revision. Provider/ProviderAccountID are NULL on a tombstone (the
// user unbound); the row is kept so the revision never resets across a
// rebind — a stale writer from the previous binding must not collide with a
// fresh revision number.
type WatchBindingState struct {
	UserID            string    `gorm:"column:user_id;type:char(36);primaryKey"`
	Provider          *string   `gorm:"column:provider;type:varchar(32)"`
	ProviderAccountID *string   `gorm:"column:provider_account_id;type:varchar(64)"`
	Revision          int64     `gorm:"column:revision;type:bigint;not null"`
	UpdatedAt         time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (WatchBindingState) TableName() string { return "watch_binding_state" }

// WatchExecLease is the per-user sync execution lease. Token is the fencing
// token: every takeover increments it, and the publish transaction validates
// the writer's token against this row under lock.
type WatchExecLease struct {
	UserID      string    `gorm:"column:user_id;type:char(36);primaryKey"`
	Token       int64     `gorm:"column:token;type:bigint;not null"`
	Holder      string    `gorm:"column:holder;type:varchar(191);not null"`
	HeartbeatAt time.Time `gorm:"column:heartbeat_at;type:datetime(6);not null"`
	UpdatedAt   time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (WatchExecLease) TableName() string { return "watch_exec_leases" }

// TSUploadIntent marks an in-flight immutable blob upload so the GC can tell
// "orphan" from "Put succeeded, row transaction not resolved yet". Rows are
// best-effort bookkeeping: a crash can strand one, and intents older than the
// GC grace window are ignored (and swept) — the grace window remains the
// hard safety net.
type TSUploadIntent struct {
	BlobKey   string    `gorm:"column:blob_key;type:varchar(256);primaryKey"`
	UserID    string    `gorm:"column:user_id;type:char(36);not null"`
	CreatedAt time.Time `gorm:"column:created_at;type:datetime(6);not null"`
}

func (TSUploadIntent) TableName() string { return "ts_upload_intents" }

// --- publish session (context-carried) --------------------------------------

// PublishSession is the execution proof a watch-sync run carries into the
// storage write path (via context — providers thread ctx down to every
// store call, so no provider signature changes). The publish transaction
// re-validates BindingRevision and LeaseToken against the live rows; a stale
// session fails the write with a *FenceViolationError.
type PublishSession struct {
	UserID          string
	Provider        string
	BindingRevision int64
	LeaseToken      int64
	Holder          string
}

type publishSessionKey struct{}

// WithPublishSession returns a context carrying sess. Storage write methods
// that support fenced publishing (activity upserts, the sync cursor) branch
// on its presence: with a session they publish through the fenced immutable
// path; without one they keep the legacy v1 behaviour.
func WithPublishSession(ctx context.Context, sess *PublishSession) context.Context {
	return context.WithValue(ctx, publishSessionKey{}, sess)
}

// PublishSessionFromContext returns the carried session, or nil.
func PublishSessionFromContext(ctx context.Context) *PublishSession {
	sess, _ := ctx.Value(publishSessionKey{}).(*PublishSession)
	return sess
}

// FenceViolationError reports that a fenced write was refused: the writer's
// session no longer matches the live binding/lease state. Reason is one of
// lease_lost, lease_missing, binding_changed, binding_missing.
type FenceViolationError struct {
	Reason string
}

func (e *FenceViolationError) Error() string {
	return fmt.Sprintf("storage: fence violation: %s", e.Reason)
}

// IsFenceViolation reports whether err is (or wraps) a FenceViolationError.
func IsFenceViolation(err error) bool {
	var fv *FenceViolationError
	return errors.As(err, &fv)
}

// ErrLeaseHeld reports that AcquireWatchExecLease lost the race: another
// holder's lease is live and unexpired. Callers back off and retry.
var ErrLeaseHeld = errors.New("storage: watch exec lease held by another holder")

// DefaultWatchExecLeaseTTL is how long an unrenewed per-user execution lease
// remains valid before another worker may take it over.
const DefaultWatchExecLeaseTTL = 90 * time.Second

// validatePublishFence runs INSIDE the publish transaction: it locks the
// lease and binding rows and refuses the write when the session's token or
// revision no longer matches. Locking makes the check atomic with the row
// writes that follow in the same transaction — there is no window where a
// takeover interleaves between validation and publish.
func validatePublishFence(tx *gorm.DB, uid string, sess *PublishSession) error {
	if sess == nil {
		return nil
	}
	var lease WatchExecLease
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("user_id = ?", uid).First(&lease).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return &FenceViolationError{Reason: "lease_missing"}
	}
	if err != nil {
		return fmt.Errorf("storage: fence: read exec lease: %w", err)
	}
	if lease.Token != sess.LeaseToken {
		return &FenceViolationError{Reason: "lease_lost"}
	}
	var binding WatchBindingState
	err = tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("user_id = ?", uid).First(&binding).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return &FenceViolationError{Reason: "binding_missing"}
	}
	if err != nil {
		return fmt.Errorf("storage: fence: read binding state: %w", err)
	}
	if binding.Revision != sess.BindingRevision {
		return &FenceViolationError{Reason: "binding_changed"}
	}
	return nil
}

// --- binding state ----------------------------------------------------------

// GetWatchBinding returns the user's binding state, or nil when the user has
// none (never bound, or a tombstone row deleted by erasure).
func (s *Store) GetWatchBinding(ctx context.Context, userID string) (*WatchBindingState, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var b WatchBindingState
	err = s.db.WithContext(ctx).Where("user_id = ?", uid).First(&b).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("storage: get watch binding: %w", err)
	}
	return &b, nil
}

// EnsureWatchBinding makes sure a binding row exists for the user at their
// current provider (creating it at revision 1 for first-seen legacy users —
// no bump: there is no earlier revision anyone could hold) and returns the
// current revision. It does not change an existing row, even a tombstone's
// provider mismatch: re-establishing identity after unbind goes through
// SaveCredential (a login), which bumps.
func (s *Store) EnsureWatchBinding(ctx context.Context, userID, provider string) (int64, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return 0, err
	}
	var out int64
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var b WatchBindingState
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ?", uid).First(&b).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			p := provider
			b = WatchBindingState{UserID: uid, Provider: &p, Revision: 1, UpdatedAt: time.Now().UTC()}
			if err := tx.Create(&b).Error; err != nil {
				return fmt.Errorf("storage: create watch binding: %w", err)
			}
			out = 1
			return nil
		}
		if err != nil {
			return fmt.Errorf("storage: ensure watch binding: %w", err)
		}
		out = b.Revision
		return nil
	})
	if err != nil {
		return 0, err
	}
	return out, nil
}

// maintainWatchBinding applies one credential write's identity effect to the
// binding state, inside the caller's transaction:
//
//   - no row → create at revision 1 (first bind; also the backfill path for
//     pre-isolation users whose first re-save happens under this code);
//   - tombstone (provider NULL), a different provider, or a different KNOWN
//     account id → bump revision and rebind;
//   - a save without an account id never bumps (token refreshes may predate
//     account capture), and a NULL→value save backfills the account without
//     a bump — we learned the account id, the binding did not change.
func maintainWatchBinding(tx *gorm.DB, uid, provider string, accountID *string, now time.Time) error {
	var b WatchBindingState
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("user_id = ?", uid).First(&b).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		p := provider
		row := WatchBindingState{UserID: uid, Provider: &p, ProviderAccountID: accountID,
			Revision: 1, UpdatedAt: now}
		if err := tx.Create(&row).Error; err != nil {
			return fmt.Errorf("storage: create watch binding: %w", err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("storage: maintain watch binding: %w", err)
	}
	oldAccount := ""
	if b.ProviderAccountID != nil {
		oldAccount = *b.ProviderAccountID
	}
	newAccount := ""
	if accountID != nil {
		newAccount = *accountID
	}
	oldProvider := ""
	if b.Provider != nil {
		oldProvider = *b.Provider
	}
	switch {
	case b.Provider == nil: // tombstone → rebind
		b.Provider, b.ProviderAccountID, b.Revision, b.UpdatedAt = &provider, accountID, b.Revision+1, now
	case oldProvider != provider, newAccount != "" && newAccount != oldAccount:
		b.Provider, b.ProviderAccountID, b.Revision, b.UpdatedAt = &provider, accountID, b.Revision+1, now
	default: // token refresh, or account backfill (NULL→value)
		if b.ProviderAccountID == nil && accountID != nil {
			b.ProviderAccountID = accountID
		}
		b.UpdatedAt = now
	}
	return tx.Model(&WatchBindingState{}).Where("user_id = ?", uid).
		Updates(map[string]any{
			"provider": b.Provider, "provider_account_id": b.ProviderAccountID,
			"revision": b.Revision, "updated_at": b.UpdatedAt,
		}).Error
}

// tombstoneWatchBinding bumps the revision and clears the identity inside the
// caller's transaction — the unbind event. The row is kept so the monotonic
// revision survives the rebind.
func tombstoneWatchBinding(tx *gorm.DB, uid string, now time.Time) error {
	res := tx.Model(&WatchBindingState{}).Where("user_id = ?", uid).
		Updates(map[string]any{
			"provider": nil, "provider_account_id": nil,
			"revision": gorm.Expr("revision + 1"), "updated_at": now,
		})
	if res.Error != nil {
		return fmt.Errorf("storage: tombstone watch binding: %w", res.Error)
	}
	return nil
}

// --- execution lease ---------------------------------------------------------

// AcquireWatchExecLease claims the user's per-user execution lease for holder
// and returns the fencing token. A live, unexpired foreign lease fails with
// ErrLeaseHeld (back off and retry). A lease held by the same holder is
// renewed in place with the SAME token (the job-level lease already
// serializes one job's dispatches; re-acquiring is resumption, not takeover).
// An expired lease is taken over with token+1 — the previous holder's token
// becomes permanently stale.
func (s *Store) AcquireWatchExecLease(ctx context.Context, userID, holder string, ttl time.Duration) (int64, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return 0, err
	}
	if ttl <= 0 {
		ttl = DefaultWatchExecLeaseTTL
	}
	now := time.Now().UTC()
	var token int64
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var lease WatchExecLease
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ?", uid).First(&lease).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			row := WatchExecLease{UserID: uid, Token: 1, Holder: holder,
				HeartbeatAt: now, UpdatedAt: now}
			if err := tx.Create(&row).Error; err != nil {
				return fmt.Errorf("storage: create exec lease: %w", err)
			}
			token = row.Token
			return nil
		}
		if err != nil {
			return fmt.Errorf("storage: acquire exec lease: %w", err)
		}
		switch {
		case lease.Holder == holder:
			// Same logical holder (job re-dispatch after reclaim): renew.
			token = lease.Token
			return tx.Model(&WatchExecLease{}).Where("user_id = ?", uid).
				Updates(map[string]any{"heartbeat_at": now, "updated_at": now}).Error
		case lease.HeartbeatAt.Before(now.Add(-ttl)):
			// Expired: takeover with a fresh fencing token.
			token = lease.Token + 1
			return tx.Model(&WatchExecLease{}).Where("user_id = ?", uid).
				Updates(map[string]any{
					"token": token, "holder": holder,
					"heartbeat_at": now, "updated_at": now,
				}).Error
		default:
			return ErrLeaseHeld
		}
	})
	if err != nil {
		return 0, err
	}
	return token, nil
}

// RenewWatchExecLease extends the lease iff (holder, token) still owns it.
// A lost renewal (takeover happened) returns ErrLeaseHeld — the caller must
// stop writing: its token is fenced out of the next publish.
func (s *Store) RenewWatchExecLease(ctx context.Context, userID, holder string, token int64, ttl time.Duration) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	if ttl <= 0 {
		ttl = DefaultWatchExecLeaseTTL
	}
	now := time.Now().UTC()
	res := s.db.WithContext(ctx).Model(&WatchExecLease{}).
		Where("user_id = ? AND holder = ? AND token = ? AND heartbeat_at >= ?", uid, holder, token, now.Add(-ttl)).
		Updates(map[string]any{"heartbeat_at": now, "updated_at": now})
	if res.Error != nil {
		return fmt.Errorf("storage: renew exec lease: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return ErrLeaseHeld
	}
	return nil
}

// ReleaseWatchExecLease surrenders the lease iff (holder, token) still owns
// it — by bumping the token and clearing the holder into a tombstone, never
// by deleting the row: the fencing token must stay monotonic, or a re-acquire
// after a clean release would reuse the released token and unfence a zombie
// from the released session. Idempotent: releasing a taken-over or missing
// lease is a no-op.
func (s *Store) ReleaseWatchExecLease(ctx context.Context, userID, holder string, token int64) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	res := s.db.WithContext(ctx).Model(&WatchExecLease{}).
		Where("user_id = ? AND holder = ? AND token = ?", uid, holder, token).
		Updates(map[string]any{
			"token":        gorm.Expr("token + 1"),
			"holder":       "",
			"heartbeat_at": time.Unix(0, 0).UTC(),
			"updated_at":   time.Now().UTC(),
		})
	if res.Error != nil {
		return fmt.Errorf("storage: release exec lease: %w", res.Error)
	}
	return nil
}

// BeginWatchSyncSession is the worker-facing entry: it ensures the binding
// row exists, acquires (or resumes) the user's execution lease, and returns
// the session every fenced write must carry. The lease's TTL must comfortably
// exceed the renewal cadence the caller runs (worker: TTL/3).
func (s *Store) BeginWatchSyncSession(ctx context.Context, userID, provider, holder string, ttl time.Duration) (*PublishSession, error) {
	rev, err := s.EnsureWatchBinding(ctx, userID, provider)
	if err != nil {
		return nil, err
	}
	token, err := s.AcquireWatchExecLease(ctx, userID, holder, ttl)
	if err != nil {
		return nil, err
	}
	return &PublishSession{
		UserID: userID, Provider: provider,
		BindingRevision: rev, LeaseToken: token, Holder: holder,
	}, nil
}

// --- upload intents -----------------------------------------------------------

// recordTSUploadIntent marks key as in-flight before the blob Put. Best-effort
// failure tolerance is NOT wanted here: if the intent cannot be recorded the
// GC loses its active-upload signal, so the write fails loudly instead.
func (s *Store) recordTSUploadIntent(ctx context.Context, key, userID string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	row := &TSUploadIntent{BlobKey: key, UserID: uid, CreatedAt: time.Now().UTC()}
	return s.db.WithContext(ctx).
		Clauses(clause.OnConflict{DoNothing: true}).Create(row).Error
}

// clearTSUploadIntent removes the intent once the row transaction resolved.
// Best-effort: a stranded row is ignored by the GC after the grace window.
func (s *Store) clearTSUploadIntent(ctx context.Context, key string) {
	_ = s.db.WithContext(ctx).Where("blob_key = ?", key).Delete(&TSUploadIntent{}).Error
}

// ListActiveUploadIntents returns the blob keys with an intent row newer than
// the given cutoff — the GC's "active upload" protection set. Callers pass
// their deletion grace window so a long-dead stranded intent protects nothing.
func (s *Store) ListActiveUploadIntents(ctx context.Context, since time.Time) (map[string]bool, error) {
	var keys []string
	err := s.db.WithContext(ctx).Model(&TSUploadIntent{}).
		Where("created_at > ?", since).Pluck("blob_key", &keys).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list active upload intents: %w", err)
	}
	out := make(map[string]bool, len(keys))
	for _, k := range keys {
		out[k] = true
	}
	return out, nil
}

// SweepStaleUploadIntents deletes intent rows older than the cutoff — the
// GC's janitor for rows stranded by a crash between Put and clear.
func (s *Store) SweepStaleUploadIntents(ctx context.Context, before time.Time) (int64, error) {
	res := s.db.WithContext(ctx).
		Where("created_at < ?", before).Delete(&TSUploadIntent{})
	if res.Error != nil {
		return 0, fmt.Errorf("storage: sweep stale upload intents: %w", res.Error)
	}
	return res.RowsAffected, nil
}
