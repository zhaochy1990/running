package storage

import (
	"sync"
	"testing"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/schema"
)

// TestActivityTSBlobColumnDDLTypes guards the MySQL DDL types of the four
// timeseries-blob pointer columns (devops#784 AC: varchar(256) / int /
// char(64) / tinyint(1), all nullable). Regression guard for the devops#784
// E2E finding: a gorm tag `type:int` is not a passthrough — the literal equals
// gorm's schema.Int constant, so gorm uses its Go-kind mapping where an unsized
// *int defaults to size 64 and the MySQL driver emits bigint. `type:integer`
// matches no gorm constant and passes through verbatim; MySQL treats INTEGER
// as INT. FullDataTypeOf is the exact type clause AutoMigrate puts in the
// CREATE/ALTER DDL, so this asserts the real migration output without a live
// MySQL (SkipInitializeWithVersion skips the version probe and
// DisableAutomaticPing keeps gorm.Open from dialing; no query ever runs).
func TestActivityTSBlobColumnDDLTypes(t *testing.T) {
	db, err := gorm.Open(mysql.New(mysql.Config{SkipInitializeWithVersion: true}), &gorm.Config{DisableAutomaticPing: true})
	if err != nil {
		t.Fatalf("open offline mysql dialector: %v", err)
	}
	s, err := schema.Parse(&Activity{}, &sync.Map{}, db.NamingStrategy)
	if err != nil {
		t.Fatalf("parse Activity schema: %v", err)
	}
	m, ok := db.Migrator().(interface {
		FullDataTypeOf(*schema.Field) clause.Expr
	})
	if !ok {
		t.Fatalf("migrator does not expose FullDataTypeOf")
	}

	cases := []struct{ column, want string }{
		{"ts_blob_key", "varchar(256)"},
		{"ts_point_count", "integer"}, // INTEGER == INT; must never be bigint
		{"ts_sha256", "char(64)"},
		{"has_gps", "tinyint(1)"},
	}
	for _, c := range cases {
		f, ok := s.FieldsByDBName[c.column]
		if !ok {
			t.Fatalf("column %q missing from Activity schema", c.column)
		}
		if f.NotNull {
			t.Errorf("column %q must stay nullable (AC: all four columns nullable)", c.column)
		}
		if got := m.FullDataTypeOf(f).SQL; got != c.want {
			t.Errorf("column %q DDL type = %q, want %q", c.column, got, c.want)
		}
	}
}
