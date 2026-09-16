package storage

import (
	"slices"
	"time"
)

// LegalDocument is one version of a compliance declaration (用户协议 / 隐私政策 /
// 儿童个人信息保护规则 / 个人信息收集清单 / 第三方信息共享清单). One row = one
// version of one declaration type; the table is append-versioned.
//
// There is deliberately NO "current version" flag column. The live version of a
// doc_type is the published row with the highest Version, which holds because
// Version is allocated as max(version)+1 per doc_type and publishing is the only
// transition into the published status. A marker column would be a second source
// of truth to keep in sync inside a transaction, for no query benefit.
//
// At most one draft exists per doc_type. That is enforced in the create
// transaction (a second create returns ErrLegalDraftExists) rather than by a DB
// constraint, because "at most one WHERE status='draft'" cannot be expressed as a
// plain unique index without inventing a NULL-marker column. The create
// transaction locks every row of the doc_type, so the rule and the next version
// number are decided under one lock. A draft is therefore always the highest
// version of its type — which is what makes the max(version) rule above hold.
//
// Published rows are immutable: a correction is a new draft created from the old
// content and then published, so every version that was ever live stays on disk
// unchanged (the audit property the compliance review requires).
//
// ContentMarkdown holds the raw Markdown. The admin dashboard previews it with
// react-markdown; the public API returns it verbatim.
type LegalDocument struct {
	ID              string     `gorm:"column:id;primaryKey;size:36"`
	DocType         string     `gorm:"column:doc_type;size:64;not null;uniqueIndex:uidx_legal_documents_type_version,priority:1;index:idx_legal_documents_type_status_version,priority:1"`
	Version         int        `gorm:"column:version;not null;uniqueIndex:uidx_legal_documents_type_version,priority:2;index:idx_legal_documents_type_status_version,priority:3"`
	Title           string     `gorm:"column:title;size:255;not null"`
	ContentMarkdown string     `gorm:"column:content_markdown;type:mediumtext;not null"`
	Status          string     `gorm:"column:status;size:16;not null;index:idx_legal_documents_type_status_version,priority:2"`
	EffectiveAt     *time.Time `gorm:"column:effective_at"`
	PublishedAt     *time.Time `gorm:"column:published_at"`
	CreatedBy       string     `gorm:"column:created_by;size:64;not null"`
	CreatedAt       time.Time  `gorm:"column:created_at"`
	UpdatedAt       time.Time  `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (LegalDocument) TableName() string { return "legal_documents" }

// LegalDocument status values (LegalDocument.Status).
const (
	LegalDocumentStatusDraft     = "draft"
	LegalDocumentStatusPublished = "published"
)

// LegalDocumentTypes is the canonical ordered list of supported declaration
// types. Readers iterate it (rather than DISTINCT doc_type) so the admin list
// shows all five rows — and the dashboard can create the first draft of each —
// while the table is still empty on a fresh deployment.
var LegalDocumentTypes = []string{
	"user_agreement",
	"privacy_policy",
	"child_protection",
	"personal_info_collection",
	"third_party_sharing",
}

// IsLegalDocumentType reports whether docType is one of LegalDocumentTypes.
func IsLegalDocumentType(docType string) bool {
	return slices.Contains(LegalDocumentTypes, docType)
}
