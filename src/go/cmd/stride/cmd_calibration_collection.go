package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

// This schema mirrors the frozen collector's serialized structure. Target
// values are read only during an explicitly invoked scoring run.
type frozenCollectionOutcome struct {
	SourceSHA    string     `json:"source_sha"`
	SplitSHA256  string     `json:"split_sha256"`
	OutcomeScope string     `json:"outcome_scope"`
	AvailableAt  *time.Time `json:"available_at"`
	Mode         string     `json:"mode"`
	Plans        []struct {
		ID     string    `json:"case_id"`
		Start  time.Time `json:"window_start"`
		Cutoff time.Time `json:"prediction_as_of"`
		Target struct {
			UserID   string    `json:"user_id"`
			LabelID  string    `json:"label_id"`
			User     string    `json:"user"`
			Root     string    `json:"root_activity_id"`
			Split    string    `json:"split"`
			Effort   string    `json:"effort_support"`
			Event    time.Time `json:"event_at"`
			Duration float64   `json:"duration_s"`
			Distance float64   `json:"distance_m"`
		} `json:"target"`
	} `json:"plans"`
}

type collectionCaseProvenance struct {
	CaseID             string `json:"case_id"`
	BaseFileSHA256     string `json:"base_file_sha256"`
	BaseManifestSHA256 string `json:"base_manifest_sha256"`
	ViewSHA256         string `json:"view_sha256"`
	InputSHA256        string `json:"input_sha256"`
}

func newCalibrationCollectionCmd() *cobra.Command {
	var directory, output, code, asOfText, observedText, indexHash, splitHash, sourceSHA string
	var expectedCases int
	cmd := &cobra.Command{Use: "replay-collection", Short: "Score an immutable local race collection into a new private output directory", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		if directory == "" || output == "" || code == "" || indexHash == "" || splitHash == "" || sourceSHA == "" || expectedCases <= 0 {
			return fmt.Errorf("required collection/output/code-version/expected-inventory-sha256/expected-split-sha256/expected-source-sha/expected-cases")
		}
		reportAsOf, err := time.Parse(time.RFC3339Nano, asOfText)
		if err != nil {
			return err
		}
		observedAt, err := time.Parse(time.RFC3339Nano, observedText)
		if err != nil {
			return err
		}
		indexRaw, err := os.ReadFile(filepath.Join(directory, "artifact-sha256.json"))
		if err != nil {
			return err
		}
		if fileSHA256(indexRaw) != indexHash {
			return fmt.Errorf("frozen artifact inventory hash mismatch")
		}
		var index struct {
			Format string            `json:"format"`
			Files  map[string]string `json:"files"`
		}
		if err := decodeCollectionJSON(indexRaw, &index); err != nil {
			return err
		}
		if index.Format != "sha256-file-inventory/v1" {
			return fmt.Errorf("unknown artifact inventory")
		}
		read := func(name string, target any) error {
			if filepath.Base(name) != name {
				return fmt.Errorf("collection file must be a leaf name")
			}
			raw, err := os.ReadFile(filepath.Join(directory, name))
			if err != nil {
				return err
			}
			if expected, ok := index.Files[name]; !ok || fileSHA256(raw) != expected {
				return fmt.Errorf("frozen collection file hash mismatch: %s", name)
			}
			gz, err := gzip.NewReader(bytes.NewReader(raw))
			if err != nil {
				return err
			}
			defer gz.Close()
			decoded, err := io.ReadAll(gz)
			if err != nil {
				return err
			}
			return decodeCollectionJSON(decoded, target)
		}
		var outcomes frozenCollectionOutcome
		const outcomeFile = "plans-and-independent-outcomes.json.gz"
		if err := read(outcomeFile, &outcomes); err != nil {
			return err
		}
		if outcomes.SourceSHA != sourceSHA || outcomes.SplitSHA256 != splitHash || outcomes.Mode != "event_date_retrospective" || len(outcomes.Plans) != expectedCases {
			return fmt.Errorf("frozen outcome source/split/mode/case inventory mismatch")
		}
		// Verify the observation clock against the frozen collector completion, not
		// a mutable filesystem timestamp or a made-up historical first-available time.
		summaryRaw, err := os.ReadFile(filepath.Join(directory, "collection-summary.json.gz"))
		if err != nil {
			return err
		}
		if fileSHA256(summaryRaw) != index.Files["collection-summary.json.gz"] {
			return fmt.Errorf("collection summary hash mismatch")
		}
		gz, err := gzip.NewReader(bytes.NewReader(summaryRaw))
		if err != nil {
			return err
		}
		var summary struct {
			CompletedAt time.Time `json:"completed_at"`
			SourceSHA   string    `json:"source_sha"`
			SplitSHA256 string    `json:"split_sha256"`
		}
		err = json.NewDecoder(gz).Decode(&summary)
		closeErr := gz.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if !summary.CompletedAt.Equal(observedAt) || summary.SourceSHA != sourceSHA || summary.SplitSHA256 != splitHash || observedAt.After(reportAsOf) {
			return fmt.Errorf("outcome observation clock/source does not match frozen collection completion")
		}
		if err := os.Mkdir(output, 0700); err != nil {
			return err
		}
		sort.Slice(outcomes.Plans, func(i, j int) bool { return outcomes.Plans[i].ID < outcomes.Plans[j].ID })
		aggregate := calibration.ReplayManifest{SchemaVersion: 1, AsOf: reportAsOf, SourceVersion: "frozen-race-collection-v1;source=" + sourceSHA + ";inventory=" + indexHash + ";split=" + splitHash, OutcomeSHA256: index.Files[outcomeFile]}
		var results []calibration.ReplayCaseResult
		var provenance []collectionCaseProvenance
		seen := map[string]bool{}
		canonicalUsers := map[string]string{}
		pseudonyms := map[string]string{}
		for _, plan := range outcomes.Plans {
			if plan.ID == "" || filepath.Base(plan.ID) != plan.ID || strings.ContainsAny(plan.ID, "/\\") || seen[plan.ID] || plan.Target.Split != "final_holdout" {
				return fmt.Errorf("invalid/duplicate frozen target case")
			}
			seen[plan.ID] = true
			if prior, ok := canonicalUsers[plan.Target.User]; ok && prior != plan.Target.UserID {
				return fmt.Errorf("frozen user pseudonym maps to conflicting canonical users")
			}
			if prior, ok := pseudonyms[plan.Target.UserID]; ok && prior != plan.Target.User {
				return fmt.Errorf("frozen canonical user maps to conflicting pseudonyms")
			}
			canonicalUsers[plan.Target.User] = plan.Target.UserID
			pseudonyms[plan.Target.UserID] = plan.Target.User
			var base calibration.ReplayManifest
			name := plan.ID + "-replay-manifest.json.gz"
			if err := read(name, &base); err != nil {
				return err
			}
			if !exactCollectionSourceToken(base.SourceVersion, "readonly-storage-watchmap-tsstore", sourceSHA) || !exactCollectionSourceToken(base.SourceVersion, "frozen-split-sha256", splitHash) {
				return fmt.Errorf("frozen base source provenance mismatch")
			}
			if strings.Contains(strings.ToLower(base.SourceVersion), "synthetic") && !strings.Contains(aggregate.SourceVersion, "synthetic") {
				aggregate.SourceVersion += ";synthetic"
			}
			if len(base.Cases) != 1 || !base.Cases[0].PredictionAsOf.Equal(plan.Cutoff) || !base.AsOf.Equal(plan.Cutoff) {
				return fmt.Errorf("frozen base cutoff mismatch")
			}
			target := calibration.FrozenRaceReplayTarget{CaseID: plan.ID, StorageUserID: plan.Target.UserID, StorageLabelID: plan.Target.LabelID, User: plan.Target.User, RootActivityID: plan.Target.Root, EventAt: plan.Target.Event, DurationS: plan.Target.Duration, DistanceM: plan.Target.Distance, EffortSupport: plan.Target.Effort}
			view, err := calibration.FrozenRaceReplayView(base, target, reportAsOf, observedAt, index.Files[outcomeFile])
			if err != nil {
				return err
			}
			if err := writeCollectionJSON(filepath.Join(output, plan.ID+"-view.json.gz"), view); err != nil {
				return err
			}
			report, err := calibration.Replay(view, code)
			if err != nil {
				return err
			}
			if err := writeCollectionJSON(filepath.Join(output, plan.ID+"-report.json.gz"), report); err != nil {
				return err
			}
			results = append(results, report.Cases...)
			aggregate.Cases = append(aggregate.Cases, view.Cases...)
			aggregate.Activities = append(aggregate.Activities, view.Activities[len(view.Activities)-1])
			provenance = append(provenance, collectionCaseProvenance{CaseID: plan.ID, BaseFileSHA256: index.Files[name], BaseManifestSHA256: view.BaseManifestSHA256, ViewSHA256: report.ManifestSHA256, InputSHA256: report.Cases[0].InputSHA256})
		}
		combined, err := calibration.ReportReplayOutcomes(aggregate, code, results)
		if err != nil {
			return err
		}
		envelope := struct {
			RuleVersion     string                     `json:"rule_version"`
			InventorySHA256 string                     `json:"inventory_sha256"`
			OutcomeSHA256   string                     `json:"outcome_sha256"`
			ObservedAt      time.Time                  `json:"outcome_observed_at"`
			Cases           []collectionCaseProvenance `json:"case_provenance"`
			Report          calibration.ReplayReport   `json:"report"`
		}{"independent-race-collection-view-v1", indexHash, index.Files[outcomeFile], observedAt, provenance, combined}
		if err := writeCollectionJSON(filepath.Join(output, "aggregate-report.json.gz"), envelope); err != nil {
			return err
		}
		// Stdout is aggregate status and hashes only; all case-level results remain
		// in explicitly private local files, never implicitly published.
		if err := json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"status": combined.Status, "accuracy_status": combined.AccuracyStatus, "release_ready": combined.ReleaseReady, "inventory_sha256": indexHash, "outcome_sha256": index.Files[outcomeFile], "cases": len(provenance), "report_path": filepath.Join(output, "aggregate-report.json.gz")}); err != nil {
			return err
		}
		return calibrationReplayExit(combined)
	}}
	cmd.Flags().StringVar(&directory, "collection-dir", "", "immutable private collection directory")
	cmd.Flags().StringVar(&output, "output-dir", "", "new private output directory; must not exist")
	cmd.Flags().StringVar(&code, "code-version", "", "frozen implementation commit")
	cmd.Flags().StringVar(&asOfText, "report-as-of", "", "fixed RFC3339 report time")
	cmd.Flags().StringVar(&observedText, "outcome-observed-at", "", "frozen collector completed_at; not historical availability")
	cmd.Flags().StringVar(&indexHash, "expected-inventory-sha256", "", "pre-run frozen file inventory hash")
	cmd.Flags().StringVar(&splitHash, "expected-split-sha256", "", "pre-run frozen split hash")
	cmd.Flags().StringVar(&sourceSHA, "expected-source-sha", "", "frozen collection source commit")
	cmd.Flags().IntVar(&expectedCases, "expected-cases", 0, "pre-run declared target count")
	return cmd
}

func fileSHA256(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
func decodeCollectionJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("collection file must contain one JSON value")
	}
	return nil
}
func writeCollectionJSON(path string, value any) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(file)
	encodeErr := json.NewEncoder(gz).Encode(value)
	zipErr := gz.Close()
	closeErr := file.Close()
	if encodeErr != nil {
		return encodeErr
	}
	if zipErr != nil {
		return zipErr
	}
	return closeErr
}

func exactCollectionSourceToken(source, key, value string) bool {
	count := 0
	for _, token := range strings.Split(source, ";") {
		k, v, ok := strings.Cut(token, ":")
		if ok && k == key {
			if v != value {
				return false
			}
			count++
		}
	}
	return count == 1
}
