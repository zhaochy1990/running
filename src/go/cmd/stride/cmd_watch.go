// Subcommand group `stride watch`: the watch-data sync tool for the Go migration.
// One command tree serves every provider (COROS + Garmin): `login` takes an
// explicit --provider and binds the user; `sync`/`status`/`import-creds` resolve
// the user's bound source from the registry (data/<uid>/config.json, ADR 0010).
// The sync core lives in internal/provider/<name> so a worker job handler can
// drive it too.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
	"github.com/zhaochy1990/x/logger"

	"github.com/zhaochy1990/stride/internal/handlers/compute"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/provider/coros"
	"github.com/zhaochy1990/stride/internal/provider/garmin"
	"github.com/zhaochy1990/stride/internal/registry"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/syncconfig"
)

// newWatchCmd is the parent for the watch-data verbs. It has no Run of its own;
// `stride watch` prints help listing the children.
func newWatchCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "watch",
		Short: "Watch-data sync (COROS + Garmin): login, import-creds, sync, status",
		Long: "Watch-data sync for the Go migration.\n\n" +
			"login binds the user to a provider (written to config.json);\n" +
			"sync/status resolve that binding. Config: config.sync.yml (or\n" +
			"$CONFIG_PATH); MySQL DSN via $STRIDE_SYNC_MYSQL_DSN; data dir via\n" +
			"$STRIDE_DATA_DIR (default ./data).",
	}
	c.AddCommand(
		newWatchLoginCmd(),
		newWatchImportCredsCmd(),
		newWatchSyncCmd(),
		newWatchStatusCmd(),
		newWatchWorkoutCmd(),
	)
	return c
}

func newWatchLoginCmd() *cobra.Command {
	var profile, providerName, email, password, region string
	c := &cobra.Command{
		Use:   "login",
		Short: "Log in to a provider and bind the user to it",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runLogin(profile, providerName, email, password, region)
		},
	}
	f := c.Flags()
	f.StringVarP(&profile, "profile", "P", "", "user UUID or slug")
	f.StringVar(&providerName, "provider", registry.DefaultProvider, "coros | garmin")
	f.StringVar(&email, "email", "", "account email")
	f.StringVar(&password, "password", "", "account password")
	f.StringVar(&region, "region", "", "login region (garmin: cn|global; coros auto-detects)")
	return c
}

func newWatchImportCredsCmd() *cobra.Command {
	var profile, providerName string
	c := &cobra.Command{
		Use:   "import-creds",
		Short: "Seed provider credentials from data/<uid> files",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runImportCreds(profile, providerName)
		},
	}
	f := c.Flags()
	f.StringVarP(&profile, "profile", "P", "", "user UUID or slug")
	f.StringVar(&providerName, "provider", "coros", "coros | garmin")
	return c
}

func newWatchSyncCmd() *cobra.Command {
	var (
		profile string
		content string
		full    bool
		limit   int
	)
	c := &cobra.Command{
		Use:   "sync",
		Short: "Pull latest activities/health from the bound provider",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runSync(profile, full, content, limit)
		},
	}
	f := c.Flags()
	f.StringVarP(&profile, "profile", "P", "", "user UUID or slug")
	f.BoolVar(&full, "full", false, "full re-scan (default incremental)")
	f.StringVar(&content, "content", "all", "all | activities | health")
	f.IntVar(&limit, "limit", 0, "max activities to fetch (0 = unlimited)")
	return c
}

func newWatchStatusCmd() *cobra.Command {
	var profile string
	c := &cobra.Command{
		Use:   "status",
		Short: "Show the bound provider and login state",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runStatus(profile)
		},
	}
	c.Flags().StringVarP(&profile, "profile", "P", "", "user UUID or slug")
	return c
}

// openStore loads config and opens the migrated MySQL store.
func openStore() (*storage.Store, *syncconfig.Config, error) {
	cfg := syncconfig.MustLoad()
	store, err := storage.Open(cfg.MySQL.DSN)
	if err != nil {
		return nil, cfg, err
	}
	if err := store.AutoMigrateWatch(context.Background()); err != nil {
		store.Close()
		return nil, cfg, err
	}
	return store, cfg, nil
}

// resolveProvider builds the adapter the user is bound to (registry lookup).
func resolveProvider(store *storage.Store, cfg *syncconfig.Config, user string) (provider.Provider, string, error) {
	name, err := resolveWatchProviderName(context.Background(), store, dataDir(), user)
	if err != nil {
		return nil, "", err
	}
	prov, err := registry.Build(name, store, cfg.Sync.RequestDelay)
	return prov, name, err
}

func resolveWatchProviderName(ctx context.Context, bindings registry.BindingReader, dir, user string) (string, error) {
	return registry.Resolve(ctx, bindings, dir, user)
}

func runLogin(profile, providerName, email, password, region string) error {
	if !registry.Supported(providerName) {
		return fmt.Errorf("unknown --provider %q (want coros|garmin)", providerName)
	}
	user, err := resolveProfile(profile)
	if err != nil {
		return err
	}
	store, cfg, err := openStore()
	if err != nil {
		return err
	}
	defer store.Close()

	prov, err := registry.Build(providerName, store, cfg.Sync.RequestDelay)
	if err != nil {
		return err
	}
	res, err := prov.Login(context.Background(), user, provider.LoginCredentials{
		Email: email, Password: password, Region: region,
	})
	if err != nil {
		return err
	}
	// Persist the binding so a subsequent flag-less sync resolves this provider.
	if err := registry.WriteProviderName(dataDir(), user, providerName); err != nil {
		return fmt.Errorf("logged in but failed to record provider binding: %w", err)
	}
	fmt.Printf("logged in: user=%s provider=%s region=%s account=%s\n",
		user, providerName, res.Region, res.UserID)
	return nil
}

func runImportCreds(profile, providerName string) error {
	user, err := resolveProfile(profile)
	if err != nil {
		return err
	}
	if providerName == "garmin" {
		return importGarminCreds(user)
	}
	path := filepath.Join(dataDir(), user, "config.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read creds %s: %w", path, err)
	}
	var f struct {
		Email       string `json:"email"`
		PwdHash     string `json:"pwd_hash"`
		AccessToken string `json:"access_token"`
		Region      string `json:"region"`
		UserID      string `json:"user_id"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	store, _, err := openStore()
	if err != nil {
		return err
	}
	defer store.Close()
	cs := coros.NewStorageCredentialStore(store)
	creds := coros.Credentials{Email: f.Email, PwdHash: f.PwdHash, AccessToken: f.AccessToken, Region: f.Region, UserID: f.UserID}
	if err := cs.Save(context.Background(), user, creds); err != nil {
		return err
	}
	if err := registry.WriteProviderName(dataDir(), user, "coros"); err != nil {
		return err
	}
	fmt.Printf("imported coros credentials for user=%s (region=%s)\n", user, f.Region)
	return nil
}

// importGarminCreds seeds the Go credential store from the Python file backend's
// data/<uid>/garmin_auth.json (email + region + garth tokens_dump), so the Go
// shadow sync can reuse an existing garth session without a fresh login.
func importGarminCreds(user string) error {
	path := filepath.Join(dataDir(), user, "garmin_auth.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read garmin creds %s: %w", path, err)
	}
	var f struct {
		Email      string `json:"email"`
		Region     string `json:"region"`
		TokensDump string `json:"tokens_dump"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	if f.Region == "" {
		f.Region = "cn"
	}
	creds, err := garmin.CredentialsFromGarthDump(f.Email, f.Region, f.TokensDump)
	if err != nil {
		return err
	}
	store, _, err := openStore()
	if err != nil {
		return err
	}
	defer store.Close()
	cs := garmin.NewStorageCredentialStore(store)
	if err := cs.Save(context.Background(), user, creds); err != nil {
		return err
	}
	if err := registry.WriteProviderName(dataDir(), user, "garmin"); err != nil {
		return err
	}
	fmt.Printf("imported garmin credentials for user=%s (region=%s)\n", user, f.Region)
	return nil
}

func runSync(profile string, full bool, content string, limit int) error {
	started := time.Now()
	user, err := resolveProfile(profile)
	if err != nil {
		return err
	}
	opts := provider.SyncOptions{Mode: provider.SyncIncremental, Content: contentFlag(content), Limit: limit}
	if full {
		opts.Mode = provider.SyncFull
	}

	store, cfg, err := openStore()
	if err != nil {
		return err
	}
	defer store.Close()
	log := logger.MustGetLogger(&cfg.Logger)
	defer func() { _ = log.Sync() }()

	// Detail-fetch concurrency comes from config (sync.jobs), not a per-call
	// flag — it is an infra knob, and the adapter clamps it to a safe range.
	opts.Jobs = cfg.Sync.Jobs
	progress := newWatchProgress(os.Stdout, stdoutIsTerminal())
	opts.Progress = progress.sync
	defer progress.finish()

	prov, name, err := resolveProvider(store, cfg, user)
	if err != nil {
		return err
	}
	ctx := context.Background()
	res, err := prov.SyncUser(ctx, user, opts)
	if err != nil {
		return err
	}
	if err := runDerivedComputationsWithProgress(ctx, user, opts.Mode, res.ActivityLabelIDs, res.HealthDates,
		compute.NewCalibration(store), compute.NewCompute(store), progress.derivedHeartbeat); err != nil {
		return err
	}
	progress.complete()
	fmt.Printf("sync done: provider=%s activities=%d health=%d jobs=%d elapsed=%s\n",
		name, res.Activities, res.Health, provider.DetailJobs(opts.Jobs), time.Since(started).Round(time.Millisecond))
	return nil
}

// runDerivedComputations runs the same post-sync handlers as the asynchronous
// data-sync pipelines. Full syncs refresh the calibration before rebuilding all
// derived data; incremental syncs compute from this run's changed activity and
// health dates.
func runDerivedComputations(ctx context.Context, user string, mode provider.SyncMode, labelIDs, healthDates []string, calibration, calculation job.Handler) error {
	return runDerivedComputationsWithProgress(ctx, user, mode, labelIDs, healthDates, calibration, calculation, func(string, int) error { return nil })
}

func runDerivedComputationsWithProgress(ctx context.Context, user string, mode provider.SyncMode, labelIDs, healthDates []string, calibration, calculation job.Handler, heartbeat job.Heartbeat) error {
	if mode == provider.SyncFull {
		if _, err := calibration(ctx, &job.Job{UserID: user}, heartbeat); err != nil {
			return fmt.Errorf("calibration: %w", err)
		}
	}

	input, err := json.Marshal(struct {
		Mode        provider.SyncMode `json:"mode"`
		LabelIDs    []string          `json:"label_ids,omitempty"`
		HealthDates []string          `json:"health_dates,omitempty"`
	}{Mode: mode, LabelIDs: labelIDs, HealthDates: healthDates})
	if err != nil {
		return fmt.Errorf("encode compute input: %w", err)
	}
	if _, err := calculation(ctx, &job.Job{UserID: user, InputJSON: string(input)}, heartbeat); err != nil {
		return fmt.Errorf("compute: %w", err)
	}
	return nil
}

func stdoutIsTerminal() bool {
	info, err := os.Stdout.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func runStatus(profile string) error {
	user, err := resolveProfile(profile)
	if err != nil {
		return err
	}
	store, cfg, err := openStore()
	if err != nil {
		return err
	}
	defer store.Close()

	prov, name, err := resolveProvider(store, cfg, user)
	if err != nil {
		return err
	}
	loggedIn, err := prov.IsLoggedIn(user)
	if err != nil {
		return err
	}
	fmt.Printf("user=%s provider=%s logged_in=%v\n", user, name, loggedIn)
	return nil
}

func contentFlag(s string) provider.SyncContent {
	switch s {
	case "activities":
		return provider.ContentActivities
	case "health":
		return provider.ContentHealth
	default:
		return provider.ContentAll
	}
}

// resolveProfile maps a UUID (passed through) or a friendly slug (via
// data/.slug_aliases.json) to the STRIDE user UUID.
func resolveProfile(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("--profile is required")
	}
	if u, err := uuid.Parse(p); err == nil {
		return u.String(), nil
	}
	path := filepath.Join(dataDir(), ".slug_aliases.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("resolve profile %q: %w", p, err)
	}
	var aliases map[string]string
	if err := json.Unmarshal(raw, &aliases); err != nil {
		return "", fmt.Errorf("parse %s: %w", path, err)
	}
	uid, ok := aliases[p]
	if !ok {
		return "", fmt.Errorf("unknown profile %q (not a UUID and not in %s)", p, path)
	}
	return uid, nil
}

// dataDir returns the athlete data root ($STRIDE_DATA_DIR or ./data).
func dataDir() string {
	if d := os.Getenv("STRIDE_DATA_DIR"); d != "" {
		return d
	}
	return "data"
}
