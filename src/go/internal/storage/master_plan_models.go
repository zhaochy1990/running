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
// beyond Status and is never surfaced in the API response. MySQL uses
// UNIQUE(user_id, active_flag) to enforce at most one active plan per athlete:
// it is 1 on the current row and NULL on every draft/archived row. Current-row
// discovery checks both Status and ActiveFlag so either direction of marker
// drift is exposed as an invariant failure.
//
// Revision is the structured plan's mutation counter. It is v2-only, positive,
// and NULL for a markdown row, which has no plan-revision concept.
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
	Status         string    `gorm:"column:status;size:16;not null;check:ck_master_plan_current_marker,(status = 'active' AND active_flag = 1) OR (status <> 'active' AND active_flag IS NULL)"`
	ActiveFlag     *int8     `gorm:"column:active_flag;uniqueIndex:uidx_master_plan_active,priority:2"`
	Revision       *int64    `gorm:"column:revision;check:ck_master_plan_revision,(content_version = 1 AND revision IS NULL) OR (content_version = 2 AND revision >= 1)"`
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
