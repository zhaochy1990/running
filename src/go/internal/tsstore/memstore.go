// memstore.go is the in-memory Store for unit tests: same codec, same keys,
// no I/O — so round-trip tests exercise the exact production blob format
// without touching a bucket (devops#784 AC: never hit the real bucket).
package tsstore

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// MemStore holds objects in a map guarded by an RWMutex.
type MemStore struct {
	mu      sync.RWMutex
	objects map[string][]byte
}

var _ Store = (*MemStore)(nil)

// NewMemStore returns an empty store.
func NewMemStore() *MemStore { return &MemStore{objects: map[string][]byte{}} }

// Put is an idempotent overwrite of the map entry.
func (s *MemStore) Put(_ context.Context, key string, payload []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = payload
	return nil
}

// Get returns the payload; a missing key is ErrNotFound.
func (s *MemStore) Get(_ context.Context, key string) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, ok := s.objects[key]
	if !ok {
		return nil, fmt.Errorf("tsstore: get %s: %w", key, ErrNotFound)
	}
	return b, nil
}

// List calls fn with every key under prefix in lexicographic order. An error
// from fn aborts the walk and is returned as-is.
func (s *MemStore) List(_ context.Context, prefix string, fn func(key string) error) error {
	s.mu.RLock()
	var keys []string
	for key := range s.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	s.mu.RUnlock()
	sort.Strings(keys)
	for _, key := range keys {
		if err := fn(key); err != nil {
			return err
		}
	}
	return nil
}

// Delete removes each key, idempotently.
func (s *MemStore) Delete(_ context.Context, keys ...string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, key := range keys {
		delete(s.objects, key)
	}
	return nil
}
