// Subcommand `stride reconcile`: compares the Go-written MySQL shadow store
// against the Python SQLite store for one user, using the tolerance-aware diff
// engine (internal/reconcile, ADR 0005). It reads the SQLite side with the
// pure-Go modernc.org/sqlite driver. A manual dev tool.
//
// --table selects what to reconcile: activities (default, provider-filtered),
// calibration, zones, pbs, activity_load, daily_load (the onboarding_compute
// derived tables, ADR 0015), and the COROS health-domain tables dashboard,
// daily_hrv, race_predictions. The derived tables validate only rows present in
// BOTH stores; note the PMC daily_load is path-dependent, so a clean diff needs
// both sides computed over the same window/inputs. The health tables likewise
// reflect the latest sync on each side, so run both syncs before reconciling.
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/google/uuid"
	"github.com/spf13/cobra"

	"github.com/zhaochy1990/stride/internal/reconcile"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/syncconfig"
)

func newReconcileCmd() *cobra.Command {
	var (
		profile      string
		sqlitePath   string
		providerName string
		table        string
	)
	c := &cobra.Command{
		Use:   "reconcile",
		Short: "Diff the Go MySQL shadow store vs the Python SQLite store (dev tool)",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runReconcile(profile, sqlitePath, providerName, table)
		},
	}
	f := c.Flags()
	f.StringVarP(&profile, "profile", "P", "", "user UUID")
	f.StringVar(&sqlitePath, "sqlite", "", "path to the Python coros.db (SQLite)")
	f.StringVar(&providerName, "provider", "coros", "provider to reconcile (coros|garmin), activities only")
	f.StringVar(&table, "table", "activities", "activities|calibration|zones|pbs|activity_load|daily_load|dashboard|daily_hrv|race_predictions")
	return c
}

func runReconcile(profile, sqlitePath, providerName, table string) error {
	user, err := uuid.Parse(profile)
	if err != nil {
		return fmt.Errorf("--profile must be a user UUID")
	}
	ctx := context.Background()

	cfg := syncconfig.MustLoad()
	store, err := storage.Open(cfg.MySQL.DSN)
	if err != nil {
		return err
	}
	defer store.Close()

	if table == "activities" {
		reconcileActivities(ctx, store, user.String(), sqlitePath, providerName)
		return nil
	}

	type target struct {
		mysql  func() (map[string]map[string]any, error)
		sqlite func() (map[string]map[string]any, error)
		fields []reconcile.Field
	}
	targets := map[string]target{
		"calibration": {
			func() (map[string]map[string]any, error) { return store.ReconcileCalibrationRows(ctx, user.String()) },
			func() (map[string]map[string]any, error) { return readSQLiteCalibration(sqlitePath) },
			reconcile.CalibrationFields(),
		},
		"zones": {
			func() (map[string]map[string]any, error) { return store.ReconcileZoneRows(ctx, user.String()) },
			func() (map[string]map[string]any, error) { return readSQLiteZones(sqlitePath) },
			reconcile.ZoneFields(),
		},
		"pbs": {
			func() (map[string]map[string]any, error) { return store.ReconcilePersonalBestRows(ctx, user.String()) },
			func() (map[string]map[string]any, error) { return readSQLitePBs(sqlitePath) },
			reconcile.PersonalBestFields(),
		},
		"activity_load": {
			func() (map[string]map[string]any, error) { return store.ReconcileActivityLoadRows(ctx, user.String()) },
			func() (map[string]map[string]any, error) { return readSQLiteActivityLoad(sqlitePath) },
			reconcile.ActivityLoadFields(),
		},
		"daily_load": {
			func() (map[string]map[string]any, error) { return store.ReconcileDailyLoadRows(ctx, user.String()) },
			func() (map[string]map[string]any, error) { return readSQLiteDailyLoad(sqlitePath) },
			reconcile.DailyLoadFields(),
		},
		"dashboard": {
			func() (map[string]map[string]any, error) { return store.ReconcileDashboardRows(ctx, user.String()) },
			func() (map[string]map[string]any, error) { return readSQLiteDashboard(sqlitePath) },
			reconcile.DashboardFields(),
		},
		"daily_hrv": {
			func() (map[string]map[string]any, error) { return store.ReconcileDailyHRVRows(ctx, user.String()) },
			func() (map[string]map[string]any, error) { return readSQLiteDailyHRV(sqlitePath) },
			reconcile.DailyHRVFields(),
		},
		"race_predictions": {
			func() (map[string]map[string]any, error) {
				return store.ReconcileRacePredictionRows(ctx, user.String())
			},
			func() (map[string]map[string]any, error) { return readSQLiteRacePredictions(sqlitePath) },
			reconcile.RacePredictionFields(),
		},
	}
	t, ok := targets[table]
	if !ok {
		return fmt.Errorf("unknown --table %q", table)
	}
	reconcileTable(table, t.mysql, t.sqlite, t.fields)
	return nil
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
