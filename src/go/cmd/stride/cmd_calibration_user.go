// cmd_calibration_user.go is the operator surface of the #999 single-user
// evolved-v4 closed loop: preview (read-only), publish, revoke and a bounded
// derived recompute, all for one explicit target user. It is the "authorized
// retest entrypoint" the ticket leaves for the later authorization stage —
// running it against production still requires the user's explicit go-ahead,
// and it never touches the global policy or any other user.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/cobra"

	"github.com/zhaochy1990/stride/internal/handlers/compute"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

func newCalibrationUserCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "user",
		Short: "Single-user evolved-v4 closed loop (preview/publish/revoke/recompute; explicit target user only)",
		Long: "The #999 per-user calibration loop. preview runs the evolved v4 in memory (no writes). " +
			"publish writes the pinned-identity snapshot and activates the user's override in one transaction " +
			"(idempotent; refuses invalid estimates). revoke restores the global selection (derived rows keep " +
			"their written values until an explicit recompute). recompute rebuilds the derived rows for the " +
			"last --days days under the currently effective selection. The global policy and other users are " +
			"never modified.",
	}
	var user, asOf, actor, note, fileStore string
	var days int
	days = 0
	bind := func(c *cobra.Command, needActor bool) {
		c.Flags().StringVar(&user, "user", "", "target user UUID (required)")
		c.Flags().StringVar(&asOf, "as-of", "", "Shanghai anchor day YYYY-MM-DD (default today)")
		c.Flags().StringVar(&fileStore, "file-store", "", "local tsblob dir override (default: configured COS backend)")
		if needActor {
			c.Flags().StringVar(&actor, "actor", "", "audit: who authorizes this operation (required)")
			c.Flags().StringVar(&note, "note", "", "audit: why")
		}
	}
	// requireFlags enforces the operator contract before any configuration or
	// store access, so misuse can never open a database.
	requireFlags := func(needActor bool) error {
		if user == "" {
			return errors.New("--user is required")
		}
		if _, err := uuid.Parse(user); err != nil {
			return fmt.Errorf("--user must be a canonical UUID: %w", err)
		}
		if needActor && actor == "" {
			return errors.New("--actor is required (authorization audit)")
		}
		return nil
	}
	anchor := func(cmd *cobra.Command) (time.Time, *storage.Store, error) {
		if user == "" {
			return time.Time{}, nil, errors.New("--user is required")
		}
		if _, err := uuid.Parse(user); err != nil {
			return time.Time{}, nil, fmt.Errorf("--user must be a canonical UUID: %w", err)
		}
		day := timefmt.ShanghaiToday()
		if asOf != "" {
			parsed, err := time.Parse("2006-01-02", asOf)
			if err != nil || parsed.Format("2006-01-02") != asOf {
				return time.Time{}, nil, errors.New("--as-of must be a Shanghai YYYY-MM-DD")
			}
			day = parsed
		}
		store, _, err := openTSBlobStack(fileStore)
		if err != nil {
			return time.Time{}, nil, err
		}
		cmd.SilenceUsage = true
		return day, store, nil
	}

	preview := &cobra.Command{
		Use:   "preview",
		Short: "Run the evolved v4 for one user entirely in memory; writes nothing",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			day, store, err := anchor(cmd)
			if err != nil {
				return err
			}
			defer store.Close()
			out, err := compute.PreviewUserEvolvedCalibration(context.Background(), store, user, day)
			if err != nil {
				return err
			}
			return encodeCLIJSON(cmd, out)
		},
	}
	bind(preview, false)

	publish := &cobra.Command{
		Use:   "publish",
		Short: "Publish the evolved snapshot and activate the user's override (one transaction, idempotent)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := requireFlags(true); err != nil {
				return err
			}
			day, store, err := anchor(cmd)
			if err != nil {
				return err
			}
			defer store.Close()
			input, _ := json.Marshal(map[string]any{"action": "publish", "as_of_day": day.Format("2006-01-02"), "actor": actor, "note": note})
			return runUserCalibrationCLI(cmd, store, user, input)
		},
	}
	bind(publish, true)

	revoke := &cobra.Command{
		Use:   "revoke",
		Short: "Revoke the user's override; reads fall back to the global selection",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := requireFlags(true); err != nil {
				return err
			}
			_, store, err := anchor(cmd)
			if err != nil {
				return err
			}
			defer store.Close()
			input, _ := json.Marshal(map[string]any{"action": "revoke", "actor": actor, "note": note})
			return runUserCalibrationCLI(cmd, store, user, input)
		},
	}
	bind(revoke, true)

	recompute := &cobra.Command{
		Use:   "recompute",
		Short: "Rebuild the user's derived rows for the last --days days under the effective selection",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := requireFlags(true); err != nil {
				return err
			}
			if days <= 0 || days > 365 {
				return errors.New("--days must be in 1..365")
			}
			day, store, err := anchor(cmd)
			if err != nil {
				return err
			}
			defer store.Close()
			input, _ := json.Marshal(map[string]any{"action": "recompute", "days": days, "as_of_day": day.Format("2006-01-02"), "actor": actor, "note": note})
			return runUserCalibrationCLI(cmd, store, user, input)
		},
	}
	bind(recompute, true)
	recompute.Flags().IntVar(&days, "days", 30, "recompute window (1..365)")

	command.AddCommand(preview, publish, revoke, recompute)
	return command
}

// runUserCalibrationCLI executes the closed-loop job handler synchronously —
// the same handler the worker registers, so the CLI path and the dispatched
// job path cannot drift.
func runUserCalibrationCLI(cmd *cobra.Command, store *storage.Store, userID string, input json.RawMessage) error {
	out, err := compute.NewUserCalibration(store)(context.Background(), &job.Job{UserID: userID, InputJSON: string(input)}, func(string, int) error { return nil })
	if err != nil {
		if pe, ok := job.AsPermanent(err); ok {
			cmd.SilenceUsage = true
			return fmt.Errorf("user calibration failed (%s): %w", pe.Code, err)
		}
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), out)
	return nil
}

func encodeCLIJSON(cmd *cobra.Command, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), string(raw))
	return nil
}
