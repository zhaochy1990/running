// Command reconcile compares the Go-written MySQL shadow store against the
// Python SQLite store for one user, using the tolerance-aware diff engine
// (internal/reconcile, ADR 0005). It reads the SQLite side with the pure-Go
// modernc.org/sqlite driver. A manual dev tool.
//
// -table selects what to reconcile: activities (default, provider-filtered),
// calibration, zones, pbs, activity_load, daily_load (the onboarding_compute
// derived tables, ADR 0013). The derived tables validate only rows present in
// BOTH stores; note the PMC daily_load is path-dependent, so a clean diff needs
// both sides computed over the same window/inputs.
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
	providerName := flag.String("provider", "coros", "provider to reconcile (coros|garmin), activities only")
	table := flag.String("table", "activities", "activities|calibration|zones|pbs|activity_load|daily_load")
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

	if *table == "activities" {
		reconcileActivities(ctx, store, user.String(), *sqlitePath, *providerName)
		return
	}

	type target struct {
		mysql  func() (map[string]map[string]any, error)
		sqlite func() (map[string]map[string]any, error)
		fields []reconcile.Field
	}
	targets := map[string]target{
		"calibration": {
			func() (map[string]map[string]any, error) { return store.ReconcileCalibrationRows(ctx, user.String()) },
			func() (map[string]map[string]any, error) { return readSQLiteCalibration(*sqlitePath) },
			reconcile.CalibrationFields(),
		},
		"zones": {
			func() (map[string]map[string]any, error) { return store.ReconcileZoneRows(ctx, user.String()) },
			func() (map[string]map[string]any, error) { return readSQLiteZones(*sqlitePath) },
			reconcile.ZoneFields(),
		},
		"pbs": {
			func() (map[string]map[string]any, error) { return store.ReconcilePersonalBestRows(ctx, user.String()) },
			func() (map[string]map[string]any, error) { return readSQLitePBs(*sqlitePath) },
			reconcile.PersonalBestFields(),
		},
		"activity_load": {
			func() (map[string]map[string]any, error) { return store.ReconcileActivityLoadRows(ctx, user.String()) },
			func() (map[string]map[string]any, error) { return readSQLiteActivityLoad(*sqlitePath) },
			reconcile.ActivityLoadFields(),
		},
		"daily_load": {
			func() (map[string]map[string]any, error) { return store.ReconcileDailyLoadRows(ctx, user.String()) },
			func() (map[string]map[string]any, error) { return readSQLiteDailyLoad(*sqlitePath) },
			reconcile.DailyLoadFields(),
		},
	}
	t, ok := targets[*table]
	if !ok {
		fmt.Fprintf(os.Stderr, "error: unknown -table %q\n", *table)
		os.Exit(2)
	}
	reconcileTable(*table, t.mysql, t.sqlite, t.fields)
}

func reconcileActivities(ctx context.Context, store *storage.Store, user, sqlitePath, provider string) {
	right, err := store.ReconcileActivityRowsByProvider(ctx, user, provider)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error: read MySQL:", err)
		os.Exit(1)
	}
	left, err := readSQLite(sqlitePath, provider)
	if err != nil {
		fmt.Printf("MySQL %s activities: %d\nSQLite side unavailable: %v\n", provider, len(right), err)
		return
	}
	report("activities", filterToRight(left, right), right, reconcile.ActivityFields())
}

func reconcileTable(name string, mysql, sqlite func() (map[string]map[string]any, error), fields []reconcile.Field) {
	right, err := mysql()
	if err != nil {
		fmt.Fprintln(os.Stderr, "error: read MySQL:", err)
		os.Exit(1)
	}
	left, err := sqlite()
	if err != nil {
		fmt.Printf("MySQL %s rows: %d\nSQLite side unavailable: %v\n", name, len(right), err)
		return
	}
	report(name, filterToRight(left, right), right, fields)
}

// filterToRight keeps only left rows whose key is present in right (Go may hold
// a bounded subset), so the diff validates the intersection.
func filterToRight(left, right map[string]map[string]any) map[string]map[string]any {
	out := make(map[string]map[string]any, len(right))
	for k := range right {
		if lv, ok := left[k]; ok {
			out[k] = lv
		}
	}
	return out
}

func report(name string, left, right map[string]map[string]any, fields []reconcile.Field) {
	// Diff only the intersection so a bounded MySQL subset isn't flagged.
	rightFiltered := make(map[string]map[string]any, len(left))
	for k := range left {
		rightFiltered[k] = right[k]
	}
	mismatches := reconcile.Diff(fields, toRows(left), toRows(rightFiltered))
	if len(mismatches) == 0 {
		fmt.Printf("OK: %d %s rows match (of %d MySQL, %d SQLite)\n", len(left), name, len(right), len(left))
		return
	}
	fmt.Printf("FAIL: %d mismatches across %d compared %s rows\n", len(mismatches), len(left), name)
	limit := len(mismatches)
	if limit > 40 {
		limit = 40
	}
	for _, m := range mismatches[:limit] {
		fmt.Println("  " + m.String())
	}
	if len(mismatches) > limit {
		fmt.Printf("  ... and %d more\n", len(mismatches)-limit)
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
