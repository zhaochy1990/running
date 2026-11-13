package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrMasterPlanExists is returned when a caller attempts to apply a plan
// without explicitly allowing replacement of the active plan.
var ErrMasterPlanExists = errors.New("storage: active master plan already exists")

// ErrMasterPlanConflict means the active plan changed after an administrator
// confirmed a specific plan revision for replacement.
var ErrMasterPlanConflict = errors.New("storage: active master plan changed")

// ErrMasterPlanNotFound is returned when an update targets a user with no
// active master plan to modify.
var ErrMasterPlanNotFound = errors.New("storage: active master plan not found")

// MasterPlanReplacement is the active row revision an administrator reviewed
// and explicitly confirmed replacing.
type MasterPlanReplacement struct {
	PlanID   string
	Revision int64
}

// AutoMigrateMasterPlan creates or reconciles the steady-state master_plan
// schema. An existing non-final table fails closed: the destructive
// version-to-revision rename belongs to the maintenance-window migration CLI,
// and starting this API must never create a dual-column state.
//
// #585 convergence runs as a guarded pre-step on an existing table: draft rows
// are deleted (never applied), archived rows become superseded, then the old
// current-marker CHECK (which still admitted draft/archived) is dropped so
// AutoMigrate re-creates it with the active/superseded-only vocabulary.
func (s *Store) AutoMigrateMasterPlan(ctx context.Context) error {
	db := s.db.WithContext(ctx)
	migrator := db.Migrator()
	if migrator.HasTable(&MasterPlan{}) {
		hasVersion := migrator.HasColumn(&MasterPlan{}, "version")
		hasRevision := migrator.HasColumn(&MasterPlan{}, "revision")
		if !hasRevision || hasVersion {
			return fmt.Errorf("storage: master_plan schema requires explicit version-to-revision migration (version=%t revision=%t)", hasVersion, hasRevision)
		}
		if err := db.Exec("DELETE FROM master_plan WHERE status = ?", "draft").Error; err != nil {
			return fmt.Errorf("storage: delete legacy master plan drafts: %w", err)
		}
		if err := db.Exec("UPDATE master_plan SET status = ? WHERE status = ?", MasterPlanStatusSuperseded, "archived").Error; err != nil {
			return fmt.Errorf("storage: converge master plan archived to superseded: %w", err)
		}
		if migrator.HasConstraint(&MasterPlan{}, "ck_master_plan_current_marker") {
			if err := migrator.DropConstraint(&MasterPlan{}, "ck_master_plan_current_marker"); err != nil {
				return fmt.Errorf("storage: drop old master_plan current-marker constraint: %w", err)
			}
		}
	}
	if err := db.AutoMigrate(&MasterPlan{}); err != nil {
		return fmt.Errorf("storage: automigrate master_plan: %w", err)
	}
	return nil
}

// GetCurrentMasterPlan returns the athlete's single current season plan in
// either content representation. Discovery considers both current markers so a
// row with status/active_flag drift is reported instead of looking absent.
func (s *Store) GetCurrentMasterPlan(ctx context.Context, userID string) (*MasterPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var candidates []MasterPlan
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND (active_flag = 1 OR status = ?)", uid, MasterPlanStatusActive).
		Find(&candidates).Error; err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	if len(candidates) != 1 {
		return nil, fmt.Errorf("storage: master_plan current invariant: user %s has %d candidates", uid, len(candidates))
	}
	p := &candidates[0]
	if err := validateCurrentMasterPlan(p, uid); err != nil {
		return nil, err
	}
	return p, nil
}

func validateCurrentMasterPlan(p *MasterPlan, userID string) error {
	if p.UserID != userID {
		return fmt.Errorf("storage: master_plan current invariant: row user mismatch")
	}
	if _, err := uuid.Parse(p.PlanID); err != nil {
		return fmt.Errorf("storage: master_plan current invariant: invalid plan_id")
	}
	if _, err := uuid.Parse(p.GoalID); err != nil {
		return fmt.Errorf("storage: master_plan current invariant: invalid goal_id")
	}
	if p.Status != MasterPlanStatusActive || p.ActiveFlag == nil || *p.ActiveFlag != 1 {
		return fmt.Errorf("storage: master_plan current invariant: status and active_flag disagree")
	}
	if p.CreatedAt.IsZero() || p.UpdatedAt.IsZero() {
		return fmt.Errorf("storage: master_plan current invariant: timestamps are required")
	}
	switch p.ContentVersion {
	case MasterPlanContentMarkdown:
		if p.Revision != nil {
			return fmt.Errorf("storage: master_plan current invariant: markdown revision must be null")
		}
		if strings.TrimSpace(p.Content) == "" {
			return fmt.Errorf("storage: master_plan current invariant: markdown content is empty")
		}
	case MasterPlanContentStructured:
		if p.Revision == nil || *p.Revision < 1 {
			return fmt.Errorf("storage: master_plan current invariant: structured revision must be positive")
		}
		if strings.TrimSpace(p.Content) == "" {
			return fmt.Errorf("storage: master_plan current invariant: structured content is empty")
		}
	default:
		return fmt.Errorf("storage: master_plan current invariant: unsupported content_version %d", p.ContentVersion)
	}
	return nil
}

// ApplyStructuredMasterPlan inserts a new active structured master plan for an
// athlete. Replacing an active row requires its exact plan ID (and, for a
// structured content_version 2 row, its exact revision); that row becomes
// superseded in the same transaction before the new active row is inserted. A
// legacy markdown (content_version 1) active row has a NULL revision — it
// carries no revision concept, so only the plan ID is confirmed for
// replacement. All rows for the user are locked so the active transition is
// serialized. The new plan has its own identity and therefore starts at
// revision 1.
//
// applyToken is the user-side apply idempotency key (#585): a non-empty token
// that already exists on one of the user's rows short-circuits the apply and
// returns that existing row (the lock above makes the check race-free), so a
// replayed card apply never creates a second plan. Admin imports pass "".
func (s *Store) ApplyStructuredMasterPlan(
	ctx context.Context, userID, goalID, content, applyToken string, replacement *MasterPlanReplacement,
) (*MasterPlan, *MasterPlan, error) {
	return s.applyStructuredMasterPlan(ctx, userID, goalID, content, applyToken, replacement, nil, "")
}

// lockConfirmedCandidate rechecks the artifact inside the activation transaction.
// An internal job transition can change a done result after the API reads it.
func lockConfirmedCandidate(tx *gorm.DB, uid, content, token string) error {
	var candidate map[string]any
	if json.Unmarshal([]byte(content), &candidate) != nil {
		return nil // Legacy content is validated by its existing path.
	}
	rawID, present := candidate["candidate_job_id"]
	if !present {
		return nil
	}
	id, ok := rawID.(string)
	if !ok || candidate["candidate_user_id"] != uid || (token != "" && token != id) {
		return ErrMasterPlanConflict
	}
	var row jobModel
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", id).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrMasterPlanConflict
	}
	if err != nil {
		return fmt.Errorf("storage: lock candidate job: %w", err)
	}
	if row.UserID == nil || *row.UserID != uid || row.Type != "generate_master_plan" || row.Status != "done" {
		return ErrMasterPlanConflict
	}
	var result struct {
		Content map[string]any `json:"content"`
	}
	if json.Unmarshal([]byte(row.ResultJSON), &result) != nil || !reflect.DeepEqual(result.Content, candidate) {
		return ErrMasterPlanConflict
	}
	return nil
}

// ApplyStructuredMasterPlanWithWeeks commits a confirmed season and its first
// validated weeks, including their workouts, in the same transaction.
func (s *Store) ApplyStructuredMasterPlanWithWeeks(
	ctx context.Context, userID, goalID, content, applyToken string, replacement *MasterPlanReplacement, items []WeeklyPlanBatchItem, asOf ...string,
) (*MasterPlan, *MasterPlan, error) {
	prepared, err := prepareWeeklyPlanBatch(items)
	if err != nil {
		return nil, nil, err
	}
	day := timefmt.ShanghaiDayStr(time.Now())
	if len(asOf) > 0 {
		day = asOf[0]
	}
	return s.applyStructuredMasterPlan(ctx, userID, goalID, content, applyToken, replacement, prepared, day)
}

func (s *Store) applyStructuredMasterPlan(
	ctx context.Context, userID, goalID, content, applyToken string, replacement *MasterPlanReplacement, weeks []preparedWeeklyPlanBatch, asOf string,
) (*MasterPlan, *MasterPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, nil, err
	}
	if _, err := uuid.Parse(goalID); err != nil {
		return nil, nil, fmt.Errorf("storage: invalid goal_id: %w", err)
	}
	if applyToken != "" {
		if _, err := uuid.Parse(applyToken); err != nil {
			return nil, nil, fmt.Errorf("storage: invalid apply_token: %w", err)
		}
	}
	if strings.TrimSpace(content) == "" {
		return nil, nil, fmt.Errorf("storage: content cannot be empty")
	}

	var created *MasterPlan
	var replaced *MasterPlan
	apply := func() error {
		created = nil
		replaced = nil
		return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if err := lockConfirmedCandidate(tx, uid, content, applyToken); err != nil {
				return err
			}
			var rows []MasterPlan
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("user_id = ?", uid).
				Order("revision DESC, created_at DESC").
				Find(&rows).Error; err != nil {
				return fmt.Errorf("storage: lock master plans: %w", err)
			}

			for i := range rows {
				if rows[i].Status == MasterPlanStatusActive {
					replaced = &rows[i]
				}
			}
			// An apply token is one-shot even if its plan was later superseded.
			if applyToken != "" {
				for i := range rows {
					if rows[i].ApplyToken != nil && *rows[i].ApplyToken == applyToken {
						if rows[i].Status != MasterPlanStatusActive {
							return ErrMasterPlanConflict
						}
						created = &rows[i]
						replaced = nil
						return nil
					}
				}
			}
			if asOf != "" && asOf != timefmt.ShanghaiDayStr(time.Now()) {
				return ErrMasterPlanConflict
			}
			if replaced == nil {
				if replacement != nil {
					return ErrMasterPlanConflict
				}
			} else if replacement == nil {
				return ErrMasterPlanExists
			} else if replaced.PlanID != replacement.PlanID {
				return ErrMasterPlanConflict
			} else if replaced.Revision != nil && *replaced.Revision != replacement.Revision {
				// A structured (content_version 2) row requires an exact revision
				// match so a stale confirm surfaces as 409. A legacy markdown
				// (content_version 1) row has a NULL revision — it has no revision
				// concept, so the plan ID confirmation above is sufficient and the
				// caller's sentinel revision is not compared.
				return ErrMasterPlanConflict
			}

			now := time.Now().UTC().Truncate(time.Millisecond)
			if replaced != nil {
				archiveQuery := tx.Model(&MasterPlan{}).
					Where("plan_id = ? AND user_id = ? AND status = ?", replaced.PlanID, uid, MasterPlanStatusActive)
				if replaced.Revision != nil {
					archiveQuery = archiveQuery.Where("revision = ?", *replaced.Revision)
				} else {
					// Legacy markdown rows store NULL revision; SQL "= NULL" never
					// matches, so archive with an explicit IS NULL predicate.
					archiveQuery = archiveQuery.Where("revision IS NULL")
				}
				result := archiveQuery.Updates(map[string]any{
					"status":      MasterPlanStatusSuperseded,
					"active_flag": nil,
					"updated_at":  now,
				})
				if result.Error != nil {
					return fmt.Errorf("storage: supersede prior master plan: %w", result.Error)
				}
				if result.RowsAffected != 1 {
					return ErrMasterPlanConflict
				}
				replaced.Status = MasterPlanStatusSuperseded
				replaced.ActiveFlag = nil
				replaced.UpdatedAt = now
			}

			revision := int64(1)
			activeFlag := int8(1)
			planID, err := adoptProspectiveMasterPlanID(tx, content)
			if err != nil {
				return err
			}
			storedContent, err := linkMasterPlanContent(content, planID, weeks != nil)
			if err != nil {
				return err
			}
			row := &MasterPlan{
				PlanID: planID, UserID: uid, GoalID: goalID,
				ContentVersion: MasterPlanContentStructured, Content: storedContent,
				Status: MasterPlanStatusActive, ActiveFlag: &activeFlag,
				Revision: &revision, CreatedAt: now, UpdatedAt: now,
			}
			if applyToken != "" {
				token := applyToken
				row.ApplyToken = &token
			}
			if err := tx.Create(row).Error; err != nil {
				if isDuplicateKey(err) {
					return ErrMasterPlanExists
				}
				return fmt.Errorf("storage: create master plan: %w", err)
			}
			for _, week := range weeks {
				if week.item.Replacement == nil {
					start, _ := time.Parse("2006-01-02", week.item.WeekStart)
					end := start.AddDate(0, 0, 6).Format("2006-01-02")
					var orphans []Workout
					err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("workout_id").Where("user_id = ? AND source = ? AND status = ? AND date BETWEEN ? AND ? AND date > ?", uid, WorkoutSourceWeekly, WorkoutStatusActive, week.item.WeekStart, end, asOf).Find(&orphans).Error
					if err != nil {
						return fmt.Errorf("storage: lock unowned weekly workouts: %w", err)
					}
					if len(orphans) > 0 {
						return ErrWeeklyPlanConflict
					}
				}
				if week.item.Replacement != nil {
					var prior WeeklyPlan
					err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("user_id = ? AND week_start = ?", uid, week.item.WeekStart).First(&prior).Error
					if errors.Is(err, gorm.ErrRecordNotFound) {
						return ErrWeeklyPlanConflict
					}
					if err != nil {
						return fmt.Errorf("storage: lock prior weekly plan: %w", err)
					}
					if replaced == nil || prior.MasterPlanID == nil || *prior.MasterPlanID != replaced.PlanID {
						return ErrWeeklyPlanMasterPlanConflict
					}
				}
				if _, _, err := applyWeeklyPlanTx(tx, uid, week.item.WeekStart, week.item.Content, week.item.Replacement, &planID, true, false, week.item.ProtectThrough); err != nil {
					return err
				}
			}
			if asOf != "" && replaced != nil {
				if err := cleanupReplacedMasterPlanTx(tx, uid, replaced.PlanID, asOf); err != nil {
					return err
				}
			}
			if asOf != "" && asOf != timefmt.ShanghaiDayStr(time.Now()) {
				return ErrMasterPlanConflict
			}
			created = row
			return nil
		})
	}
	err = apply()
	// Two first-time applies can both lock the empty key range before either
	// inserts. InnoDB resolves that insert race by deadlocking one transaction.
	// Retry it once so the loser observes the winner's active row and returns the
	// stable domain conflict instead of leaking a transient 500 to the caller.
	if number, ok := mysqlErrNo(err); ok && number == 1213 {
		err = apply()
	}
	if err != nil {
		return nil, nil, err
	}
	return created, replaced, nil
}

// cleanupReplacedMasterPlanTx removes only later weeks owned by the confirmed
// old season. Current and finished weeks remain history, and unrelated plans
// are never implicitly replaced.
func cleanupReplacedMasterPlanTx(tx *gorm.DB, uid, oldID, today string) error {
	day, err := time.Parse("2006-01-02", today)
	if err != nil {
		return fmt.Errorf("storage: invalid activation day: %w", err)
	}
	monday := day.AddDate(0, 0, -int((day.Weekday()+6)%7)).Format("2006-01-02")
	var weeks []WeeklyPlan
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("user_id = ? AND master_plan_id = ? AND week_start > ?", uid, oldID, monday).Find(&weeks).Error; err != nil {
		return fmt.Errorf("storage: lock old future weeks: %w", err)
	}
	for _, week := range weeks {
		// Archive workouts by their exact old weekly identity, not by date; an
		// independent/custom workout on the same day must remain untouched.
		if err := tx.Model(&Workout{}).Where("user_id = ? AND source = ? AND status = ? AND plan_id = ?", uid, WorkoutSourceWeekly, WorkoutStatusActive, week.PlanID).Update("status", WorkoutStatusArchived).Error; err != nil {
			return fmt.Errorf("storage: archive old future workouts: %w", err)
		}
		if err := tx.Where("user_id = ? AND plan_id = ?", uid, week.PlanID).Delete(&WeeklyPlan{}).Error; err != nil {
			return fmt.Errorf("storage: delete old future week: %w", err)
		}
	}
	if err := tx.Model(&PlanAdjustment{}).Where("user_id = ? AND status = ?", uid, PlanAdjustmentStatusPending).Update("status", PlanAdjustmentStatusSuperseded).Error; err != nil {
		return fmt.Errorf("storage: supersede pending adjustments: %w", err)
	}
	return nil
}

// Link the stored content to the actual row even when a proposed ID collided.
func linkMasterPlanContent(content, planID string, requireID bool) (string, error) {
	var document map[string]any
	if err := json.Unmarshal([]byte(content), &document); err != nil || document == nil {
		return content, nil // legacy import
	}
	old, exists := document["master_plan_id"]
	if !exists && !requireID || old == planID {
		return content, nil
	}
	document["master_plan_id"] = planID
	encoded, err := json.Marshal(document)
	if err != nil {
		return "", fmt.Errorf("storage: link master plan content: %w", err)
	}
	return string(encoded), nil
}

// adoptProspectiveMasterPlanID selects the candidate's UUID when available.
// Missing, invalid or colliding IDs fall back to a fresh UUID; the transaction
// rewrites the stored content and links every applied week to the actual ID.
func adoptProspectiveMasterPlanID(tx *gorm.DB, content string) (string, error) {
	fallback := uuid.NewString()
	var document struct {
		MasterPlanID string `json:"master_plan_id"`
	}
	if err := json.Unmarshal([]byte(content), &document); err != nil {
		// Not JSON (or unreadable): the prospective-id contract is absent, not
		// violated — silently keep the generated-id behaviour.
		return fallback, nil
	}
	candidate := strings.TrimSpace(document.MasterPlanID)
	if candidate == "" {
		return fallback, nil
	}
	id, err := uuid.Parse(candidate)
	if err != nil {
		return fallback, nil
	}
	var collisions int64
	if err := tx.Model(&MasterPlan{}).Where("plan_id = ?", id.String()).Count(&collisions).Error; err != nil {
		return "", fmt.Errorf("storage: check prospective master plan id: %w", err)
	}
	if collisions > 0 {
		return fallback, nil
	}
	return id.String(), nil
}

// UpdateActiveMasterPlan revises the athlete's active structured master plan in
// place: the same plan_id keeps its identity and only the content, goal and
// revision (revision + 1) change. The caller must supply the exact active plan
// id + revision it confirmed editing (optimistic concurrency); a mismatch, a
// nil-revision legacy markdown active row, or a missing active plan all fail
// closed. All rows for the user are locked so the revision bump is serialized
// against concurrent applies and updates.
func (s *Store) UpdateActiveMasterPlan(
	ctx context.Context, userID, goalID, content string, expectation *MasterPlanReplacement,
) (*MasterPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(goalID); err != nil {
		return nil, fmt.Errorf("storage: invalid goal_id: %w", err)
	}
	if strings.TrimSpace(content) == "" {
		return nil, fmt.Errorf("storage: content cannot be empty")
	}
	if expectation == nil {
		return nil, fmt.Errorf("storage: update requires the confirmed active plan id and revision")
	}

	var updated *MasterPlan
	update := func() error {
		updated = nil
		return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var rows []MasterPlan
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("user_id = ?", uid).
				Order("revision DESC, created_at DESC").
				Find(&rows).Error; err != nil {
				return fmt.Errorf("storage: lock master plans: %w", err)
			}

			var active *MasterPlan
			for i := range rows {
				if rows[i].Status == MasterPlanStatusActive {
					active = &rows[i]
				}
			}
			if active == nil {
				return ErrMasterPlanNotFound
			}
			if active.PlanID != expectation.PlanID || active.Revision == nil || *active.Revision != expectation.Revision {
				return ErrMasterPlanConflict
			}

			now := time.Now().UTC().Truncate(time.Millisecond)
			newRevision := *active.Revision + 1
			result := tx.Model(&MasterPlan{}).
				Where("plan_id = ? AND user_id = ? AND status = ? AND revision = ?", active.PlanID, uid, MasterPlanStatusActive, active.Revision).
				Updates(map[string]any{
					"goal_id":    goalID,
					"content":    content,
					"revision":   newRevision,
					"updated_at": now,
				})
			if result.Error != nil {
				return fmt.Errorf("storage: update master plan: %w", result.Error)
			}
			if result.RowsAffected != 1 {
				return ErrMasterPlanConflict
			}
			active.GoalID = goalID
			active.Content = content
			active.Revision = &newRevision
			active.UpdatedAt = now
			updated = active
			return nil
		})
	}
	err = update()
	// Mirror the apply path: a concurrent update/apply on the same user rows can
	// deadlock inside InnoDB; retry once so the loser re-reads the current active
	// row and returns the stable domain conflict instead of a transient 500.
	if number, ok := mysqlErrNo(err); ok && number == 1213 {
		err = update()
	}
	if err != nil {
		return nil, err
	}
	return updated, nil
}
