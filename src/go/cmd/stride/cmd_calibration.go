package main

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

type calibrationEvidenceInsufficient struct{}

func (calibrationEvidenceInsufficient) Error() string {
	return "calibration evidence insufficient; see structured report"
}
func (calibrationEvidenceInsufficient) ExitCode() int { return 2 }

func newCalibrationCmd() *cobra.Command {
	command := &cobra.Command{Use: "calibration", Short: "Calibration diagnostics (offline only)"}
	var manifest, code string
	replay := &cobra.Command{Use: "replay", Short: "Compare frozen versions from a local manifest; no database or network access", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		if manifest == "" || code == "" {
			return fmt.Errorf("required: --manifest PATH --code-version COMMIT")
		}
		file, err := os.Open(manifest)
		if err != nil {
			return err
		}
		defer file.Close()
		var reader io.Reader = file
		if strings.HasSuffix(manifest, ".gz") {
			gz, err := gzip.NewReader(file)
			if err != nil {
				return err
			}
			defer gz.Close()
			reader = gz
		}
		decoder := json.NewDecoder(reader)
		decoder.DisallowUnknownFields()
		var input calibration.ReplayManifest
		if err := decoder.Decode(&input); err != nil {
			return err
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			return fmt.Errorf("manifest must contain exactly one JSON value")
		}
		report, err := calibration.Replay(input, code)
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(report); err != nil {
			return err
		}
		if report.Status == "insufficient" {
			return calibrationEvidenceInsufficient{}
		}
		if report.Status != "passed" {
			return fmt.Errorf("calibration replay failed")
		}
		return nil
	}}
	replay.Flags().StringVar(&manifest, "manifest", "", "local immutable JSON or JSON.gz manifest")
	replay.Flags().StringVar(&code, "code-version", "", "exact source commit (required provenance)")
	command.AddCommand(replay)
	return command
}
