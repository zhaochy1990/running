package storage

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// ensureAuthUsersTable creates a minimal auth.auth_users mirror for the
// cross-schema audit join (devops#663). The test DSN runs as root on the CI
// MySQL service and on the local scratch stack, so creating a sibling schema
// is allowed; the join only needs the id column. Collation intentionally
// differs from stride's (matches prod, where auth is 0900_ai_ci) to pin the
// COLLATE clause in ListOrphanSyncUsers.
func ensureAuthUsersTable(t *testing.T, st *Store) {
	t.Helper()
	if err := st.db.Exec("CREATE DATABASE IF NOT EXISTS auth CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci").Error; err != nil {
		t.Fatalf("create auth schema: %v", err)
	}
	if err := st.db.Exec("CREATE TABLE IF NOT EXISTS auth.auth_users (id char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL, PRIMARY KEY (id))").Error; err != nil {
		t.Fatalf("create auth.auth_users: %v", err)
	}
}

// insertAuthUser seeds one identity row, filling every NOT-NULL-no-default
// column — the column set differs between the CI minimal mirror (id only) and
// the local dev stack's real auth schema (custom_attributes + timestamps).
func insertAuthUser(t *testing.T, st *Store, id string) {
	t.Helper()
	rows, err := st.db.Raw(
		"SELECT column_name, column_type FROM information_schema.columns " +
			"WHERE table_schema='auth' AND table_name='auth_users' " +
			"AND is_nullable='NO' AND column_default IS NULL AND column_name <> 'id' " +
			"AND extra NOT LIKE '%auto_increment%' AND extra NOT LIKE '%GENERATED%'").Rows()
	if err != nil {
		t.Fatalf("inspect auth_users columns: %v", err)
	}
	defer rows.Close()
	cols := []string{"id"}
	vals := []any{id}
	now := time.Now().UTC()
	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			t.Fatalf("scan column: %v", err)
		}
		cols = append(cols, name)
		switch {
		case strings.Contains(typ, "datetime"):
			vals = append(vals, now)
		case strings.Contains(typ, "text") || strings.Contains(typ, "json"):
			vals = append(vals, "{}")
		default:
			vals = append(vals, "")
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate auth_users columns: %v", err)
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(cols)), ", ")
	if err := st.db.Exec(
		"INSERT INTO auth.auth_users ("+strings.Join(cols, ", ")+") VALUES ("+placeholders+")", vals...,
	).Error; err != nil {
		t.Fatalf("seed identity: %v", err)
	}
}

// TestListOrphanSyncUsers pins the audit semantics: a credential user with a
// live auth identity is not an orphan; a credential user without one is (the
// devops#664 erasure-race shape). Empty is the steady state for the seeded
// users once their identity rows exist.
func TestListOrphanSyncUsers(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ensureAuthUsersTable(t, st)
	ctx := context.Background()
	healthy, orphan := uuid.NewString(), uuid.NewString()
	if err := st.SaveCredential(ctx, &ProviderCredential{UserID: healthy, Provider: "coros", Secret: []byte("s"), UpdatedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("save healthy credential: %v", err)
	}
	if err := st.SaveCredential(ctx, &ProviderCredential{UserID: orphan, Provider: "coros", Secret: []byte("s"), UpdatedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("save orphan credential: %v", err)
	}
	t.Cleanup(func() {
		_ = st.DeleteCredential(ctx, healthy, "coros")
		_ = st.DeleteCredential(ctx, orphan, "coros")
		st.db.Exec("DELETE FROM auth.auth_users WHERE id IN (?, ?)", healthy, orphan)
	})

	// No identity rows yet: both credential holders are orphans.
	got, err := st.ListOrphanSyncUsers(ctx)
	if err != nil {
		t.Fatalf("list orphans (no identities): %v", err)
	}
	// DISTINCT guarantees at most one row per id, so existence is the assertion.
	if !slices.Contains(got, healthy) || !slices.Contains(got, orphan) {
		t.Fatalf("orphans without identities = %v, want both %s and %s", got, healthy, orphan)
	}

	// The healthy user gets an auth identity; only the orphan remains.
	insertAuthUser(t, st, healthy)
	got, err = st.ListOrphanSyncUsers(ctx)
	if err != nil {
		t.Fatalf("list orphans (one identity): %v", err)
	}
	if slices.Contains(got, healthy) {
		t.Fatalf("healthy user %s still flagged as orphan: %v", healthy, got)
	}
	if !slices.Contains(got, orphan) {
		t.Fatalf("orphan %s missing from %v", orphan, got)
	}
}
