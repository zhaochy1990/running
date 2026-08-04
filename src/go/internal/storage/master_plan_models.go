package storage

import "time"

// MasterPlan is the athlete's overall season training plan (赛季训练计划), stored
// in one of two content formats discriminated by ContentVersion (ADR 0024):
//
//	ContentVersion = 1  -> legacy markdown overview; Content is the markdown text.
//	ContentVersion = 2  -> structured plan; Content is the MasterPlan JSON blob,
//	                       kept opaque at the storage layer (the API layer
//	                       deserialises it to build the response).
//
// The two formats are the same logical artifact, so they share this one table; a
// v1->v2 upgrade is a row rewrite, not a cross-table move. The nested plan body
// (phases / milestones / weeks / goal) stays a JSON blob in Content rather than
// normalised child tables — the app always whole-loads a plan and never queries
// an inner field, and normalising would force re-implementing all of the Python
// MasterPlan validation in Go/SQL for no query benefit.
//
// ActiveFlag is a STORAGE-INTEGRITY LEVER ONLY. It carries no business meaning
// beyond Status, is never surfaced in the API response, and must never be
// branched on in business logic. Its sole purpose is to let MySQL enforce "at
// most one active plan per athlete" via UNIQUE(user_id, active_flag): it is 1 on
// the single active row and NULL on every draft/archived row (MySQL unique
// indexes do not collide on NULL, so an athlete may have many archived rows but
// only one active). A markdown row is modelled as active (Status="active",
// ActiveFlag=1), so an athlete has at most one current plan *across both
// formats* — reads still filter on Status, not ActiveFlag.
//
// Version is the structured plan's own revision counter (the Python
// MasterPlan.version); it is v2-only and NULL for a markdown row, which has no
// plan-version concept. A CHECK guarantees a v2 row always carries it.
//
// GoalID is a soft reference to race_goal.goal_id (indexed, no FOREIGN KEY,
// matching the house standalone-table style). It is NOT NULL for both formats:
// v2 copies plan.goal.goal_id; v1 has the real goal extracted from the markdown
// at migration time.
//
// CreatedAt/UpdatedAt are carried verbatim from the source at migration
// (domain-owns-time, ADR 0003/0006); for a v2 row the authoritative timestamps
// also live inside Content.
type MasterPlan struct {
	PlanID         string    `gorm:"column:plan_id;primaryKey;size:36"`
	UserID         string    `gorm:"column:user_id;size:64;not null;uniqueIndex:uidx_master_plan_active,priority:1"`
	ContentVersion int8      `gorm:"column:content_version;not null;check:ck_master_plan_content_version,content_version IN (1,2)"`
	Content        string    `gorm:"column:content;type:longtext;not null"`
	GoalID         string    `gorm:"column:goal_id;size:36;not null;index:idx_master_plan_goal"`
	Status         string    `gorm:"column:status;size:16;not null"`
	ActiveFlag     *int8     `gorm:"column:active_flag;uniqueIndex:uidx_master_plan_active,priority:2"`
	Version        *int64    `gorm:"column:version;check:ck_master_plan_v2_version,content_version = 1 OR version IS NOT NULL"`
	CreatedAt      time.Time `gorm:"column:created_at"`
	UpdatedAt      time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (MasterPlan) TableName() string { return "master_plan" }

// MasterPlan content-format discriminators (MasterPlan.ContentVersion).
const (
	MasterPlanContentMarkdown   int8 = 1 // legacy markdown overview
	MasterPlanContentStructured int8 = 2 // structured MasterPlan JSON
)

// MasterPlan status values (mirror stride_core MasterPlanStatus).
const (
	MasterPlanStatusDraft    = "draft"
	MasterPlanStatusActive   = "active"
	MasterPlanStatusArchived = "archived"
)
