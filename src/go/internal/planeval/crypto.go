package planeval

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
)

// SecretKey encrypts launch environment values (model API keys) before they
// are stored: AES-256-GCM with a 32-byte key given base64 in configuration.
// Only the worker Deployment ever sees the plaintext again.
type SecretKey struct{ aead cipher.AEAD }

func NewSecretKey(base64Key string) (*SecretKey, error) {
	raw, err := base64.StdEncoding.DecodeString(base64Key)
	if err != nil {
		return nil, fmt.Errorf("plan-eval secret-key is not base64: %w", err)
	}
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, fmt.Errorf("plan-eval secret-key must be 32 bytes: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &SecretKey{aead: aead}, nil
}

// Seal encrypts the environment map as one authenticated blob.
func (k *SecretKey) Seal(values map[string]string) ([]byte, error) {
	plaintext, err := json.Marshal(values)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, k.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return k.aead.Seal(nonce, nonce, plaintext, nil), nil
}

// Open reverses Seal.
func (k *SecretKey) Open(blob []byte) (map[string]string, error) {
	if len(blob) < k.aead.NonceSize() {
		return nil, fmt.Errorf("launch configuration ciphertext is truncated")
	}
	nonce, ciphertext := blob[:k.aead.NonceSize()], blob[k.aead.NonceSize():]
	plaintext, err := k.aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("launch configuration cannot be decrypted (secret-key changed?): %w", err)
	}
	var values map[string]string
	if err := json.Unmarshal(plaintext, &values); err != nil {
		return nil, err
	}
	return values, nil
}
