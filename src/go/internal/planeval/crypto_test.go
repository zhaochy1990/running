package planeval

import (
	"bytes"
	"testing"
)

func testKey(t *testing.T) *SecretKey {
	t.Helper()
	key, err := NewSecretKey("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=") // 32 bytes
	if err != nil {
		t.Fatalf("new secret key: %v", err)
	}
	return key
}

func TestSecretKey_RoundTrip(t *testing.T) {
	key := testKey(t)
	blob, err := key.Seal(map[string]string{"DEEPSEEK_API_KEY": "sk-secret", "OTHER": "v"})
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if bytes.Contains(blob, []byte("sk-secret")) {
		t.Fatalf("ciphertext leaks the plaintext")
	}
	got, err := key.Open(blob)
	if err != nil || got["DEEPSEEK_API_KEY"] != "sk-secret" || got["OTHER"] != "v" {
		t.Fatalf("open = %v, %v", got, err)
	}
	other, _ := NewSecretKey("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
	if _, err := other.Open(blob); err == nil {
		t.Fatalf("a different key must not decrypt the blob")
	}
	if _, err := key.Open(blob[:5]); err == nil {
		t.Fatalf("a truncated blob must not decrypt")
	}
}

func TestSecretKey_RejectsBadKeyMaterial(t *testing.T) {
	for _, bad := range []string{"not base64!", "c2hvcnQ="} {
		if _, err := NewSecretKey(bad); err == nil {
			t.Errorf("NewSecretKey(%q) succeeded", bad)
		}
	}
}

func TestSecretKey_WorkerTokensAreVersionBound(t *testing.T) {
	first := versionWorkerToken("root-secret", "2026.11.30")
	if first == "root-secret" || first == versionWorkerToken("root-secret", "2026.11.31") || first == versionWorkerToken("another-root", "2026.11.30") {
		t.Fatal("worker token not isolated")
	}
	if first != versionWorkerToken("root-secret", "2026.11.30") || versionWorkerToken("", "2026.11.30") != "" {
		t.Fatal("worker token derivation unstable")
	}
}
