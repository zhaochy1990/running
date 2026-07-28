// Command reconcile compares the Go-written MySQL shadow store against the
// Python SQLite store for one user, using the tolerance-aware diff engine
// (internal/reconcile, ADR 0005). It is a manual dev tool.
//
// The MySQL side is read here. The SQLite side needs a driver
// (modernc.org/sqlite, pure-Go, no cgo) which is not yet a module dependency —
// see readSQLite. Until then the tool reports the MySQL row count and the
// pending SQLite read; the diff engine itself is complete and unit-tested.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/reconcile"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/syncconfig"
)

func main() {
	profile := flag.String("profile", "", "user UUID")
	sqlitePath := flag.String("sqlite", "", "path to the Python coros.db (SQLite)")
	flag.Parse()

	user, err := uuid.Parse(*profile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error: -profile must be a user UUID")
		os.Exit(2)
	}
	ctx := context.Background()

	cfg := syncconfig.MustLoad()
	store, err := storage.Open(cfg.MySQL.DSN)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	defer store.Close()

	right, err := store.ReconcileActivityRows(ctx, user.String())
	if err != nil {
		fmt.Fprintln(os.Stderr, "error: read MySQL:", err)
		os.Exit(1)
	}

	left, err := readSQLite(*sqlitePath, user.String())
	if err != nil {
		fmt.Printf("MySQL activities: %d\nSQLite side unavailable: %v\n", len(right), err)
		return
	}

	mismatches := reconcile.Diff(reconcile.ActivityFields(), toRows(left), toRows(right))
	if len(mismatches) == 0 {
		fmt.Printf("OK: %d activities match (MySQL vs SQLite)\n", len(right))
		return
	}
	fmt.Printf("FAIL: %d mismatches (MySQL vs SQLite)\n", len(mismatches))
	for _, m := range mismatches {
		fmt.Println("  " + m.String())
	}
	os.Exit(1)
}

func toRows(in map[string]map[string]any) map[string]reconcile.Row {
	out := make(map[string]reconcile.Row, len(in))
	for k, v := range in {
		out[k] = reconcile.Row(v)
	}
	return out
}
