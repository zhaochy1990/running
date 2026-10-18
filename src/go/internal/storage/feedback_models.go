package storage

import "time"

// Feedback type values — closed vocabulary (devops#519 resolution); a write
// body is validated against IsFeedbackType so a typo cannot invent a third
// kind.
const (
	FeedbackTypeBug        = "bug"
	FeedbackTypeSuggestion = "suggestion"
)

// IsFeedbackType reports whether v is one of the two feedback kinds.
func IsFeedbackType(v string) bool {
	return v == FeedbackTypeBug || v == FeedbackTypeSuggestion
}

// Feedback status values — open → replied (automatic on an admin reply while
// open) → closed (admin only); a user reply never changes the status and a
// closed feedback refuses replies (409 feedback_closed at the API).
const (
	FeedbackStatusOpen    = "open"
	FeedbackStatusReplied = "replied"
	FeedbackStatusClosed  = "closed"
)

// IsFeedbackStatus reports whether v is one of the three lifecycle states.
func IsFeedbackStatus(v string) bool {
	switch v {
	case FeedbackStatusOpen, FeedbackStatusReplied, FeedbackStatusClosed:
		return true
	}
	return false
}

// Feedback reply authors. The official line is signed「STRIDE 团队」at render
// time; no personal identity is ever stored on admin rows.
const (
	FeedbackAuthorUser  = "user"
	FeedbackAuthorAdmin = "admin"
)

// Feedback is one user-submitted feedback (bug report or suggestion).
// images is a TEXT column holding a JSON array of COS object keys (≤9,
// NULL = no images). adopted_feature_id is one-way (devops#519): once set it
// can never be changed or cleared. The legacy mod_text/mod_images moderation
// columns stay in MySQL as dead columns (devops#608); GORM no longer maps
// them.
type Feedback struct {
	ID uint64 `gorm:"column:id;primaryKey;autoIncrement;index:idx_feedbacks_user_id,priority:2"`
	// UserID is the canonical UUID of the submitter.
	UserID string `gorm:"column:user_id;size:64;not null;index:idx_feedbacks_user_id,priority:1"`
	// Type is bug | suggestion.
	Type string `gorm:"column:type;size:16;not null"`
	// Content is the body text, ≤1000 chars.
	Content string `gorm:"column:content;size:1000;not null"`
	// Images is the JSON array of COS keys (≤9), or NULL when the feedback
	// carries no images.
	Images *string `gorm:"column:images;type:text"`
	// ClientVersion is the silently-collected app version (never displayed).
	ClientVersion string `gorm:"column:client_version;size:32;not null;default:''"`
	// Status is open | replied | closed.
	Status string `gorm:"column:status;size:16;not null;index"`
	// AdoptedFeatureID references roadmap_features.id; one-way, never cleared.
	AdoptedFeatureID *uint64   `gorm:"column:adopted_feature_id"`
	CreatedAt        time.Time `gorm:"column:created_at"`
	UpdatedAt        time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name.
func (Feedback) TableName() string { return "feedbacks" }

// FeedbackReply is one turn of the two-way thread under a feedback. is_read is
// only meaningful on admin rows: the user's detail read batch-clears them
// (读即清), which is the entire unread-badge mechanism — there is no separate
// cursor column.
type FeedbackReply struct {
	ID uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	// FeedbackID references feedbacks.id; replies die with their feedback.
	FeedbackID uint64 `gorm:"column:feedback_id;not null;index"`
	// Author is user | admin.
	Author string `gorm:"column:author;size:8;not null"`
	// Content is the reply text, ≤1000 chars.
	Content string `gorm:"column:content;size:1000;not null"`
	// IsRead marks unread admin replies; the owner's detail read clears them.
	IsRead    bool      `gorm:"column:is_read;not null;default:false"`
	CreatedAt time.Time `gorm:"column:created_at"`
}

// TableName pins the table name.
func (FeedbackReply) TableName() string { return "feedback_replies" }
