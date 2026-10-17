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

// Moderation states for feedbacks.mod_text and feedbacks.mod_images values.
// pass/review/risky come from WeChat msgSecCheck / mediaCheckAsync; pending
// marks a dispatched-but-unresolved image check; unchecked marks content that
// was never machine-checked (detection unavailable — it stays readable and is
// flagged 未机检 for the admin queue).
const (
	FeedbackModPass      = "pass"
	FeedbackModReview    = "review"
	FeedbackModRisky     = "risky"
	FeedbackModPending   = "pending"
	FeedbackModUnchecked = "unchecked"
)

// IsFeedbackModState reports whether v is one of the five moderation states.
func IsFeedbackModState(v string) bool {
	switch v {
	case FeedbackModPass, FeedbackModReview, FeedbackModRisky, FeedbackModPending, FeedbackModUnchecked:
		return true
	}
	return false
}

// Feedback is one user-submitted feedback (bug report or suggestion) plus its
// moderation tags. images / mod_images are TEXT columns holding JSON: images
// is an array of COS object keys (≤9, NULL = no images), mod_images a
// {cosKey: state} map updated in place by the wxa_media_check callback.
// adopted_feature_id is one-way (devops#519): once set it can never be
// changed or cleared.
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
	AdoptedFeatureID *uint64 `gorm:"column:adopted_feature_id"`
	// ModText is the msgSecCheck result for the body text; risky text is
	// rejected at the API and never stored.
	ModText string `gorm:"column:mod_text;size:16;not null;default:'unchecked'"`
	// ModImages is the JSON {cosKey: pass|review|risky|pending|unchecked} map,
	// or NULL when there is nothing to check.
	ModImages *string   `gorm:"column:mod_images;type:text"`
	CreatedAt time.Time `gorm:"column:created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at"`
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

// FeedbackImageCheck correlates one dispatched mediaCheckAsync task to its
// feedback row and image key. WeChat echoes the trace_id in the
// wxa_media_check push, and this table is how the push finds its target; the
// row is consumed (deleted) when the result lands. It is bookkeeping, not
// user content — erasure removes it through the feedback cascade.
type FeedbackImageCheck struct {
	// TraceID is the mediaCheckAsync task id (the callback's correlation key).
	TraceID string `gorm:"column:trace_id;size:128;primaryKey"`
	// FeedbackID references feedbacks.id.
	FeedbackID uint64 `gorm:"column:feedback_id;not null;index"`
	// CosKey is the image the trace was opened for.
	CosKey    string    `gorm:"column:cos_key;size:256;not null"`
	CreatedAt time.Time `gorm:"column:created_at"`
}

// TableName pins the table name.
func (FeedbackImageCheck) TableName() string { return "feedback_image_checks" }
