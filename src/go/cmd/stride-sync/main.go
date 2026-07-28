// Command stride-sync is the watch-data sync tool for the Go migration. One
// binary serves every provider (COROS today, Garmin now): `login` takes an
// explicit -provider; `sync`/`status`/`import-creds` resolve the user's bound
// source from the registry (data/<uid>/config.json, ADR 0010). The sync core
// lives in internal/provider/<name> so a worker job handler can drive it later.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/provider/coros"
	"github.com/zhaochy1990/stride/internal/provider/garmin"
	"github.com/zhaochy1990/stride/internal/registry"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/syncconfig"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	args := os.Args[2:]

	var err error
	switch cmd {
	case "login":
		err = runLogin(args)
	case "import-creds":
		err = runImportCreds(args)
	case "sync":
		err = runSync(args)
	case "status":
		err = runStatus(args)
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `stride-sync — watch-data sync (COROS + Garmin)

usage:
  stride-sync login        -profile <uuid|slug> -provider <coros|garmin> -email <e> -password <p> [-region cn|global]
  stride-sync import-creds  -profile <uuid|slug> [-provider coros|garmin]   (seed creds from data/<uid> files)
  stride-sync sync          -profile <uuid|slug> [-full] [-content all|activities|health] [-limit N]
  stride-sync status        -profile <uuid|slug>

login binds the user to a provider (written to config.json); sync/status resolve it.
config: config.sync.yml (or $CONFIG_PATH); MySQL DSN via $STRIDE_SYNC_MYSQL_DSN
data dir: $STRIDE_DATA_DIR (default ./data)
`)
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
	name, err := registry.ProviderName(dataDir(), user)
	if err != nil {
		return nil, "", err
	}
	prov, err := registry.Build(name, store, cfg.Sync.RequestDelay)
	return prov, name, err
}

func runLogin(args []string) error {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	profile := fs.String("profile", "", "user UUID or slug")
	providerName := fs.String("provider", registry.DefaultProvider, "coros | garmin")
	email := fs.String("email", "", "account email")
	password := fs.String("password", "", "account password")
	region := fs.String("region", "", "login region (garmin: cn|global; coros auto-detects)")
	_ = fs.Parse(args)

	if !registry.Supported(*providerName) {
		return fmt.Errorf("unknown -provider %q (want coros|garmin)", *providerName)
	}
	user, err := resolveProfile(*profile)
	if err != nil {
		return err
	}
	store, cfg, err := openStore()
	if err != nil {
		return err
	}
	defer store.Close()

	prov, err := registry.Build(*providerName, store, cfg.Sync.RequestDelay)
	if err != nil {
		return err
	}
	res, err := prov.Login(context.Background(), user, provider.LoginCredentials{
		Email: *email, Password: *password, Region: *region,
	})
	if err != nil {
		return err
	}
	// Persist the binding so a subsequent flag-less sync resolves this provider.
	if err := registry.WriteProviderName(dataDir(), user, *providerName); err != nil {
		return fmt.Errorf("logged in but failed to record provider binding: %w", err)
	}
	fmt.Printf("logged in: user=%s provider=%s region=%s account=%s\n",
		user, *providerName, res.Region, res.UserID)
	return nil
}

func runImportCreds(args []string) error {
	fs := flag.NewFlagSet("import-creds", flag.ExitOnError)
	profile := fs.String("profile", "", "user UUID or slug")
	providerName := fs.String("provider", "coros", "coros | garmin")
	_ = fs.Parse(args)

	user, err := resolveProfile(*profile)
	if err != nil {
		return err
	}
	if *providerName == "garmin" {
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

func runSync(args []string) error {
	fs := flag.NewFlagSet("sync", flag.ExitOnError)
	profile := fs.String("profile", "", "user UUID or slug")
	full := fs.Bool("full", false, "full re-scan (default incremental)")
	content := fs.String("content", "all", "all | activities | health")
	limit := fs.Int("limit", 0, "max activities to fetch (0 = unlimited)")
	_ = fs.Parse(args)

	user, err := resolveProfile(*profile)
	if err != nil {
		return err
	}
	opts := provider.SyncOptions{Mode: provider.SyncIncremental, Content: contentFlag(*content), Limit: *limit}
	if *full {
		opts.Mode = provider.SyncFull
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
	res, err := prov.SyncUser(context.Background(), user, opts)
	if err != nil {
		return err
	}
	fmt.Printf("sync done: provider=%s activities=%d health=%d\n", name, res.Activities, res.Health)
	return nil
}

func runStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	profile := fs.String("profile", "", "user UUID or slug")
	_ = fs.Parse(args)

	user, err := resolveProfile(*profile)
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
		return "", fmt.Errorf("-profile is required")
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
