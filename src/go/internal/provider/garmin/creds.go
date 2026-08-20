// creds.go bridges Garmin Credentials and the provider_credentials store (ADR
// 0008/0009). The secret blob is the full portable OAuth bundle (OAuth1 + OAuth2
// + profile), plaintext JSON for v1 — so token refresh works offline and no
// re-login is needed. Stored under provider='garmin'; email/region live in their
// own columns, userName in provider_user_id.
package garmin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

// CredentialStore loads/saves a user's Garmin credentials.
type CredentialStore interface {
	Load(ctx context.Context, user string) (Credentials, error)
	Save(ctx context.Context, user string, c Credentials) error
}

// CredentialBackend is the storage surface the credential store needs.
// *storage.Store satisfies it.
type CredentialBackend interface {
	GetCredential(ctx context.Context, userID, provider string) (*storage.ProviderCredential, error)
	SaveCredential(ctx context.Context, c *storage.ProviderCredential) error
}

type storageCredentialStore struct {
	backend CredentialBackend
}

// NewStorageCredentialStore returns a CredentialStore backed by the DB.
func NewStorageCredentialStore(backend CredentialBackend) CredentialStore {
	return &storageCredentialStore{backend: backend}
}

// secretBlob is the plaintext-v1 encoding of the sensitive credential fields —
// the garth-dumps equivalent (portable OAuth1+OAuth2 bundle).
type secretBlob struct {
	OAuth1      OAuth1Token `json:"oauth1"`
	OAuth2      OAuth2Token `json:"oauth2"`
	DisplayName string      `json:"display_name,omitempty"`
	UserName    string      `json:"user_name,omitempty"`
}

func (s *storageCredentialStore) Load(ctx context.Context, user string) (Credentials, error) {
	pc, err := s.backend.GetCredential(ctx, user, providerName)
	if err != nil {
		return Credentials{}, err
	}
	if pc == nil {
		return Credentials{}, nil // not logged in
	}
	var sec secretBlob
	if len(pc.Secret) > 0 {
		if err := json.Unmarshal(pc.Secret, &sec); err != nil {
			return Credentials{}, fmt.Errorf("garmin: decode credential secret: %w", err)
		}
	}
	return Credentials{
		Email:       derefStr(pc.Email),
		Region:      derefStr(pc.Region),
		OAuth1:      sec.OAuth1,
		OAuth2:      sec.OAuth2,
		DisplayName: sec.DisplayName,
		UserName:    sec.UserName,
	}, nil
}

func (s *storageCredentialStore) Save(ctx context.Context, user string, c Credentials) error {
	blob, err := json.Marshal(secretBlob{
		OAuth1:      c.OAuth1,
		OAuth2:      c.OAuth2,
		DisplayName: c.DisplayName,
		UserName:    c.UserName,
	})
	if err != nil {
		return err
	}
	pc := &storage.ProviderCredential{
		UserID:         user,
		Provider:       providerName,
		Email:          strOrNil(c.Email),
		Region:         strOrNil(c.Region),
		ProviderUserID: strOrNil(c.UserName),
		Secret:         blob,
		UpdatedAt:      time.Now().UTC(),
	}
	return s.backend.SaveCredential(ctx, pc)
}

// CredentialsFromGarthDump decodes a base64 garth Client.dumps() string — the
// tokens_dump the Python garmin_sync file backend stores in
// data/<uid>/garmin_auth.json — into Credentials. The dump is
// base64(json([oauth1_dict, oauth2_dict])). Lets the Go shadow store reuse an
// existing garth session (no password / MFA) for reconcile validation.
func CredentialsFromGarthDump(email, region, dump string) (Credentials, error) {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(dump))
	if err != nil {
		return Credentials{}, fmt.Errorf("garmin: base64-decode garth dump: %w", err)
	}
	var parts []json.RawMessage
	if err := json.Unmarshal(decoded, &parts); err != nil {
		return Credentials{}, fmt.Errorf("garmin: garth dump is not a JSON array: %w", err)
	}
	if len(parts) < 2 {
		return Credentials{}, &AuthError{msg: "garth dump must be [oauth1, oauth2]"}
	}
	var o1 OAuth1Token
	if err := json.Unmarshal(parts[0], &o1); err != nil {
		return Credentials{}, fmt.Errorf("garmin: decode oauth1 from dump: %w", err)
	}
	var o2 OAuth2Token
	if err := json.Unmarshal(parts[1], &o2); err != nil {
		return Credentials{}, fmt.Errorf("garmin: decode oauth2 from dump: %w", err)
	}
	if o1.OAuthToken == "" {
		return Credentials{}, &AuthError{msg: "garth dump has no oauth1 token"}
	}
	if o1.Domain == "" {
		o1.Domain = domainForRegion(region)
	}
	return Credentials{Email: email, Region: region, OAuth1: o1, OAuth2: o2}, nil
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
