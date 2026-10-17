package storage

import "time"

// WeeklyPlan is the applied plan for an athlete's Shanghai calendar week
// (ADR 0025). ContentVersion discriminates the opaque Content: legacy Markdown
// (1) or structured weekly-plan JSON (2).
//
// #585 convergence: UNIQUE(user_id, week_start) — a row's existence means the
// week's plan was applied; re-applying the same week overwrites it (old row
// deleted, new row inserted). The draft intermediate state is gone.
//
// StatusSlot is a legacy storage marker kept in sync (always 'active'); it no
// longer participates in any index.
type WeeklyPlan struct {
	PlanID         string    `gorm:"column:plan_id;primaryKey;size:36"`
	UserID         string    `gorm:"column:user_id;size:64;not null;uniqueIndex:uidx_weekly_plan_week,priority:1"`
	MasterPlanID   *string   `gorm:"column:master_plan_id;size:36;index:idx_weekly_plan_master_plan"`
	WeekStart      string    `gorm:"column:week_start;type:date;not null;uniqueIndex:uidx_weekly_plan_week,priority:2"`
	ContentVersion int8      `gorm:"column:content_version;not null;check:ck_weekly_plan_content_version,content_version IN (1,2)"`
	Content        string    `gorm:"column:content;type:longtext;not null;check:ck_weekly_plan_json,content_version = 1 OR JSON_VALID(content)"`
	Status         string    `gorm:"column:status;size:16;not null;check:ck_weekly_plan_status_v3,status = 'active'"`
	StatusSlot     *string   `gorm:"column:status_slot;size:8;not null;check:ck_weekly_plan_status_slot_v3,status_slot = 'active'"`
	Revision       int64     `gorm:"column:revision;not null;check:ck_weekly_plan_revision,revision >= 1"`
	CreatedAt      time.Time `gorm:"column:created_at;type:datetime(3);not null;autoCreateTime:false"`
	UpdatedAt      time.Time `gorm:"column:updated_at;type:datetime(3);not null;autoUpdateTime:false"`
}

func (WeeklyPlan) TableName() string { return "weekly_plan" }

const (
	WeeklyPlanContentMarkdown   int8 = 1
	WeeklyPlanContentStructured int8 = 2
)

// WeeklyPlanStatusActive is the only weekly-plan status (#585): a row exists
// exactly when its week's plan is applied.
const WeeklyPlanStatusActive = "active"
