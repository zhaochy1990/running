// Command stride-sync is the COROS watch-data sync tool (tracer bullet for the
// Go migration). It wires config → MySQL store → COROS provider and exposes
// login / sync / status. The sync core lives in internal/coros so a worker job
// handler can drive the same code later.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/coros"
	"github.com/zhaochy1990/stride/internal/provider"
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
	fmt.Fprint(os.Stderr, `stride-sync — COROS watch-data sync

usage:
  stride-sync login        -profile <uuid|slug> -email <e> -password <p>
  stride-sync import-creds  -profile <uuid|slug>   (seed creds from data/<uid>/config.json)
  stride-sync sync          -profile <uuid|slug> [-full] [-content all|activities|health] [-limit N]
  stride-sync status        -profile <uuid|slug>

config: config.sync.yml (or $CONFIG_PATH); MySQL DSN via $STRIDE_SYNC_MYSQL_DSN
data dir: $STRIDE_DATA_DIR (default ./data)
`)
}

// deps builds the store and COROS provider from config.
func deps() (*storage.Store, *coros.Provider, error) {
	cfg := syncconfig.MustLoad()
	store, err := storage.Open(cfg.MySQL.DSN)
	if err != nil {
		return nil, nil, err
	}
	if err := store.AutoMigrateWatch(context.Background()); err != nil {
		return nil, nil, err
	}
	prov := coros.New(store, coros.NewStorageCredentialStore(store),
		coros.WithProviderRequestDelay(cfg.Sync.RequestDelay))
	return store, prov, nil
}

func runLogin(args []string) error {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	profile := fs.String("profile", "", "user UUID or slug")
	email := fs.String("email", "", "COROS account email")
	password := fs.String("password", "", "COROS account password")
	_ = fs.Parse(args)

	user, err := resolveProfile(*profile)
	if err != nil {
		return err
	}
	store, prov, err := deps()
	if err != nil {
		return err
	}
	defer store.Close()

	res, err := prov.Login(context.Background(), user, provider.LoginCredentials{Email: *email, Password: *password})
	if err != nil {
		return err
	}
	fmt.Printf("logged in: user=%s region=%s coros_user=%s\n", user, res.Region, res.UserID)
	return nil
}

func runImportCreds(args []string) error {
	fs := flag.NewFlagSet("import-creds", flag.ExitOnError)
	profile := fs.String("profile", "", "user UUID or slug")
	_ = fs.Parse(args)

	user, err := resolveProfile(*profile)
	if err != nil {
		return err
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
	store, _, err := deps()
	if err != nil {
		return err
	}
	defer store.Close()
	cs := coros.NewStorageCredentialStore(store)
	creds := coros.Credentials{Email: f.Email, PwdHash: f.PwdHash, AccessToken: f.AccessToken, Region: f.Region, UserID: f.UserID}
	if err := cs.Save(context.Background(), user, creds); err != nil {
		return err
	}
	fmt.Printf("imported coros credentials for user=%s (region=%s)\n", user, f.Region)
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

	store, prov, err := deps()
	if err != nil {
		return err
	}
	defer store.Close()

	res, err := prov.SyncUser(context.Background(), user, opts)
	if err != nil {
		return err
	}
	fmt.Printf("sync done: activities=%d health=%d\n", res.Activities, res.Health)
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
	store, prov, err := deps()
	if err != nil {
		return err
	}
	defer store.Close()

	loggedIn, err := prov.IsLoggedIn(user)
	if err != nil {
		return err
	}
	fmt.Printf("user=%s provider=coros logged_in=%v\n", user, loggedIn)
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
