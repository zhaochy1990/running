package storage

import "time"

// PlanAdjustment is one deviation-adjustment proposal (#858 PR-C): the nightly
// scan (or the rolling worker) records what it detected about a completed
// week, pre-generates the adjusted remaining weeks into payload, and the
// athlete answers in the mini-program popup — accept applies the payload's
// weekly docs, dismiss closes the event (the same event week is never asked
// again; the next batch-boundary rolling silently absorbs reality instead).
type PlanAdjustment struct {
	ID string `gorm:"column:id;primaryKey;size:36"`
	// UserID is the athlete (JWT sub / canonical user id, size:64 同 weekly_plan).
	UserID string `gorm:"column:user_id;size:64;not null;index:idx_plan_adjustment_user_status,priority:1"`
	// MasterPlanID links the plan the proposal was generated against (prospective
	// id adopted by the master row at apply time — same value weekly rows use).
	MasterPlanID string `gorm:"column:master_plan_id;size:36;not null"`
	// EventWeekStart is the deviation week's Monday (YYYY-MM-DD): the event key.
	// A row for the same (user, event week) in a terminal state (accepted or
	// dismissed) means the event is closed — never re-proposed.
	EventWeekStart string `gorm:"column:event_week_start;type:date;not null;index:idx_plan_adjustment_event,priority:2"`
	// Reason is the currently-held cause (preselect initially; the user's final
	// answer once chosen). Enum: pace_unmet|volume_unmet|no_time|injured|
	// ran_other|over_delivered (contract ADJUST_REASONS).
	Reason string `gorm:"column:reason;size:24;not null"`
	// Status: pending (popup visible) | accepted | dismissed | superseded
	// (a newer pending replaced it). At most one pending per user.
	Status string `gorm:"column:status;size:16;not null;index:idx_plan_adjustment_user_status,priority:2;check:ck_plan_adjustment_status,status IN ('pending','accepted','dismissed','superseded')"`
	// Payload is the AdjustProposalPayload JSON (weekly docs + diff + evidence);
	// NULL means a reason change triggered regeneration and the worker has not
	// refilled it yet (mp shows the generating state).
	Payload *string `gorm:"column:payload;type:longtext;check:ck_plan_adjustment_payload,status != 'pending' OR JSON_VALID(payload)"`
	// Question is the popup headline (deviation evidence phrased as a question).
	Question string `gorm:"column:question;size:512;not null"`
	CreatedAt time.Time `gorm:"column:created_at;type:datetime(3);not null;autoCreateTime:false"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:datetime(3);not null;autoUpdateTime:false"`
}

func (PlanAdjustment) TableName() string { return "plan_adjustment" }

const (
	PlanAdjustmentStatusPending    = "pending"
	PlanAdjustmentStatusAccepted   = "accepted"
	PlanAdjustmentStatusDismissed  = "dismissed"
	PlanAdjustmentStatusSuperseded = "superseded"
)
