package userdata

import (
	"os"
	"path/filepath"
	"testing"
)

const testUID = "11111111-1111-4111-8111-111111111111"

func TestRemoveUserDir_Directory(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, testUID)
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	other := filepath.Join(root, "22222222-2222-4222-8222-222222222222")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatalf("seed other: %v", err)
	}

	removed, err := NewRemover(root).RemoveUserDir(testUID)
	if err != nil || !removed {
		t.Fatalf("RemoveUserDir = %v, %v; want true, nil", removed, err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("target dir still exists: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("other user dir must be preserved: %v", err)
	}
}

func TestRemoveUserDir_LegacyFileAndMissing(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, testUID)
	if err := os.WriteFile(legacy, []byte("coros creds"), 0o600); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	remover := NewRemover(root)
	removed, err := remover.RemoveUserDir(testUID)
	if err != nil || !removed {
		t.Fatalf("first remove = %v, %v; want true, nil", removed, err)
	}
	removed, err = remover.RemoveUserDir(testUID)
	if err != nil || removed {
		t.Fatalf("second remove = %v, %v; want false, nil", removed, err)
	}
}

func TestRemoveUserDir_RejectsInvalidID(t *testing.T) {
	root := t.TempDir()
	if _, err := NewRemover(root).RemoveUserDir("../../etc"); err == nil {
		t.Fatal("path traversal id must be rejected")
	}
	if _, err := NewRemover(root).RemoveUserDir("not-a-uuid"); err == nil {
		t.Fatal("non-uuid id must be rejected")
	}
}

func TestRemoveUserDir_DisabledRoot(t *testing.T) {
	removed, err := NewRemover("").RemoveUserDir(testUID)
	if err != nil || removed {
		t.Fatalf("disabled remover = %v, %v; want false, nil", removed, err)
	}
}
