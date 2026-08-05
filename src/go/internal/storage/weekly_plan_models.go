package storage

import "time"

// WeeklyPlan is one candidate or historical plan for an athlete's Shanghai
// calendar week (ADR 0025). ContentVersion discriminates the opaque Content:
// legacy Markdown (1) or structured weekly-plan JSON (2).
//
// StatusSlot is a storage-integrity lever only. It mirrors active/draft and is
// NULL for archived rows so MySQL can enforce at most one active and one draft
// per (user_id, week_start) while retaining any number of archived snapshots.
type WeeklyPlan struct {
	PlanID         string    `gorm:"column:plan_id;primaryKey;size:36"`
	UserID         string    `gorm:"column:user_id;size:64;not null;uniqueIndex:uidx_weekly_plan_status_slot,priority:1"`
	MasterPlanID   *string   `gorm:"column:master_plan_id;size:36;index:idx_weekly_plan_master_plan"`
	WeekStart      string    `gorm:"column:week_start;type:date;not null;uniqueIndex:uidx_weekly_plan_status_slot,priority:2"`
	ContentVersion int8      `gorm:"column:content_version;not null;check:ck_weekly_plan_content_version,content_version IN (1,2)"`
	Content        string    `gorm:"column:content;type:longtext;not null;check:ck_weekly_plan_json,content_version = 1 OR JSON_VALID(content)"`
	Status         string    `gorm:"column:status;size:16;not null;check:ck_weekly_plan_status,status IN ('draft','active','archived')"`
	StatusSlot     *string   `gorm:"column:status_slot;size:8;uniqueIndex:uidx_weekly_plan_status_slot,priority:3;check:ck_weekly_plan_status_slot_v2,(status IN ('active','draft') AND status_slot IS NOT NULL AND status_slot = status) OR (status = 'archived' AND status_slot IS NULL)"`
	Revision       int64     `gorm:"column:revision;not null;check:ck_weekly_plan_revision,revision >= 1"`
	CreatedAt      time.Time `gorm:"column:created_at;type:datetime(3);not null;autoCreateTime:false"`
	UpdatedAt      time.Time `gorm:"column:updated_at;type:datetime(3);not null;autoUpdateTime:false"`
}

func (WeeklyPlan) TableName() string { return "weekly_plan" }

const (
	WeeklyPlanContentMarkdown   int8 = 1
	WeeklyPlanContentStructured int8 = 2
)

const (
	WeeklyPlanStatusDraft    = "draft"
	WeeklyPlanStatusActive   = "active"
	WeeklyPlanStatusArchived = "archived"
)
