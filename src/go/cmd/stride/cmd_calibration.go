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
	"github.com/zhaochy1990/stride/internal/compute/calibrationsource"
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
	command.AddCommand(replay, newCalibrationPublicDataCmd())
	return command
}

func newCalibrationPublicDataCmd() *cobra.Command {
	var format, input, labels, code, strategy string
	command := &cobra.Command{Use: "public-data", Short: "Inspect local public research data; no database or network access", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		if format == "" || input == "" || code == "" {
			return fmt.Errorf("required: --format FORMAT --input PATH --code-version COMMIT")
		}
		raw, err := os.ReadFile(input)
		if err != nil {
			return err
		}
		var annotations []byte
		if labels != "" {
			annotations, err = os.ReadFile(labels)
			if err != nil {
				return err
			}
		}
		report, err := calibrationsource.InspectPublicData(format, raw, annotations, calibration.Strategy(strategy), code)
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(report); err != nil {
			return err
		}
		return calibrationEvidenceInsufficient{}
	}}
	command.Flags().StringVar(&format, "format", "", "fitrec-jsonl, trinity-stage-csv, or osf-60min-csv")
	command.Flags().StringVar(&input, "input", "", "local input; never downloaded or persisted by this command")
	command.Flags().StringVar(&labels, "labels", "", "optional local Trinity author-label JSON")
	command.Flags().StringVar(&code, "code-version", "", "exact source commit (required provenance)")
	command.Flags().StringVar(&strategy, "strategy", "v3", "explicit offline calibration strategy")
	return command
}
