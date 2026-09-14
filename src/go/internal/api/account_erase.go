package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// AdminAccountDeleter removes an arbitrary user's identity through the
// auth-service admin endpoint, forwarding the administrator's bearer.
type AdminAccountDeleter interface {
	AdminDeleteAccount(ctx context.Context, adminBearer, userID string) error
}

// CoachDataDeleter removes a user's coach-side data. bearer is forwarded
// unchanged (admin token or the user's own); the coach service authorizes it.
// The returned map is the per-table deletion count.
type CoachDataDeleter interface {
	DeleteCoachData(ctx context.Context, bearer, userID string) (map[string]int64, error)
}

// UserDataDirRemover deletes a user's on-disk data directory. The boolean
// reports whether anything existed.
type UserDataDirRemover interface {
	RemoveUserDir(userID string) (bool, error)
}

// DeletionAuditStore persists the per-attempt audit trail. Satisfied by
// *storage.Store.
type DeletionAuditStore interface {
	StartUserDeletionAudit(ctx context.Context, audit *storage.UserDeletionAudit) error
	MarkUserDeletionStep(ctx context.Context, auditID, step string, at time.Time) error
	FinishUserDeletionAudit(ctx context.Context, auditID, status, errorMessage string, coachCountsJSON *string) error
}

// newAccountEraser wires the shared erasure flow. It returns nil when the store
// is absent (the user surface is not configured), so routes can skip
// registration and handlers can report unavailability.
func newAccountEraser(store UserStore, selfAuth AccountDeleter, adminAuth AdminAccountDeleter, coach CoachDataDeleter, files UserDataDirRemover, audit DeletionAuditStore, log *zap.Logger) *accountEraser {
	if store == nil {
		return nil
	}
	if log == nil {
		log = logging.Default()
	}
	return &accountEraser{
		store:     store,
		selfAuth:  selfAuth,
		adminAuth: adminAuth,
		coach:     coach,
		files:     files,
		audit:     audit,
		now:       func() time.Time { return time.Now().UTC() },
		newID:     uuid.NewString,
		log:       log,
	}
}

// eraseError is a cleanup-step failure with the HTTP status and stable code the
// handler should surface.
type eraseError struct {
	Step    string
	Status  int
	Code    string
	Message string
	Err     error
}

func (e *eraseError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("account erase step %s: %v", e.Step, e.Err)
	}
	return fmt.Sprintf("account erase step %s failed", e.Step)
}

func (e *eraseError) Unwrap() error { return e.Err }

// httpStatusError is implemented by authsvc.ResponseError and the test doubles.
type httpStatusError interface{ HTTPStatus() int }

// errorCodeError exposes a stable machine-readable code (authsvc.ResponseError).
type errorCodeError interface{ ErrorCode() string }

// accountEraser runs the ordered, shared account-erasure flow used by both the
// self-delete route and the administrator delete route. Identity first: the
// auth-service owns the authoritative guards (team ownership, last admin), so
// they run before any destructive step. Each later step is idempotent, so an
// operator can replay the request to finish a partially completed erasure.
type accountEraser struct {
	store     UserStore
	selfAuth  AccountDeleter
	adminAuth AdminAccountDeleter
	coach     CoachDataDeleter
	files     UserDataDirRemover
	audit     DeletionAuditStore
	now       func() time.Time
	newID     func() string
	log       *zap.Logger
}

// erase clears the subject's identity and all owned data. actorID identifies who
// triggered the deletion (the subject for self-delete, the admin otherwise).
// asAdmin selects the auth-service admin endpoint and the coach admin guard.
func (e *accountEraser) erase(ctx context.Context, subject, actor, bearer string, asAdmin bool) error {
	auditID := e.startAudit(ctx, subject, actor)

	if err := e.deleteIdentity(ctx, bearer, subject, asAdmin); err != nil {
		if cause := classifyIdentityError(err, asAdmin); cause != nil {
			return e.fail(ctx, auditID, storage.DeletionStepAuth, cause, nil)
		}
	}
	e.mark(ctx, auditID, storage.DeletionStepAuth)

	var coachCounts map[string]int64
	if e.coach != nil {
		counts, err := e.coach.DeleteCoachData(ctx, bearer, subject)
		if err != nil {
			if cause := classifyCoachError(err); cause != nil {
				return e.fail(ctx, auditID, storage.DeletionStepCoach, cause, nil)
			}
		}
		coachCounts = counts
		e.mark(ctx, auditID, storage.DeletionStepCoach)
	}

	if err := e.store.DeleteUserData(ctx, subject); err != nil {
		return e.fail(ctx, auditID, storage.DeletionStepStride, &eraseError{
			Status: http.StatusInternalServerError, Code: "delete_failed", Message: "failed to delete user data", Err: err,
		}, coachCounts)
	}
	e.mark(ctx, auditID, storage.DeletionStepStride)

	if e.files != nil {
		if _, err := e.files.RemoveUserDir(subject); err != nil {
			return e.fail(ctx, auditID, storage.DeletionStepFiles, &eraseError{
				Status: http.StatusInternalServerError, Code: "delete_failed", Message: "failed to delete user data directory", Err: err,
			}, coachCounts)
		}
	}
	e.mark(ctx, auditID, storage.DeletionStepFiles)

	e.finish(ctx, auditID, storage.DeletionStatusCompleted, "", coachCounts)
	return nil
}

// deleteIdentity deletes the auth-service identity. 404 (and, for self-delete,
// 401) mean the identity is already gone and cleanup may continue.
func (e *accountEraser) deleteIdentity(ctx context.Context, bearer, subject string, asAdmin bool) error {
	if asAdmin {
		if e.adminAuth == nil {
			return &eraseError{Status: http.StatusServiceUnavailable, Code: "auth_unavailable", Message: "auth-service unavailable", Err: errors.New("admin account deleter not configured")}
		}
		return e.adminAuth.AdminDeleteAccount(ctx, bearer, subject)
	}
	if e.selfAuth == nil {
		return &eraseError{Status: http.StatusServiceUnavailable, Code: "auth_unavailable", Message: "auth-service unavailable", Err: errors.New("account deleter not configured")}
	}
	return e.selfAuth.DeleteAccount(ctx, bearer)
}

func (e *accountEraser) startAudit(ctx context.Context, subject, actor string) string {
	if e.audit == nil {
		return ""
	}
	now := e.now()
	record := &storage.UserDeletionAudit{
		ID:        e.newID(),
		UserID:    subject,
		ActorID:   actor,
		Status:    storage.DeletionStatusPending,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := e.audit.StartUserDeletionAudit(ctx, record); err != nil {
		e.log.Error("start user deletion audit failed", zap.String("user_id", subject), zapErr(err))
		return ""
	}
	return record.ID
}

// mark records a completed step. Audit failures are logged, not fatal: losing
// the trail is bad, but it must not strand a half-deleted account.
func (e *accountEraser) mark(ctx context.Context, auditID, step string) {
	if e.audit == nil || auditID == "" {
		return
	}
	if err := e.audit.MarkUserDeletionStep(ctx, auditID, step, e.now()); err != nil {
		e.log.Error("mark user deletion step failed", zap.String("audit_id", auditID), zap.String("step", step), zapErr(err))
	}
}

func (e *accountEraser) fail(ctx context.Context, auditID, step string, cause *eraseError, coachCounts map[string]int64) error {
	cause.Step = step
	e.finish(ctx, auditID, storage.DeletionStatusPartial, cause.Error(), coachCounts)
	return cause
}

func (e *accountEraser) finish(ctx context.Context, auditID, status, message string, coachCounts map[string]int64) {
	if e.audit == nil || auditID == "" {
		return
	}
	var countsJSON *string
	if coachCounts != nil {
		if encoded, err := json.Marshal(coachCounts); err == nil {
			value := string(encoded)
			countsJSON = &value
		}
	}
	if err := e.audit.FinishUserDeletionAudit(ctx, auditID, status, message, countsJSON); err != nil {
		e.log.Error("finish user deletion audit failed", zap.String("audit_id", auditID), zapErr(err))
	}
}

// classifyIdentityError maps an auth-service failure to the erasure error the
// handler returns, or nil when the failure means the identity is already gone
// and cleanup may continue. A 404 always means "already deleted"; a self-delete
// 401 means the caller's token is already invalid.
func classifyIdentityError(err error, asAdmin bool) *eraseError {
	var statusErr httpStatusError
	if !errors.As(err, &statusErr) {
		return &eraseError{Status: http.StatusServiceUnavailable, Code: "auth_unavailable", Message: "auth-service unavailable", Err: err}
	}
	status := statusErr.HTTPStatus()
	if status == http.StatusNotFound || (!asAdmin && status == http.StatusUnauthorized) {
		return nil
	}
	if status >= http.StatusInternalServerError {
		return &eraseError{Status: http.StatusServiceUnavailable, Code: "auth_unavailable", Message: "auth-service unavailable", Err: err}
	}
	code := "auth_rejected"
	if coder, ok := err.(errorCodeError); ok && coder.ErrorCode() != "" {
		code = coder.ErrorCode()
	}
	return &eraseError{Status: status, Code: code, Message: "auth-service rejected account deletion", Err: err}
}

// classifyCoachError maps a coach-service failure, or nil when there is nothing
// to clean (404).
func classifyCoachError(err error) *eraseError {
	var statusErr httpStatusError
	if !errors.As(err, &statusErr) {
		return &eraseError{Status: http.StatusServiceUnavailable, Code: "coach_unavailable", Message: "coach service unavailable", Err: err}
	}
	status := statusErr.HTTPStatus()
	if status == http.StatusNotFound {
		return nil
	}
	if status == 0 || status >= http.StatusInternalServerError {
		return &eraseError{Status: http.StatusServiceUnavailable, Code: "coach_unavailable", Message: "coach service unavailable", Err: err}
	}
	return &eraseError{Status: status, Code: "coach_rejected", Message: "coach service rejected account deletion", Err: err}
}
