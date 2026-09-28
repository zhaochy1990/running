// Subcommand `stride homecity`: runs the resident-city detector
// (internal/homecity) over the MySQL activity store and prints one line per
// user. Default mode is read-only (safe against production with a reader
// account); --write persists via the same RecomputeAll the homecity_recompute
// pipeline runs (user_home_city + history), for operator-triggered refreshes
// and backfills outside the daily cron.
//
// Output columns: user, detected city (district), confidence, source, weighted
// share, vote count, and flags — relocation (prev→city), the trailing-30-day
// recent city when it differs, and secondary cities with their kind
// (seasonal = recurring yearly stint, transient = one bounded camp/trip).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/zhaochy1990/stride/internal/handlers/homecitysync"
	"github.com/zhaochy1990/stride/internal/homecity"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/syncconfig"
)

func newHomeCityCmd() *cobra.Command {
	var (
		profile string
		asJSON  bool
		write   bool
	)
	c := &cobra.Command{
		Use:   "homecity",
		Short: "Detect each user's resident city from activity signals (read-only, or --write to persist)",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runHomeCity(profile, asJSON, write)
		},
	}
	f := c.Flags()
	f.StringVarP(&profile, "profile", "P", "", "restrict to one user UUID (default: all users with activities)")
	f.BoolVar(&asJSON, "json", false, "machine-readable output")
	f.BoolVar(&write, "write", false, "persist results to user_home_city (requires a writable DSN)")
	return c
}

func runHomeCity(profile string, asJSON, write bool) error {
	if write && profile != "" {
		return fmt.Errorf("--write recomputes every user (same scope as the pipeline); drop --profile to print only")
	}
	ctx := context.Background()
	cfg := syncconfig.MustLoad()
	store, err := storage.Open(cfg.MySQL.DSN)
	if err != nil {
		return fmt.Errorf("open mysql: %w", err)
	}

	if write {
		if err := store.AutoMigrateHomeCity(ctx); err != nil {
			return err
		}
		summary, err := homecitysync.RecomputeAll(ctx, store, nil)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		fmt.Printf("homecity recompute persisted: %s\n", encoded)
	}

	userIDs := []string{profile}
	if profile == "" {
		userIDs, err = store.ListActivityUserIDs(ctx)
		if err != nil {
			return fmt.Errorf("list users: %w", err)
		}
	}

	type row struct {
		UserID string          `json:"user_id"`
		Result homecity.Result `json:"result"`
		Error  string          `json:"error,omitempty"`
	}
	rows := make([]row, 0, len(userIDs))
	for _, uid := range userIDs {
		signalsDB, err := store.ListActivityStartSignals(ctx, uid)
		if err != nil {
			rows = append(rows, row{UserID: uid, Error: err.Error()})
			continue
		}
		signals := make([]homecity.ActivitySignal, len(signalsDB))
		for i, s := range signalsDB {
			signals[i] = homecity.ActivitySignal{Name: s.Name, StartGPSLat: s.StartGPSLat, StartGPSLon: s.StartGPSLon, Time: s.Date}
		}
		rows = append(rows, row{UserID: uid, Result: homecity.Detect(signals, homecity.DefaultOptions(time.Now().UTC()))})
	}

	if asJSON {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(rows)
	}

	writer := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(writer, "USER\tCITY\tCONF\tSOURCE\tSHARE\tVOTES\tNOTES")
	for _, r := range rows {
		if r.Error != "" {
			fmt.Fprintf(writer, "%s\tERROR\t\t\t\t\t%s\n", shortID(r.UserID), r.Error)
			continue
		}
		res := r.Result
		place := res.City
		if res.District != "" {
			place += "·" + res.District
		}
		if place == "" {
			place = "(unknown)"
		}
		notes := ""
		if res.Relocated {
			notes += fmt.Sprintf("relocated:%s→%s ", res.PreviousCity, res.City)
		}
		if res.RecentCity != "" {
			notes += fmt.Sprintf("recent:%s ", res.RecentCity)
		}
		sort.SliceStable(res.Secondary, func(i, j int) bool { return res.Secondary[i].WeightedShare > res.Secondary[j].WeightedShare })
		for _, sec := range res.Secondary {
			notes += fmt.Sprintf("2nd:%s(%s %.0f%%) ", sec.City, sec.Kind, sec.WeightedShare*100)
		}
		fmt.Fprintf(writer, "%s\t%s\t%v\t%s\t%.0f%%\t%d\t%s\n",
			shortID(r.UserID), place, res.Confidence, res.Source, res.WeightedShare*100, res.VoteCount, notes)
	}
	return writer.Flush()
}

// shortID keeps the table readable while staying unique enough to match
// against full UUIDs manually.
func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
