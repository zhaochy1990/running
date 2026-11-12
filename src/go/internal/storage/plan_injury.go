package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// #858 PR-D 伤病模式存储（票面 Q11/Q14 定稿语义）：
//
// 进入（EnterInjuryState，四选一）——continue 只写履历并保证无 active 行；
// reduced/rest 建（或覆盖）active 行；undecided 进 pending_doctor（不带
// maintenance_km）。恢复跟踪（AnswerDailyCheckin，不设静默期，每天一答幂等）：
// recovered 删 active 行（留履历）；worse 置 needs_verdict（mode 不变，要求
// 重新四选一——重新走 enter）；better/same 只记履历（**不改 maintenance_km**：
// 重估单一真源在 TS 的 maintenance job，票面 Q14 拍板「Go 只存 TS 传回的值」，
// 避免 checkin ×1.1 与 job 重估双轨抬量）。待定（AnswerPendingDoctor）每天问
// 「医生怎么说」直到三选一：continue 删行；reduced/rest 转模式。

// ErrInjuryNotFound means no active injury row matched.
var ErrInjuryNotFound = errors.New("storage: plan injury state not found")

// ErrInjuryState is a state-transition guard violation (e.g. answering a
// doctor verdict on a non-pending row, or writing maintenance km on a rest row).
var ErrInjuryState = errors.New("storage: plan injury state violation")

// ErrInjuryVerdict / ErrInjuryCheckin are invalid enum inputs.
var (
	ErrInjuryVerdict = errors.New("storage: invalid injury verdict")
	ErrInjuryCheckin = errors.New("storage: invalid injury checkin answer")
)

func isValidInjuryVerdict(verdict string) bool {
	switch verdict {
	case PlanInjuryVerdictContinue, PlanInjuryVerdictReduced, PlanInjuryVerdictRest, PlanInjuryVerdictUndecided:
		return true
	}
	return false
}

func isValidInjuryCheckin(answer string) bool {
	switch answer {
	case PlanInjuryCheckinBetter, PlanInjuryCheckinSame, PlanInjuryCheckinWorse, PlanInjuryCheckinRecovered:
		return true
	}
	return false
}

// normalizeInjuryDay 归一 DATE 列回读值：parseTime DSN 下 gorm 把 DATE 扫成
// RFC3339 字符串（同 plan_adjustment.event_week_start 的已知坑），幂等比较与
// API 透传统一截断成 YYYY-MM-DD（前 10 字符）。
func normalizeInjuryDay(day *string) *string {
	if day == nil {
		return nil
	}
	if len(*day) > 10 {
		truncated := (*day)[:10]
		return &truncated
	}
	return day
}

// normalizeInjuryState 归一行上的 DATE 字段（读出后统一调用）。
func normalizeInjuryState(row *PlanInjuryState) *PlanInjuryState {
	if row == nil {
		return nil
	}
	row.LastCheckinDay = normalizeInjuryDay(row.LastCheckinDay)
	return row
}

func (s *Store) AutoMigratePlanInjury(ctx context.Context) error {
	db := s.db.WithContext(ctx)
	if err := db.Migrator().AutoMigrate(&PlanInjuryState{}, &PlanInjuryCheckin{}); err != nil {
		return fmt.Errorf("storage: migrate plan_injury: %w", err)
	}
	return nil
}

func (s *Store) insertInjuryCheckin(ctx context.Context, tx *gorm.DB, userID, kind, answer, note string) error {
	row := PlanInjuryCheckin{
		ID: uuid.NewString(), UserID: userID,
		Day: timefmt.ShanghaiDayStr(time.Now()), Kind: kind, Answer: answer,
		CreatedAt: time.Now().UTC(),
	}
	if note != "" {
		quoted := note
		row.Note = &quoted
	}
	if err := tx.WithContext(ctx).Create(&row).Error; err != nil {
		return fmt.Errorf("storage: insert injury checkin: %w", err)
	}
	return nil
}

// EnterInjuryState records the four-way self verdict (进入/重新自判):
//   - continue → checkin history only; any active row is closed (deleted) —
//     「能继续练」= 照旧不调，伤病状态仅记录；
//   - undecided → active row in pending_doctor mode (maintenance_km cleared);
//   - reduced/rest → active row created or overwritten (mode/detail reset,
//     maintenance_km/last_checkin/needs_verdict re-baselined — the TS job
//     re-derives the anchor on its next nightly pass).
func (s *Store) EnterInjuryState(ctx context.Context, userID, masterPlanID, detail, verdict string) (*PlanInjuryState, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(masterPlanID); err != nil {
		return nil, fmt.Errorf("storage: master_plan_id must be a UUID: %w", err)
	}
	if !isValidInjuryVerdict(verdict) {
		return nil, ErrInjuryVerdict
	}
	now := time.Now().UTC()
	var out *PlanInjuryState
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if verdict == PlanInjuryVerdictContinue {
			// 继续练：不留 active 行（已有则关闭——例如从 pending_doctor 回到继续）。
			if err := tx.Where("user_id = ?", uid).Delete(&PlanInjuryState{}).Error; err != nil {
				return fmt.Errorf("storage: close injury on continue: %w", err)
			}
			if err := s.insertInjuryCheckin(ctx, tx, uid, "verdict", verdict, detail); err != nil {
				return err
			}
			return nil
		}
		mode := verdict
		if verdict == PlanInjuryVerdictUndecided {
			mode = PlanInjuryModePendingDoctor
		}
		row := PlanInjuryState{}
		err := tx.Where("user_id = ?", uid).Clauses(clause.Locking{Strength: "UPDATE"}).First(&row).Error
		switch {
		case err == nil:
			// 覆盖：重判后重新基线化（锚交 TS 夜检重估）。
			if err := tx.Model(&PlanInjuryState{}).Where("user_id = ?", uid).Updates(map[string]any{
				"master_plan_id": masterPlanID, "mode": mode, "detail": detail,
				"maintenance_km": nil, "last_checkin_day": nil, "last_checkin_answer": nil,
				"needs_verdict": false, "updated_at": now,
			}).Error; err != nil {
				return fmt.Errorf("storage: overwrite injury state: %w", err)
			}
		case errors.Is(err, gorm.ErrRecordNotFound):
			row = PlanInjuryState{
				UserID: uid, MasterPlanID: masterPlanID, Mode: mode, Detail: detail,
				NeedsVerdict: false, CreatedAt: now, UpdatedAt: now,
			}
			if err := tx.Create(&row).Error; err != nil {
				return fmt.Errorf("storage: create injury state: %w", err)
			}
		default:
			return fmt.Errorf("storage: load injury state: %w", err)
		}
		if err := s.insertInjuryCheckin(ctx, tx, uid, "verdict", verdict, detail); err != nil {
			return err
		}
		loaded := PlanInjuryState{}
		if err := tx.Where("user_id = ?", uid).First(&loaded).Error; err != nil {
			return fmt.Errorf("storage: reload injury state: %w", err)
		}
		out = normalizeInjuryState(&loaded)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// AnswerDailyCheckin records the daily recovery answer (每天首次打开轻问).
// State transitions: recovered → active row deleted (history kept, returns
// nil); worse → needs_verdict=1 (mode unchanged); better/same → history only
// (maintenance_km untouched — single source of truth is the TS reestimate).
// Same-day re-answers are idempotent: last_checkin_day=today → return as-is.
func (s *Store) AnswerDailyCheckin(ctx context.Context, userID, answer string) (*PlanInjuryState, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if !isValidInjuryCheckin(answer) {
		return nil, ErrInjuryCheckin
	}
	today := timefmt.ShanghaiDayStr(time.Now())
	var out *PlanInjuryState
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row := PlanInjuryState{}
		if err := tx.Where("user_id = ?", uid).Clauses(clause.Locking{Strength: "UPDATE"}).First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrInjuryNotFound
			}
			return fmt.Errorf("storage: load injury state: %w", err)
		}
		// 每天一答幂等：当天已答 → 直接返回当前态（不重复记履历）。DATE 列
		// 回读可能是 RFC3339 形状——先归一再比。
		normalizedToday := normalizeInjuryDay(row.LastCheckinDay)
		if normalizedToday != nil && *normalizedToday == today {
			out = normalizeInjuryState(&row)
			return nil
		}
		if err := s.insertInjuryCheckin(ctx, tx, uid, "daily", answer, ""); err != nil {
			return err
		}
		if answer == PlanInjuryCheckinRecovered {
			// 恢复 → 退出模式（删 active 行留履历；之后按滚动机制接回）。
			if err := tx.Where("user_id = ?", uid).Delete(&PlanInjuryState{}).Error; err != nil {
				return fmt.Errorf("storage: close injury on recovered: %w", err)
			}
			return nil
		}
		updates := map[string]any{
			"last_checkin_day": today, "last_checkin_answer": answer, "updated_at": time.Now().UTC(),
		}
		if answer == PlanInjuryCheckinWorse {
			updates["needs_verdict"] = true
		}
		if err := tx.Model(&PlanInjuryState{}).Where("user_id = ?", uid).Updates(updates).Error; err != nil {
			return fmt.Errorf("storage: answer injury checkin: %w", err)
		}
		loaded := PlanInjuryState{}
		if err := tx.Where("user_id = ?", uid).First(&loaded).Error; err != nil {
			return fmt.Errorf("storage: reload injury state: %w", err)
		}
		out = normalizeInjuryState(&loaded)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// AnswerPendingDoctor resolves the pending_doctor mode with the doctor's
// verdict (三选一: continue/reduced/rest). continue closes the row (nil
// return); the others transition the mode and re-baseline the anchor.
func (s *Store) AnswerPendingDoctor(ctx context.Context, userID, verdict string) (*PlanInjuryState, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if verdict != PlanInjuryVerdictContinue && verdict != PlanInjuryVerdictReduced && verdict != PlanInjuryVerdictRest {
		return nil, ErrInjuryVerdict
	}
	now := time.Now().UTC()
	var out *PlanInjuryState
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row := PlanInjuryState{}
		if err := tx.Where("user_id = ?", uid).Clauses(clause.Locking{Strength: "UPDATE"}).First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrInjuryNotFound
			}
			return fmt.Errorf("storage: load injury state: %w", err)
		}
		if row.Mode != PlanInjuryModePendingDoctor {
			return ErrInjuryState
		}
		if err := s.insertInjuryCheckin(ctx, tx, uid, "doctor", verdict, ""); err != nil {
			return err
		}
		if verdict == PlanInjuryVerdictContinue {
			if err := tx.Where("user_id = ?", uid).Delete(&PlanInjuryState{}).Error; err != nil {
				return fmt.Errorf("storage: close injury on doctor continue: %w", err)
			}
			return nil
		}
		if err := tx.Model(&PlanInjuryState{}).Where("user_id = ?", uid).Updates(map[string]any{
			"mode": verdict, "maintenance_km": nil, "needs_verdict": false, "updated_at": now,
		}).Error; err != nil {
			return fmt.Errorf("storage: apply doctor verdict: %w", err)
		}
		loaded := PlanInjuryState{}
		if err := tx.Where("user_id = ?", uid).First(&loaded).Error; err != nil {
			return fmt.Errorf("storage: reload injury state: %w", err)
		}
		out = normalizeInjuryState(&loaded)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// GetInjuryState returns the user's active injury row, or nil when the user is
// not in injury mode (recovered / never entered / continue-only).
func (s *Store) GetInjuryState(ctx context.Context, userID string) (*PlanInjuryState, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	row := PlanInjuryState{}
	err = s.db.WithContext(ctx).Where("user_id = ?", uid).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("storage: load injury state: %w", err)
	}
	return &row, nil
}

// CloseInjuryState deletes the active row (manual/admin close; the recovered
// and doctor-continue paths close inside their own transitions). History rows
// are never touched.
func (s *Store) CloseInjuryState(ctx context.Context, userID string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&PlanInjuryState{}).Error; err != nil {
		return fmt.Errorf("storage: close injury state: %w", err)
	}
	return nil
}

// UpdateInjuryMaintenanceKm writes the re-estimated weekly volume anchor
// (internal channel — the TS maintenance job is the single source of truth for
// reestimation; Go only stores the value). Guarded to reduced mode: rest and
// pending_doctor rows never carry a maintenance volume.
func (s *Store) UpdateInjuryMaintenanceKm(ctx context.Context, userID string, km float64) (*PlanInjuryState, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if km <= 0 || km > 999 {
		return nil, fmt.Errorf("storage: maintenance km out of range: %f", km)
	}
	row := PlanInjuryState{}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", uid).Clauses(clause.Locking{Strength: "UPDATE"}).First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrInjuryNotFound
			}
			return fmt.Errorf("storage: load injury state: %w", err)
		}
		if row.Mode != PlanInjuryModeReduced {
			return ErrInjuryState
		}
		if err := tx.Model(&PlanInjuryState{}).Where("user_id = ?", uid).Updates(map[string]any{
			"maintenance_km": km, "updated_at": time.Now().UTC(),
		}).Error; err != nil {
			return fmt.Errorf("storage: update injury maintenance km: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	loaded := PlanInjuryState{}
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).First(&loaded).Error; err != nil {
		return nil, fmt.Errorf("storage: reload injury state: %w", err)
	}
	return normalizeInjuryState(&loaded), nil
}

// ListInjuryCheckins returns the answer history (newest first) for coach
// context surfaces.
func (s *Store) ListInjuryCheckins(ctx context.Context, userID string, limit int) ([]PlanInjuryCheckin, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows := []PlanInjuryCheckin{}
	err = s.db.WithContext(ctx).Where("user_id = ?", uid).Order("created_at DESC").Limit(limit).Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list injury checkins: %w", err)
	}
	return rows, nil
}
