package storage

import "time"

// PlanInjuryState is the user's ACTIVE injury-mode row (#858 PR-D, 票面 Q11/Q14
// 定稿语义): at most one per user (user_id PK). Entering with verdict=continue
// records history only and leaves NO active row; recovered / doctor-continue
// delete the row (history keeps every answer in plan_injury_checkin).
type PlanInjuryState struct {
	UserID string `gorm:"column:user_id;size:64;primaryKey"`
	// MasterPlanID is the plan the injury mode was entered against (audit
	// context — the maintenance job re-derives the active plan itself).
	MasterPlanID string `gorm:"column:master_plan_id;type:char(36);not null"`
	// Mode: reduced（减量维持课）| rest（完全停，不出课）| pending_doctor
	//（判断不了 → 看医生，待定）。continue 进入即关闭，永不落 active 行。
	Mode string `gorm:"column:mode;size:16;not null;check:ck_plan_injury_mode,mode IN ('reduced','rest','pending_doctor')"`
	// Detail is the free-text injury note (哪里伤/一句话，给教练看).
	Detail string `gorm:"column:detail;size:512;not null"`
	// MaintenanceKm is the reduced-mode weekly volume anchor (维持周量单值锚).
	// 单一真源取舍（票面 Q14 倾向）：Go 只存值——重估全在 TS（maintenance
	// job），经内部 POST /plan-injury/maintenance 回写；Go 的 checkin 不改它。
	MaintenanceKm *float64 `gorm:"column:maintenance_km"`
	// LastCheckinDay/LastCheckinAnswer 是最近一次每日轻问（伤怎么样）——
	// last_checkin_day=今天 → 当天幂等（再答直接返回当前态）。
	LastCheckinDay    *string `gorm:"column:last_checkin_day;type:date"`
	LastCheckinAnswer *string `gorm:"column:last_checkin_answer;size:16"`
	// NeedsVerdict=1：用户答了「加重」，要求重新四选一（mode 不变，维持课照常
	// 驱动）；重新 enter（或 doctor 结论）清零。以显式列表达而非 mode+updated_at
	// 推断——可观测、可索引、不依赖时间语义。
	NeedsVerdict bool      `gorm:"column:needs_verdict;type:tinyint;not null;default:0"`
	CreatedAt    time.Time `gorm:"column:created_at;type:datetime(3);not null;autoCreateTime:false"`
	UpdatedAt    time.Time `gorm:"column:updated_at;type:datetime(3);not null;autoUpdateTime:false"`
}

func (PlanInjuryState) TableName() string { return "plan_injury_state" }

// PlanInjuryCheckin is the append-only answer history (教练上下文 + 审计):
// kind=daily（恢复跟踪轻问）| verdict（进入/重新自判四选一）| doctor（待定期
// 医生结论三选一）。
type PlanInjuryCheckin struct {
	ID     string `gorm:"column:id;size:36;primaryKey"`
	UserID string `gorm:"column:user_id;size:64;not null;index:idx_plan_injury_checkin_user,priority:1"`
	// Day is the Shanghai civil day of the answer (YYYY-MM-DD).
	Day       string    `gorm:"column:day;type:date;not null;index:idx_plan_injury_checkin_user,priority:2"`
	Kind      string    `gorm:"column:kind;size:16;not null;check:ck_plan_injury_checkin_kind,kind IN ('daily','verdict','doctor')"`
	Answer    string    `gorm:"column:answer;size:24;not null"`
	Note      *string   `gorm:"column:note;size:512"`
	CreatedAt time.Time `gorm:"column:created_at;type:datetime(3);not null;autoCreateTime:false"`
}

func (PlanInjuryCheckin) TableName() string { return "plan_injury_checkin" }

const (
	// active-row modes
	PlanInjuryModeReduced       = "reduced"
	PlanInjuryModeRest          = "rest"
	PlanInjuryModePendingDoctor = "pending_doctor"

	// enter verdicts（四选一；continue 不落 active 行）
	PlanInjuryVerdictContinue  = "continue"
	PlanInjuryVerdictReduced   = "reduced"
	PlanInjuryVerdictRest      = "rest"
	PlanInjuryVerdictUndecided = "undecided"

	// daily checkin answers（恢复跟踪轻问）
	PlanInjuryCheckinBetter    = "better"
	PlanInjuryCheckinSame      = "same"
	PlanInjuryCheckinWorse     = "worse"
	PlanInjuryCheckinRecovered = "recovered"
)
