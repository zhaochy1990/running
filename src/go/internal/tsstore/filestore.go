// filestore.go is the directory-backed Store: object key → file path under a
// root dir. Dev/local convenience (#778 decision 2) — same codec, same keys,
// zero credentials, offline-runnable.
package tsstore

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// FileStore stores blobs as files under Dir, mirroring the object layout:
// key "ts/v1/{user}/{label}.json.gz" → Dir/ts/v1/{user}/{label}.json.gz.
type FileStore struct {
	dir string
}

var _ Store = (*FileStore)(nil)

// NewFileStore creates Dir (like mkdir -p) and returns the store.
func NewFileStore(dir string) (*FileStore, error) {
	if dir == "" {
		return nil, errors.New("tsstore: file store requires a directory")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("tsstore: create file store dir: %w", err)
	}
	return &FileStore{dir: dir}, nil
}

// path validates key as a relative slash path (rejecting traversal and
// absolute keys — a blob key is always BlobKey-shaped) and maps it to a path
// under the store dir.
func (s *FileStore) path(key string) (string, error) {
	if key == "" || strings.HasPrefix(key, "/") {
		return "", fmt.Errorf("tsstore: invalid key %q", key)
	}
	for _, el := range strings.Split(key, "/") {
		if el == "" || el == "." || el == ".." {
			return "", fmt.Errorf("tsstore: invalid key %q", key)
		}
	}
	return filepath.Join(append([]string{s.dir}, strings.Split(key, "/")...)...), nil
}

// Put writes the payload atomically (temp file + rename) so a crashed write
// can never leave a half-written object for Get to see.
func (s *FileStore) Put(_ context.Context, key string, payload []byte) error {
	p, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return fmt.Errorf("tsstore: mkdir for %s: %w", key, err)
	}
	// The dot prefix keeps a crashed temp file out of List (which only serves
	// BlobKey-shaped keys, never dot-leading elements).
	tmp, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+".tmp*")
	if err != nil {
		return fmt.Errorf("tsstore: temp file for %s: %w", key, err)
	}
	name := tmp.Name()
	if _, err := tmp.Write(payload); err != nil {
		tmp.Close()
		os.Remove(name)
		return fmt.Errorf("tsstore: write %s: %w", key, err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return fmt.Errorf("tsstore: close %s: %w", key, err)
	}
	if err := os.Rename(name, p); err != nil {
		os.Remove(name)
		return fmt.Errorf("tsstore: rename %s: %w", key, err)
	}
	return nil
}

// Get reads the object; a missing file is ErrNotFound.
func (s *FileStore) Get(_ context.Context, key string) ([]byte, error) {
	p, err := s.path(key)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("tsstore: get %s: %w", key, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("tsstore: read %s: %w", key, err)
	}
	return b, nil
}

// List calls fn with every stored key under prefix (slash-separated), in
// lexicographic order for reproducibility, reporting each file's mtime as
// ModTime (the orphan GC's age input). An error from fn aborts the walk and is
// returned as-is. Dot-leading files (crashed temp writes) are skipped.
func (s *FileStore) List(_ context.Context, prefix string, fn func(ObjectInfo) error) error {
	var infos []ObjectInfo
	err := filepath.WalkDir(s.dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		rel, err := filepath.Rel(s.dir, p)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if !strings.HasPrefix(key, prefix) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		infos = append(infos, ObjectInfo{Key: key, ModTime: info.ModTime().UTC()})
		return nil
	})
	if err != nil {
		return fmt.Errorf("tsstore: walk %s: %w", s.dir, err)
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].Key < infos[j].Key })
	for _, info := range infos {
		if err := fn(info); err != nil {
			return err
		}
	}
	return nil
}

// Delete removes each key, idempotently: a missing file is not an error.
func (s *FileStore) Delete(_ context.Context, keys ...string) error {
	for _, key := range keys {
		p, err := s.path(key)
		if err != nil {
			return err
		}
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("tsstore: delete %s: %w", key, err)
		}
	}
	return nil
}
