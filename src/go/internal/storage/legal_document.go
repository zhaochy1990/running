package storage

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	// ErrLegalDocumentNotFound means no row matched the requested id/type.
	ErrLegalDocumentNotFound = errors.New("storage: legal document not found")
	// ErrLegalDraftExists means the doc_type already has an unpublished draft.
	ErrLegalDraftExists = errors.New("storage: legal document already has a draft")
	// ErrLegalDocumentImmutable means the target row is published. Published
	// versions are the compliance record and are never edited or deleted.
	ErrLegalDocumentImmutable = errors.New("storage: legal document is published")
	// ErrLegalDocumentConflict means a concurrent create won the version number.
	ErrLegalDocumentConflict = errors.New("storage: legal document version conflict")
	// ErrInvalidLegalDocument means the doc_type, title or content is unusable.
	ErrInvalidLegalDocument = errors.New("storage: invalid legal document")
)

// legalDocumentMetaColumns is the projection for list queries: everything but
// the Markdown body. Version history is browsed per type, so shipping every
// historical body on each list request would be pure waste — the body is only
// loaded for the single version a reader actually opened.
const legalDocumentMetaColumns = "id, doc_type, version, title, status, effective_at, published_at, created_by, created_at, updated_at"

// AutoMigrateLegalDocuments creates or reconciles the legal_documents schema.
func (s *Store) AutoMigrateLegalDocuments(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&LegalDocument{}); err != nil {
		return fmt.Errorf("storage: automigrate legal_documents: %w", err)
	}
	return nil
}

// ListCurrentLegalDocuments returns the live (published, highest-version) row of
// every doc_type that has one, without the Markdown body. Types with no
// published version are simply absent — callers merge the result against
// LegalDocumentTypes to render the full five-row list.
func (s *Store) ListCurrentLegalDocuments(ctx context.Context) ([]LegalDocument, error) {
	db := s.db.WithContext(ctx)
	newestPerType := db.Model(&LegalDocument{}).
		Select("doc_type, MAX(version) AS version").
		Where("status = ?", LegalDocumentStatusPublished).
		Group("doc_type")
	var rows []LegalDocument
	if err := db.Model(&LegalDocument{}).
		Select(legalDocumentMetaColumns).
		Where("status = ?", LegalDocumentStatusPublished).
		Where("(doc_type, version) IN (?)", newestPerType).
		Order("doc_type").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list current legal documents: %w", err)
	}
	return rows, nil
}

// ListLegalDocumentDrafts returns every unpublished draft (at most one per
// doc_type), without the Markdown body. The admin list needs only the draft's
// identity to mark a row as having work in progress.
func (s *Store) ListLegalDocumentDrafts(ctx context.Context) ([]LegalDocument, error) {
	var rows []LegalDocument
	if err := s.db.WithContext(ctx).Model(&LegalDocument{}).
		Select(legalDocumentMetaColumns).
		Where("status = ?", LegalDocumentStatusDraft).
		Order("doc_type").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list legal document drafts: %w", err)
	}
	return rows, nil
}

// GetCurrentLegalDocument returns the live version of docType including the
// Markdown body, or nil when the type has never been published.
func (s *Store) GetCurrentLegalDocument(ctx context.Context, docType string) (*LegalDocument, error) {
	var row LegalDocument
	err := s.db.WithContext(ctx).
		Where("doc_type = ? AND status = ?", docType, LegalDocumentStatusPublished).
		Order("version DESC").
		First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("storage: get current legal document: %w", err)
	}
	return &row, nil
}

// ListLegalDocumentVersions returns the full version history of docType, newest
// first, without the Markdown bodies.
func (s *Store) ListLegalDocumentVersions(ctx context.Context, docType string) ([]LegalDocument, error) {
	var rows []LegalDocument
	if err := s.db.WithContext(ctx).Model(&LegalDocument{}).
		Select(legalDocumentMetaColumns).
		Where("doc_type = ?", docType).
		Order("version DESC").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list legal document versions: %w", err)
	}
	return rows, nil
}

// GetLegalDocument returns one version by id including the Markdown body, or nil
// when the id does not exist.
func (s *Store) GetLegalDocument(ctx context.Context, id string) (*LegalDocument, error) {
	var row LegalDocument
	err := s.db.WithContext(ctx).Where("id = ?", id).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("storage: get legal document: %w", err)
	}
	return &row, nil
}

// CreateLegalDocumentDraft appends the next version of docType as a draft.
//
// Every row of the doc_type is locked first, so the "at most one draft" rule and
// the next version number are decided under one lock; a second concurrent create
// therefore observes the winner's draft and returns ErrLegalDraftExists rather
// than minting a duplicate version.
func (s *Store) CreateLegalDocumentDraft(ctx context.Context, docType, title, content, createdBy string) (*LegalDocument, error) {
	if !IsLegalDocumentType(docType) {
		return nil, fmt.Errorf("%w: unknown doc_type %q", ErrInvalidLegalDocument, docType)
	}
	title, err := normalizeDraft(title, content)
	if err != nil {
		return nil, err
	}

	var created *LegalDocument
	create := func() error {
		created = nil
		return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var rows []LegalDocument
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("doc_type = ?", docType).
				Order("version DESC").
				Find(&rows).Error; err != nil {
				return fmt.Errorf("storage: lock legal documents: %w", err)
			}
			for i := range rows {
				if rows[i].Status == LegalDocumentStatusDraft {
					return ErrLegalDraftExists
				}
			}
			nextVersion := 1
			if len(rows) > 0 {
				nextVersion = rows[0].Version + 1
			}

			now := time.Now().UTC().Truncate(time.Millisecond)
			row := &LegalDocument{
				ID: uuid.NewString(), DocType: docType, Version: nextVersion,
				Title: title, ContentMarkdown: content,
				Status: LegalDocumentStatusDraft, CreatedBy: createdBy,
				CreatedAt: now, UpdatedAt: now,
			}
			if err := tx.Create(row).Error; err != nil {
				if isDuplicateKey(err) {
					return ErrLegalDocumentConflict
				}
				return fmt.Errorf("storage: create legal document draft: %w", err)
			}
			created = row
			return nil
		})
	}

	err = create()
	// Two first-time creators lock the same empty key range before either
	// inserts, and InnoDB resolves that race by deadlocking one of them. Retry
	// once so the loser observes the winner's draft and gets the stable domain
	// answer instead of a transient 500.
	if number, ok := mysqlErrNo(err); ok && number == 1213 {
		err = create()
	}
	if err != nil {
		return nil, err
	}
	return created, nil
}

// UpdateLegalDocumentDraft replaces the title and body of an unpublished draft
// in place. Version identity does not change — repeated edits stay one row, as
// the admin iterates on wording before publishing.
func (s *Store) UpdateLegalDocumentDraft(ctx context.Context, id, title, content string) (*LegalDocument, error) {
	title, err := normalizeDraft(title, content)
	if err != nil {
		return nil, err
	}

	var updated *LegalDocument
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := lockLegalDocument(tx, id)
		if err != nil {
			return err
		}
		if row.Status != LegalDocumentStatusDraft {
			return ErrLegalDocumentImmutable
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		if err := tx.Model(&LegalDocument{}).Where("id = ?", id).Updates(map[string]any{
			"title":            title,
			"content_markdown": content,
			"updated_at":       now,
		}).Error; err != nil {
			return fmt.Errorf("storage: update legal document draft: %w", err)
		}
		row.Title = title
		row.ContentMarkdown = content
		row.UpdatedAt = now
		updated = row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return updated, nil
}

// PublishLegalDocument makes the draft live: status flips to published and both
// effective_at and published_at are stamped with the publish instant. Publishing
// is one-way — the row is never writable again — so callers that need a change
// create a new draft from the published content.
//
// No other row is touched: a draft is always the highest version of its type, so
// flipping it is enough to make it the current version.
func (s *Store) PublishLegalDocument(ctx context.Context, id string) (*LegalDocument, error) {
	var published *LegalDocument
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := lockLegalDocument(tx, id)
		if err != nil {
			return err
		}
		if row.Status != LegalDocumentStatusDraft {
			return ErrLegalDocumentImmutable
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		if err := tx.Model(&LegalDocument{}).
			Where("id = ? AND status = ?", id, LegalDocumentStatusDraft).
			Updates(map[string]any{
				"status":       LegalDocumentStatusPublished,
				"effective_at": now,
				"published_at": now,
				"updated_at":   now,
			}).Error; err != nil {
			return fmt.Errorf("storage: publish legal document: %w", err)
		}
		row.Status = LegalDocumentStatusPublished
		row.EffectiveAt = &now
		row.PublishedAt = &now
		row.UpdatedAt = now
		published = row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return published, nil
}

// DeleteLegalDocumentDraft removes an unpublished draft. Published versions are
// never deleted — that is the point of keeping them.
func (s *Store) DeleteLegalDocumentDraft(ctx context.Context, id string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := lockLegalDocument(tx, id)
		if err != nil {
			return err
		}
		if row.Status != LegalDocumentStatusDraft {
			return ErrLegalDocumentImmutable
		}
		if err := tx.Delete(&LegalDocument{}, "id = ?", id).Error; err != nil {
			return fmt.Errorf("storage: delete legal document draft: %w", err)
		}
		return nil
	})
}

// normalizeDraft applies the shared draft write rules: the title is trimmed, and
// a blank title or body is rejected. Returns the trimmed title.
func normalizeDraft(title, content string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return "", fmt.Errorf("%w: title is required", ErrInvalidLegalDocument)
	}
	if strings.TrimSpace(content) == "" {
		return "", fmt.Errorf("%w: content is required", ErrInvalidLegalDocument)
	}
	return title, nil
}

// lockLegalDocument reads one row FOR UPDATE, mapping a missing row to
// ErrLegalDocumentNotFound.
func lockLegalDocument(tx *gorm.DB, id string) (*LegalDocument, error) {
	var row LegalDocument
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", id).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrLegalDocumentNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("storage: lock legal document: %w", err)
	}
	return &row, nil
}
