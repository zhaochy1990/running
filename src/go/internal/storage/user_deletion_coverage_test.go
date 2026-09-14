package storage

import (
	"context"
	"testing"
)

// TestDeleteUserData_CoversEveryUserOwnedTable is the executable version of the
// "user data table inventory" guard (issue story 40). Instead of asserting a
// fixed list, it enumerates the live schema: every table with a `user_id` column
// must be handled by DeleteUserData, either through userOwnedDeletionModels or
// one of the documented special cases. A future user-owned table that nobody
// wires into deletion makes this test fail by name.
func TestDeleteUserData_CoversEveryUserOwnedTable(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	for _, migrate := range []func(context.Context) error{
		st.AutoMigrateWatch, // includes the onboarding-compute models
		st.AutoMigrateUsers,
		st.AutoMigrateGoals,
		st.AutoMigrateMasterPlan,
		st.AutoMigrateWeeklyPlan,
		st.AutoMigrateWeeklyFeedback,
		st.AutoMigrateBodyComposition,
		st.AutoMigrateTeamLikes,
		st.AutoMigrateScheduledWorkout,
		st.AutoMigrateUserDeletionAudit,
	} {
		if err := migrate(ctx); err != nil {
			t.Fatalf("migrate: %v", err)
		}
	}

	// Tables that carry user data but are deliberately not part of
	// DeleteUserData's per-user sweep.
	intentional := map[string]string{
		// Provenance tables are removed by `user_id = ? OR created_by = ?`.
		"jobs":          "created_by provenance",
		"pipeline_runs": "created_by provenance",
		// The audit trail is the record OF the deletion and must survive it.
		"user_deletion_audit": "deletion audit trail",
	}

	covered := map[string]bool{}
	for _, model := range userOwnedDeletionModels {
		named, ok := model.(interface{ TableName() string })
		if !ok {
			t.Fatalf("model %T has no TableName()", model)
		}
		covered[named.TableName()] = true
	}
	for table := range intentional {
		covered[table] = true
	}

	rows, err := st.db.WithContext(ctx).Raw(
		`SELECT DISTINCT TABLE_NAME FROM information_schema.COLUMNS
		  WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'user_id'`).Rows()
	if err != nil {
		t.Fatalf("list user_id tables: %v", err)
	}
	defer func() { _ = rows.Close() }()

	seen := 0
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			t.Fatalf("scan table: %v", err)
		}
		seen++
		if !covered[table] {
			t.Errorf("table %q has a user_id column but DeleteUserData does not cover it; add its model to userOwnedDeletionModels (or document a special case)", table)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate tables: %v", err)
	}
	if seen == 0 {
		t.Fatal("no user_id tables found; the schema introspection query is broken")
	}

	// The other direction: every model in the deletion list must map to a real
	// table, so a renamed/removed table cannot silently make a delete a no-op.
	for table := range covered {
		if _, documented := intentional[table]; documented {
			continue
		}
		var count int
		if err := st.db.WithContext(ctx).Raw(
			`SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, table,
		).Scan(&count).Error; err != nil {
			t.Fatalf("table lookup %q: %v", table, err)
		}
		if count == 0 {
			t.Errorf("deletion list references table %q, which does not exist", table)
		}
	}
}
