// Subcommand `stride tsblob`: the timeseries→COS migration's residual CLI
// (devops#785 Phase 1; reshaped by devops#788 when the row table dropped).
//
//	stride tsblob audit      reconcile pointers vs bucket objects (read-only)
//
// The backfill subcommand retired with the timeseries table — there are no
// rows left to migrate. Reads the worker's config.yml + STRIDE_WORKER_* env
// namespace (mysql + ts-blob sections only), or --file-store for a local
// directory backend. Executing against PRODUCTION is the operator's call —
// the binary ships the capability, nothing here schedules it.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/zhaochy1990/stride/internal/config"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsblob"
	"github.com/zhaochy1990/stride/internal/tsstore"
)

func newTSBlobCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "tsblob",
		Short: "Timeseries→COS migration tooling (audit)",
		Long: "tsblob operates on the per-activity timeseries blobs.\n" +
			"audit reconciles stamped pointers against bucket objects (read-only);\n" +
			"the backfill retired with the dropped timeseries table (devops#788).",
	}
	c.AddCommand(newTSBlobAuditCmd())
	return c
}

// openTSBlobStack resolves config, opens the store, and injects the blob
// backend (--file-store dir overrides the configured COS bucket — the local
// dev backend). It returns the store and the blob backend.
func openTSBlobStack(fileStoreDir string) (*storage.Store, tsstore.Store, error) {
	path := os.Getenv("CONFIG_PATH")
	if path == "" {
		path = config.DefaultConfigFile
	}
	cfg := config.MustLoadTSBlobRuntimeFrom(path)

	store, err := storage.Open(cfg.MySQL.DSN)
	if err != nil {
		return nil, nil, err
	}
	var ts tsstore.Store
	if fileStoreDir != "" {
		fs, err := tsstore.NewFileStore(fileStoreDir)
		if err != nil {
			_ = store.Close()
			return nil, nil, err
		}
		ts = fs
	} else {
		ts, err = newTSBlobStore(cfg.TSBlob)
		if err != nil {
			_ = store.Close()
			return nil, nil, err
		}
	}
	store.SetTSBlobStore(ts)
	return store, ts, nil
}

func newTSBlobAuditCmd() *cobra.Command {
	var (
		sampleRate float64
		fileStore  string
	)
	c := &cobra.Command{
		Use:   "audit",
		Short: "Reconcile blob pointers vs bucket objects (read-only)",
		Long: "The blob-internal reconciliation (devops#785 AC3, reshaped by\n" +
			"devops#788): a deterministic 5% sample whose envelope checksum and\n" +
			"point count are cross-checked against the stamped pointer columns;\n" +
			"bucket object count vs pointer count (with the exact set diff named).\n" +
			"Exits non-zero when any part fails — cron the daily soak re-run off\n" +
			"this.",
		Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			if sampleRate <= 0 || sampleRate > 1 {
				return fmt.Errorf("--sample-rate must be in (0, 1]")
			}
			store, ts, err := openTSBlobStack(fileStore)
			if err != nil {
				return err
			}
			defer store.Close()

			a := tsblob.NewAuditor(store, ts)
			a.SampleRate = sampleRate
			a.Log = func(format string, args ...any) { fmt.Printf(format+"\n", args...) }
			report, err := a.Run(context.Background())
			out, _ := json.Marshal(report)
			fmt.Println(string(out))
			if err != nil {
				return err
			}
			if !report.OK {
				return fmt.Errorf("audit failed: sample_ok=%v objects_ok=%v",
					report.Sample.SampleOK, report.Objects.ObjectsOK)
			}
			return nil
		},
	}
	c.Flags().Float64Var(&sampleRate, "sample-rate", 0.05, "fraction of stamped activities whose checksums are recomputed")
	c.Flags().StringVar(&fileStore, "file-store", "", "use a local directory as the blob backend instead of the configured COS bucket")
	return c
}
