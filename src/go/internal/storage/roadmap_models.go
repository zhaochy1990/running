package storage

import "time"

// RoadmapFeature status values — the one-way product-roadmap pipeline (see
// CONTEXT.md 「产品路线（Roadmap）」 and devops#515's resolution). Transitions
// only move forward (skipping allowed: draft→released is legal); a backward
// move is a 422 at the API. released freezes the vote count into
// votes_snapshot; every other state leaves it at 0 (votes stay live COUNTs).
const (
	// RoadmapStatusDraft is 草稿 — invisible to users, admin-only.
	RoadmapStatusDraft = "draft"
	// RoadmapStatusBacklog is 待投票 — the only votable state.
	RoadmapStatusBacklog = "backlog"
	// RoadmapStatusAccepted is 已排期 — votes stay live, planned_note shows.
	RoadmapStatusAccepted = "accepted"
	// RoadmapStatusReleased is 已上线 — terminal; released_at + votes_snapshot
	// are written server-side on the transition and never rolled back.
	RoadmapStatusReleased = "released"
)

// IsRoadmapFeatureStatus reports whether v is one of the four roadmap status
// tokens — the closed vocabulary a write body is validated against, so a typo
// cannot silently invent a fifth state.
func IsRoadmapFeatureStatus(v string) bool {
	switch v {
	case RoadmapStatusDraft, RoadmapStatusBacklog, RoadmapStatusAccepted, RoadmapStatusReleased:
		return true
	}
	return false
}

// roadmapStatusRank orders the one-way pipeline: a transition is legal only
// when the target rank is greater than the current one (equal = no-op).
func roadmapStatusRank(status string) int {
	switch status {
	case RoadmapStatusDraft:
		return 0
	case RoadmapStatusBacklog:
		return 1
	case RoadmapStatusAccepted:
		return 2
	case RoadmapStatusReleased:
		return 3
	}
	return -1
}

// RoadmapCanTransition reports whether the one-way pipeline allows from→to:
// only forward moves, skipping levels included (draft→released is legal);
// from==to is the legal no-op PATCH, backward is refused (422 at the API).
func RoadmapCanTransition(from, to string) bool {
	return roadmapStatusRank(to) > roadmapStatusRank(from)
}

// RoadmapFeature is one product-roadmap item (a feature idea through its
// lifecycle). Global admin-authored content: no user_id column, every user
// sees every non-draft row. There is deliberately no vote-count column —
// counts are live COUNTs over roadmap_votes (immune to drift); only the
// released transition freezes votes_snapshot.
type RoadmapFeature struct {
	ID uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	// Title is the idea name (≤128 chars).
	Title string `gorm:"column:title;size:128;not null"`
	// Description doubles as the backlog idea text and the released launch
	// note — one column per the devops#515 DDL. Markdown is allowed; the
	// miniprogram renders it on the detail page only, never in list rows.
	Description string `gorm:"column:description;size:1024;not null;default:''"`
	// Summary is the ≤50-char plain-text blurb list rows render (概述). Empty
	// is legal (legacy rows) — clients then fall back to a truncated
	// Description, never to the raw markdown.
	Summary string `gorm:"column:summary;size:50;not null;default:''"`
	// Category is a free-text chip (≤8 chars, ≤32 stored); empty = not rendered.
	Category string `gorm:"column:category;size:32;not null;default:''"`
	// Status is one of the RoadmapStatus* tokens.
	Status string `gorm:"column:status;size:16;not null;index"`
	// PlannedNote is the accepted-state free text (「预计 2026.11」); YYYY.MM
	// strings sort chronologically, empty sinks to the bottom at read.
	PlannedNote string `gorm:"column:planned_note;size:32;not null;default:''"`
	// ReleasedAt is written server-side when status→released; NULL otherwise.
	ReleasedAt *time.Time `gorm:"column:released_at"`
	// VotesSnapshot freezes the live vote count at release time and is never
	// rolled back (a historical fact, not per-user data).
	VotesSnapshot uint64    `gorm:"column:votes_snapshot;not null;default:0"`
	CreatedAt     time.Time `gorm:"column:created_at"`
	UpdatedAt     time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize — this one
// already is, but the explicit pin keeps it stable).
func (RoadmapFeature) TableName() string { return "roadmap_features" }

// RoadmapVote is one user's vote on one feature. UNIQUE(user_id, feature_id)
// is the server-side one-person-one-vote guarantee (idempotent re-votes).
type RoadmapVote struct {
	ID uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	// UserID is the voter's canonical UUID; see canonicalUserID.
	UserID string `gorm:"column:user_id;size:64;not null;uniqueIndex:idx_roadmap_votes_user_feature,priority:1"`
	// FeatureID references roadmap_features.id; indexed for the live COUNT.
	FeatureID uint64    `gorm:"column:feature_id;not null;uniqueIndex:idx_roadmap_votes_user_feature,priority:2;index"`
	CreatedAt time.Time `gorm:"column:created_at"`
}

// TableName pins the table name.
func (RoadmapVote) TableName() string { return "roadmap_votes" }
