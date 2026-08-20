package registry

import (
	"os"
	"path/filepath"
	"testing"
)

const testUID = "f10bc353-01ab-4db1-af9f-d9305ea9a532"

func TestProviderName_DefaultWhenMissing(t *testing.T) {
	dir := t.TempDir()
	name, err := ProviderName(dir, testUID)
	if err != nil {
		t.Fatalf("ProviderName: %v", err)
	}
	if name != DefaultProvider {
		t.Errorf("missing config → %q, want %q", name, DefaultProvider)
	}
}

func TestProviderName_ReadsField(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, `{"provider":"garmin","email":"a@b.com"}`)
	name, err := ProviderName(dir, testUID)
	if err != nil {
		t.Fatalf("ProviderName: %v", err)
	}
	if name != "garmin" {
		t.Errorf("provider = %q, want garmin", name)
	}
}

func TestProviderName_LegacyNoField(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, `{"email":"a@b.com"}`)
	name, _ := ProviderName(dir, testUID)
	if name != DefaultProvider {
		t.Errorf("legacy config → %q, want %q", name, DefaultProvider)
	}
}

func TestProviderName_UnknownRejected(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, `{"provider":"suunto"}`)
	if _, err := ProviderName(dir, testUID); err == nil {
		t.Errorf("unknown provider should error")
	}
}

func TestWriteProviderName_PreservesFields(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, `{"email":"a@b.com","pwd_hash":"h"}`)
	if err := WriteProviderName(dir, testUID, "garmin"); err != nil {
		t.Fatalf("WriteProviderName: %v", err)
	}
	// provider now resolves to garmin…
	name, _ := ProviderName(dir, testUID)
	if name != "garmin" {
		t.Errorf("after write, provider = %q, want garmin", name)
	}
	// …and pre-existing fields survive.
	raw, _ := os.ReadFile(filepath.Join(dir, testUID, "config.json"))
	if !contains(string(raw), `"email"`) || !contains(string(raw), `"pwd_hash"`) {
		t.Errorf("existing fields not preserved: %s", raw)
	}
}

func TestWriteProviderName_CreatesWhenAbsent(t *testing.T) {
	dir := t.TempDir()
	if err := WriteProviderName(dir, testUID, "coros"); err != nil {
		t.Fatalf("WriteProviderName: %v", err)
	}
	name, _ := ProviderName(dir, testUID)
	if name != "coros" {
		t.Errorf("provider = %q, want coros", name)
	}
}

func TestWriteProviderName_RejectsUnknown(t *testing.T) {
	if err := WriteProviderName(t.TempDir(), testUID, "polar"); err == nil {
		t.Errorf("unknown provider should be rejected")
	}
}

func writeConfig(t *testing.T, dir, body string) {
	t.Helper()
	p := filepath.Join(dir, testUID)
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p, "config.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
