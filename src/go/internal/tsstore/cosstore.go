// cosstore.go adapts internal/cos to the Store interface — the production
// backend (private bucket stride-timeseries, devops#779/#784).
package tsstore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/zhaochy1990/stride/internal/cos"
)

// COSStore is a Store backed by a private COS bucket. Build it from a
// cos.NewPrivateClient client — that constructor enforces the fail-fast
// config semantics this data path requires (unlike the thumbnail bucket, an
// unconfigured timeseries store must never boot inert).
type COSStore struct {
	cli *cos.Client
}

var _ Store = (*COSStore)(nil)

// NewCOSStore wraps an already-signed COS client. The cos layer's errors
// already carry "cos:" context, so the adapters below stay thin; the one
// translation that matters is mapping cos.ErrNotFound to this package's
// sentinel so read paths branch on a single errors.Is during the migration.
func NewCOSStore(cli *cos.Client) *COSStore { return &COSStore{cli: cli} }

// Put is an idempotent overwrite: COS Object.Put replaces the object at key.
func (s *COSStore) Put(ctx context.Context, key string, payload []byte) error {
	return s.cli.Upload(ctx, key, bytes.NewReader(payload), "application/gzip")
}

// Get fetches the object, translating the transport's not-found sentinel into
// tsstore's own.
func (s *COSStore) Get(ctx context.Context, key string) ([]byte, error) {
	b, err := s.cli.Get(ctx, key)
	if errors.Is(err, cos.ErrNotFound) {
		return nil, fmt.Errorf("tsstore: get %s: %w", key, ErrNotFound)
	}
	return b, err
}

// List walks every key under prefix in bucket order, reporting COS's
// last-modified timestamp as ModTime. An error from fn is returned as-is (see
// Store.List).
func (s *COSStore) List(ctx context.Context, prefix string, fn func(ObjectInfo) error) error {
	return s.cli.List(ctx, prefix, func(key string, modTime time.Time) error {
		return fn(ObjectInfo{Key: key, ModTime: modTime})
	})
}

// Delete removes each key, idempotently: a missing object is not an error.
func (s *COSStore) Delete(ctx context.Context, keys ...string) error {
	for _, key := range keys {
		if err := s.cli.Delete(ctx, key); err != nil && !errors.Is(err, cos.ErrNotFound) {
			return err
		}
	}
	return nil
}
