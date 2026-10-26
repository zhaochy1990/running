// Subcommand `stride tsblob`: the timeseries→COS migration's operational CLIs
// (devops#785 Phase 1).
//
//	stride tsblob backfill   migrate stock activities to blobs (resumable)
//	stride tsblob audit      run the three-part reconciliation (read-only)
//
// Both read the worker's config.yml + STRIDE_WORKER_* env namespace (mysql +
// ts-blob sections only), or --file-store for a local directory backend.
// Executing them against PRODUCTION is the operator's call — the binary ships
// the capability, nothing here schedules it.
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
		Short: "Timeseries→COS migration tooling (backfill + audit)",
		Long: "tsblob operates on the per-activity timeseries blobs.\n" +
			"backfill migrates stock activities (WHERE ts_blob_key IS NULL, resumable);\n" +
			"audit reconciles rows vs pointers vs bucket objects (read-only).",
	}
	c.AddCommand(newTSBlobBackfillCmd(), newTSBlobAuditCmd())
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

func newTSBlobBackfillCmd() *cobra.Command {
	var (
		concurrency int
		fileStore   string
	)
	c := &cobra.Command{
		Use:   "backfill",
		Short: "Migrate stock activities to timeseries blobs (resumable)",
		Long: "Streams activities with a NULL ts_blob_key (keyset pagination per\n" +
			"user, workers fanned out across users), uploads each activity's blob,\n" +
			"and stamps the four pointer columns. Re-running resumes where the\n" +
			"stamped rows left off.",
		Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			if concurrency < 1 || concurrency > 64 {
				return fmt.Errorf("--concurrency must be 1..64 (the stock sizing is 4-8)")
			}
			store, _, err := openTSBlobStack(fileStore)
			if err != nil {
				return err
			}
			defer store.Close()

			b := tsblob.NewBackfill(store)
			b.Concurrency = concurrency
			b.Log = func(format string, args ...any) { fmt.Printf(format+"\n", args...) }
			report, err := b.Run(context.Background())
			out, _ := json.Marshal(report)
			fmt.Println(string(out))
			if err != nil {
				return err
			}
			if !report.OK {
				return fmt.Errorf("backfill completed with %d failed activities (re-run to retry them)", report.Failed)
			}
			return nil
		},
	}
	c.Flags().IntVar(&concurrency, "concurrency", 4, "worker pool across users (stock sizing: 4-8)")
	c.Flags().StringVar(&fileStore, "file-store", "", "use a local directory as the blob backend instead of the configured COS bucket")
	return c
}

func newTSBlobAuditCmd() *cobra.Command {
	var (
		sampleRate float64
		fileStore  string
	)
	c := &cobra.Command{
		Use:   "audit",
		Short: "Reconcile timeseries rows vs blob pointers vs bucket objects (read-only)",
		Long: "The three-part reconciliation (devops#785 AC3): per-user COUNT(*) vs\n" +
			"SUM(ts_point_count); a deterministic 5% sample whose sha256 is recomputed\n" +
			"from rows and cross-checked against the bucket blob; bucket object count\n" +
			"vs pointer count (with the exact set diff named). Exits non-zero when any\n" +
			"part fails — cron the daily soak re-run off this.",
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
				return fmt.Errorf("audit failed: point_sum_ok=%v complete_ok=%v sample_ok=%v objects_ok=%v",
					report.PointSumOK, report.CompleteOK, report.Sample.SampleOK, report.Objects.ObjectsOK)
			}
			return nil
		},
	}
	c.Flags().Float64Var(&sampleRate, "sample-rate", 0.05, "fraction of stamped activities whose checksums are recomputed")
	c.Flags().StringVar(&fileStore, "file-store", "", "use a local directory as the blob backend instead of the configured COS bucket")
	return c
}
