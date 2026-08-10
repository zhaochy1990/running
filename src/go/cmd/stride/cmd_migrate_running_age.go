package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/spf13/cobra"

	"github.com/zhaochy1990/stride/internal/storage"
)

type runningAgeMigrationReport struct {
	Migrated int `json:"migrated"`
	Skipped  int `json:"skipped"`
	Missing  int `json:"missing"`
	Failed   int `json:"failed"`
}

func newMigrateRunningAgeCmd() *cobra.Command {
	var (
		dataDir string
		dryRun  bool
	)
	cmd := &cobra.Command{
		Use:   "migrate-running-age",
		Short: "Migrate legacy running age values into MySQL",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runMigrateRunningAge(dataDir, dryRun)
		},
	}
	cmd.Flags().StringVar(&dataDir, "data-dir", "data", "legacy data directory")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "report changes without writing MySQL")
	return cmd
}

func runMigrateRunningAge(dataDir string, dryRun bool) error {
	ctx := context.Background()
	cfg := loadMigrationConfig()
	if cfg.dsn == "" {
		return fmt.Errorf("STRIDE_WORKER_MYSQL_DSN is required")
	}
	store, err := storage.Open(cfg.dsn)
	if err != nil {
		return err
	}
	defer store.Close()
	if !dryRun {
		if err := store.AutoMigrateUsers(ctx); err != nil {
			return err
		}
	}
	return runRunningAgeMigration(ctx, dataDir, dryRun, store, os.Stdout)
}

type runningAgeMigrationStore interface {
	GetUserProfile(context.Context, string) (*storage.UserProfile, error)
	MigrateRunningAgeIfUnknown(context.Context, string, string) (bool, error)
}

func runRunningAgeMigration(ctx context.Context, dataDir string, dryRun bool, store runningAgeMigrationStore, out io.Writer) error {
	aliases, err := loadRunningAgeAliases(dataDir)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		return fmt.Errorf("read data directory: %w", err)
	}
	report := runningAgeMigrationReport{}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		uid, err := resolveRunningAgeUserID(entry.Name(), aliases)
		if err != nil {
			report.Failed++
			continue
		}
		path := filepath.Join(dataDir, entry.Name(), "running_profile.json")
		body, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			report.Missing++
			continue
		}
		if err != nil {
			report.Failed++
			continue
		}
		var legacy struct {
			Current *struct {
				RunningAge string `json:"running_age"`
			} `json:"current"`
		}
		if err := json.Unmarshal(body, &legacy); err != nil {
			report.Failed++
			continue
		}
		if legacy.Current == nil || legacy.Current.RunningAge == "" {
			report.Missing++
			continue
		}
		runningAge := legacy.Current.RunningAge
		if runningAge == "lt6m" {
			runningAge = "lt_6m"
		}
		if !storage.ValidRunningAgeRange(runningAge) {
			report.Failed++
			continue
		}
		if runningAge == storage.RunningAgeUnknown {
			report.Skipped++
			continue
		}
		profile, err := store.GetUserProfile(ctx, uid)
		if err != nil {
			report.Failed++
			continue
		}
		if profile == nil || profile.RunningAgeRange != storage.RunningAgeUnknown {
			report.Skipped++
			continue
		}
		if !dryRun {
			updated, err := store.MigrateRunningAgeIfUnknown(ctx, uid, runningAge)
			if err != nil {
				report.Failed++
				continue
			}
			if !updated {
				report.Skipped++
				continue
			}
		}
		report.Migrated++
	}
	encoded, _ := json.Marshal(report)
	_, _ = fmt.Fprintln(out, string(encoded))
	return nil
}

func loadRunningAgeAliases(dataDir string) (map[string]string, error) {
	path := filepath.Join(dataDir, ".slug_aliases.json")
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read slug aliases: %w", err)
	}
	var aliases map[string]string
	if err := json.Unmarshal(raw, &aliases); err != nil {
		return nil, fmt.Errorf("parse slug aliases: %w", err)
	}
	if aliases == nil {
		return map[string]string{}, nil
	}
	return aliases, nil
}

func resolveRunningAgeUserID(name string, aliases map[string]string) (string, error) {
	if uid, err := uuid.Parse(name); err == nil {
		return uid.String(), nil
	}
	alias, ok := aliases[name]
	if !ok {
		return "", fmt.Errorf("data directory is not a UUID or known slug")
	}
	uid, err := uuid.Parse(alias)
	if err != nil {
		return "", fmt.Errorf("slug alias does not resolve to a UUID")
	}
	return uid.String(), nil
}

type migrationConfig struct{ dsn string }

func loadMigrationConfig() migrationConfig {
	return migrationConfig{dsn: os.Getenv("STRIDE_WORKER_MYSQL_DSN")}
}
