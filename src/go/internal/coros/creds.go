// creds.go bridges COROS Credentials and the provider_credentials store
// (ADR 0008). The secret blob is plaintext JSON for v1 (envelope encryption is a
// deferred follow-up).
package coros

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

// CredentialStore loads/saves a user's COROS credentials.
type CredentialStore interface {
	Load(ctx context.Context, user string) (Credentials, error)
	Save(ctx context.Context, user string, c Credentials) error
}

// CredentialBackend is the storage surface the credential store needs. *storage.Store
// satisfies it.
type CredentialBackend interface {
	GetCredential(ctx context.Context, userID, provider string) (*storage.ProviderCredential, error)
	SaveCredential(ctx context.Context, c *storage.ProviderCredential) error
}

// storageCredentialStore persists COROS credentials in provider_credentials.
type storageCredentialStore struct {
	backend CredentialBackend
}

// NewStorageCredentialStore returns a CredentialStore backed by the DB.
func NewStorageCredentialStore(backend CredentialBackend) CredentialStore {
	return &storageCredentialStore{backend: backend}
}

// secretBlob is the plaintext-v1 encoding of the sensitive credential fields.
type secretBlob struct {
	PwdHash     string `json:"pwd_hash"`
	AccessToken string `json:"access_token"`
}

func (s *storageCredentialStore) Load(ctx context.Context, user string) (Credentials, error) {
	pc, err := s.backend.GetCredential(ctx, user, "coros")
	if err != nil {
		return Credentials{}, err
	}
	if pc == nil {
		return Credentials{}, nil // not logged in
	}
	var sec secretBlob
	if len(pc.Secret) > 0 {
		if err := json.Unmarshal(pc.Secret, &sec); err != nil {
			return Credentials{}, fmt.Errorf("coros: decode credential secret: %w", err)
		}
	}
	return Credentials{
		Email:       derefStr(pc.Email),
		PwdHash:     sec.PwdHash,
		AccessToken: sec.AccessToken,
		Region:      derefStr(pc.Region),
		UserID:      derefStr(pc.ProviderUserID),
	}, nil
}

func (s *storageCredentialStore) Save(ctx context.Context, user string, c Credentials) error {
	blob, err := json.Marshal(secretBlob{PwdHash: c.PwdHash, AccessToken: c.AccessToken})
	if err != nil {
		return err
	}
	pc := &storage.ProviderCredential{
		UserID:         user,
		Provider:       "coros",
		Email:          strOrNil(c.Email),
		Region:         strOrNil(c.Region),
		ProviderUserID: strOrNil(c.UserID),
		Secret:         blob,
		UpdatedAt:      time.Now().UTC(),
	}
	return s.backend.SaveCredential(ctx, pc)
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func strOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
