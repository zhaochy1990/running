// Command stride is the single entry point for every STRIDE Go service. One
// binary bundles all of them as cobra subcommands (built once, then deployed as
// different container entrypoints, e.g. `stride worker` / `stride api`):
//
//	stride api               HTTP API server fronting the async-job worker (ADR 0012)
//	stride worker            async-job worker: consumes RabbitMQ, persists MySQL (ADR 0001/0002)
//	stride reconcile         Go-MySQL vs Python-SQLite tolerance diff dev tool (ADR 0005)
//	stride watch login       bind a user to a provider and log in (COROS/Garmin)
//	stride watch import-creds seed provider credentials from data/<uid> files
//	stride watch sync        pull latest activities/health from the bound provider
//	stride watch status      show the bound provider + login state
//
// Each subcommand stays thin: parse flags via cobra, wire dependencies, run.
// All logic lives in internal/.
//
// The Swagger general API info below is attached to this file because
// `swag init -g cmd/stride/main.go` reads it from the -g entry package.
//
//	@title						STRIDE API
//	@version					1.0
//	@description				HTTP API fronting the STRIDE worker: create and track async jobs and pipeline runs, and manage user profile, onboarding, and watch-provider login.
//	@securityDefinitions.apikey	InternalToken
//	@in							header
//	@name						X-Internal-Token
//	@description				Shared secret for server-to-server callers.
//	@securityDefinitions.apikey	BearerAuth
//	@in							header
//	@name						Authorization
//	@description				"Bearer <JWT>" for end-user callers (RS256).
package main

import (
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"
)

// watchRequestDelay is the COROS/Garmin per-request rate-limit pause (matches the
// provider default). Shared by the api login adapter, the worker resolver, and
// the sync command, so it lives on the shared root package.
const watchRequestDelay = 500 * time.Millisecond

// watchJobs is the detail-fetch concurrency the worker threads into each watch
// sync (matches config.sync.yml's sync.jobs default and the reference Python
// -j 4). The adapter clamps it to a safe range.
const watchJobs = 4

func main() {
	if err := newRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// newRootCmd builds the `stride` root and attaches every service subcommand.
// SilenceErrors/SilenceUsage keep runtime failures to a single "error: ..."
// line (printed by main) instead of cobra also dumping usage.
func newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "stride",
		Short: "STRIDE Go services: async-job worker, HTTP API, watch-data sync, reconcile",
		Long: "stride is the unified CLI for the STRIDE Go module. Each service is a\n" +
			"subcommand of one binary; containers set the entrypoint (e.g. `stride worker`).",
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	root.AddCommand(
		newAPICmd(),
		newWorkerCmd(),
		newReconcileCmd(),
		newMigrateRunningAgeCmd(),
		newWatchCmd(),
	)
	return root
}
