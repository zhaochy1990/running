package api

import (
	"crypto/rand"
	"crypto/rsa"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestNewJWTVerifierFromKeyWithAdminRejectsSharedAudience(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	if _, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAudience); err == nil {
		t.Fatal("expected shared user/admin audience to be rejected")
	}
}

// The auth-service stamps `aud = client_id`, so the data plane accepts every
// legitimate first-party client. A comma-separated user-audience list must
// accept any one of them and reject unknown audiences.
func TestJWTVerifierAcceptsAnyUserAudience(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, "stride,mini-program-client", "")
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}

	sign := func(aud string) string {
		t.Helper()
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
			"sub": "user-1",
			"iss": testIssuer,
			"aud": aud,
			"exp": time.Now().Add(time.Hour).Unix(),
			"iat": time.Now().Unix(),
		})
		s, err := tok.SignedString(key)
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		return s
	}

	for _, aud := range []string{"stride", "mini-program-client"} {
		caller, err := verifier.Verify(sign(aud))
		if err != nil {
			t.Fatalf("expected aud %q accepted, got %v", aud, err)
		}
		if caller.UserID != "user-1" {
			t.Fatalf("sub = %q", caller.UserID)
		}
	}

	if _, err := verifier.Verify(sign("other-client")); err == nil {
		t.Fatal("expected unknown audience rejected")
	}
}
