package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/cobra"

	"github.com/zhaochy1990/stride/internal/config"
	"github.com/zhaochy1990/stride/internal/storage"
)

func newBackfillActivityStartGPSCmd() *cobra.Command {
	var (
		commit    bool
		users     []string
		limit     int
		batchSize int
		delay     time.Duration
	)
	c := &cobra.Command{
		Use:   "backfill-activity-start-gps",
		Short: "Backfill activities.start_gps_* from indexed timeseries lookups",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			selected, err := selectActivityStartGPSUsers(
				strings.Split(os.Getenv("STRIDE_ACTIVITY_START_GPS_REAL_USERS"), ","), users,
			)
			if err != nil {
				return err
			}
			options := storage.ActivityStartGPSBackfillOptions{
				UserIDs: selected, Commit: commit, Limit: limit, BatchSize: batchSize, Delay: delay,
			}
			if err := options.Validate(); err != nil {
				return err
			}
			cfg := config.MustLoadMySQLRuntimeFrom(configPath())
			store, err := storage.Open(cfg.MySQL.DSN)
			if err != nil {
				return err
			}
			defer store.Close()
			report, err := store.BackfillActivityStartGPS(context.Background(), options)
			if err != nil {
				return err
			}
			if err := json.NewEncoder(os.Stdout).Encode(report); err != nil {
				return fmt.Errorf("encode activity start GPS backfill report: %w", err)
			}
			if report.Failed > 0 {
				return fmt.Errorf("activity start GPS backfill had %d failures", report.Failed)
			}
			return nil
		},
	}
	f := c.Flags()
	f.BoolVar(&commit, "commit", false, "write and verify cached starts (default dry-run)")
	f.StringSliceVar(&users, "user", nil, "real-user UUID; repeatable or comma-separated")
	f.IntVar(&limit, "limit", 0, "scan at most this many missing activities total (0 = unlimited)")
	f.IntVar(&batchSize, "batch-size", 25, "activity keyset page size (1-500)")
	f.DurationVar(&delay, "delay", 25*time.Millisecond, "delay after every timeseries lookup")
	return c
}

func configPath() string {
	if path := os.Getenv("CONFIG_PATH"); path != "" {
		return path
	}
	return config.DefaultConfigFile
}

func selectActivityStartGPSUsers(allowed, requested []string) ([]string, error) {
	allow := make(map[string]struct{}, len(allowed))
	canonicalAllowed := make([]string, 0, len(allowed))
	for _, raw := range allowed {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		parsed, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			return nil, errors.New("--allowed-user must be a UUID")
		}
		userID := parsed.String()
		if _, exists := allow[userID]; exists {
			continue
		}
		allow[userID] = struct{}{}
		canonicalAllowed = append(canonicalAllowed, userID)
	}
	if len(canonicalAllowed) == 0 {
		return nil, errors.New("real-user allowlist is required")
	}
	if len(requested) == 0 {
		return canonicalAllowed, nil
	}

	selected := make([]string, 0, len(requested))
	seen := make(map[string]struct{}, len(requested))
	for _, raw := range requested {
		for _, selector := range strings.Split(raw, ",") {
			parsed, err := uuid.Parse(strings.TrimSpace(selector))
			if err != nil {
				return nil, errors.New("--user must be a real-user UUID")
			}
			userID := parsed.String()
			if _, ok := allow[userID]; !ok {
				return nil, fmt.Errorf("--user is not in src/migration/src/users.js real-user allowlist: %s", userID)
			}
			if _, ok := seen[userID]; ok {
				continue
			}
			seen[userID] = struct{}{}
			selected = append(selected, userID)
		}
	}
	return selected, nil
}
