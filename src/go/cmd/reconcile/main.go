// Command reconcile compares the Go-written MySQL shadow store against the
// Python SQLite store for one user, using the tolerance-aware diff engine
// (internal/reconcile, ADR 0005). It reads the SQLite side with the pure-Go
// modernc.org/sqlite driver and validates the activities MySQL synced. It is a
// manual dev tool.
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
	providerName := flag.String("provider", "coros", "provider to reconcile (coros|garmin)")
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

	right, err := store.ReconcileActivityRowsByProvider(ctx, user.String(), *providerName)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error: read MySQL:", err)
		os.Exit(1)
	}

	left, err := readSQLite(*sqlitePath, *providerName)
	if err != nil {
		fmt.Printf("MySQL %s activities: %d\nSQLite side unavailable: %v\n", *providerName, len(right), err)
		return
	}

	// Validate only the activities present in MySQL (Go may have synced a bounded
	// subset of the SQLite history).
	filtered := make(map[string]map[string]any, len(right))
	for k := range right {
		if lv, ok := left[k]; ok {
			filtered[k] = lv
		}
	}

	mismatches := reconcile.Diff(reconcile.ActivityFields(), toRows(filtered), toRows(right))
	if len(mismatches) == 0 {
		fmt.Printf("OK: %d MySQL %s activities match SQLite\n", len(right), *providerName)
		return
	}
	fmt.Printf("FAIL: %d mismatches across %d MySQL %s activities (vs SQLite)\n", len(mismatches), len(right), *providerName)
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
