package api

import (
	"crypto/rand"
	"crypto/rsa"
	"testing"
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
