// Package userdata removes a user's on-disk data directory during account
// erasure. The Go API owns the athlete data root; MySQL is the canonical store,
// but legacy provider-binding files (and historical COROS credentials) still
// live under data/<user_id> and must not outlive the account.
package userdata

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

// Remover deletes per-user artifacts beneath a fixed data root.
type Remover struct {
	root string
}

// NewRemover builds a Remover rooted at dataDir. An empty dataDir disables it
// (RemoveUserDir reports "nothing removed" so callers treat it as a no-op).
func NewRemover(dataDir string) *Remover {
	return &Remover{root: dataDir}
}

// RemoveUserDir deletes the entry named after userID under the data root. It
// handles both a directory (provider-binding config) and a legacy file of the
// same name. The boolean reports whether anything was removed, so a user with no
// on-disk artifacts is not treated as a failure. Traversal is impossible: the
// id must be a canonical UUID and the resolved path is re-checked to stay under
// the root.
func (r *Remover) RemoveUserDir(userID string) (bool, error) {
	if r.root == "" {
		return false, nil
	}
	parsed, err := uuid.Parse(userID)
	if err != nil || parsed.String() != userID {
		return false, fmt.Errorf("userdata: invalid user id %q", userID)
	}
	rootAbs, err := filepath.Abs(r.root)
	if err != nil {
		return false, fmt.Errorf("userdata: resolve data root: %w", err)
	}
	target := filepath.Join(rootAbs, userID)
	rel, err := filepath.Rel(rootAbs, target)
	if err != nil || rel == ".." || filepath.IsAbs(rel) {
		return false, fmt.Errorf("userdata: refusing to remove path outside data root")
	}
	if _, err := os.Lstat(target); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("userdata: stat %s: %w", target, err)
	}
	if err := os.RemoveAll(target); err != nil {
		return false, fmt.Errorf("userdata: remove %s: %w", target, err)
	}
	return true, nil
}
