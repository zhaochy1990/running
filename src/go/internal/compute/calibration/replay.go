package calibration

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

//go:embed evaluation-protocol-v1.md
var evaluationProtocol []byte

// ReplayManifest is a local immutable export, not a production storage contract.
// Activity timestamps retain the domain's Shanghai civil-day representation;
// EventTime/AvailableAt are actual instants, including all derived content.
type ReplayManifest struct {
	SchemaVersion      int              `json:"schema_version"`
	AsOf               time.Time        `json:"as_of"`
	SourceVersion      string           `json:"source_version"`
	Activities         []ReplayActivity `json:"activities"`
	Health             []ReplayHealth   `json:"health,omitempty"`
	Cases              []ReplayCase     `json:"cases"`
	RequiredStrata     []string         `json:"required_strata,omitempty"`
	BaseManifestSHA256 string           `json:"base_manifest_sha256,omitempty"`
	OutcomeSHA256      string           `json:"outcome_sha256,omitempty"`
}

type ReplayActivity struct {
	ID                   string             `json:"id"`
	User                 string             `json:"user"`
	RootActivityID       string             `json:"root_activity_id"`
	Split                string             `json:"split"`
	EventTime            time.Time          `json:"event_time"`
	AvailableAt          *time.Time         `json:"available_at"`
	AvailabilityEvidence string             `json:"availability_evidence"`
	Device               string             `json:"device"`
	Scenarios            []string           `json:"scenarios"`
	ContentSHA256        string             `json:"content_sha256"`
	Activity             Activity           `json:"activity"`
	Reference            *ReplayReference   `json:"reference,omitempty"`
	InputEvidence        *CandidateMetadata `json:"input_evidence,omitempty"`
}

type ReplayHealth struct {
	ID                   string     `json:"id"`
	User                 string     `json:"user"`
	EventTime            time.Time  `json:"event_time"`
	AvailableAt          *time.Time `json:"available_at"`
	AvailabilityEvidence string     `json:"availability_evidence"`
	ContentSHA256        string     `json:"content_sha256"`
	Row                  HealthRow  `json:"row"`
}

// References are manually audited, independent measured outcomes. Neither
// activity name, feel_type nor the model's own HR/pace qualifies a reference.
type ReplayReference struct {
	Kind                     string         `json:"kind"` // direct_60min, race_prediction, constraint_only
	Real                     bool           `json:"real"`
	EffortSupport            string         `json:"effort_support"`
	MeasurementQuality       string         `json:"measurement_quality"`
	EvidenceRef              string         `json:"evidence_ref"`
	Protocol                 string         `json:"protocol"`
	AvailableAt              *time.Time     `json:"available_at"`
	DurationS                float64        `json:"duration_s"`
	DistanceM                float64        `json:"distance_m"`
	HRGrade                  string         `json:"hr_grade"` // lab_lthr, field_hr_proxy, training_hr
	HRBpm                    *float64       `json:"hr_bpm,omitempty"`
	ContinuousVerified       *bool          `json:"continuous_verified,omitempty"`
	HRAudit                  *ReplayHRAudit `json:"hr_audit,omitempty"`
	MeasurementRelativeError *float64       `json:"measurement_relative_error,omitempty"`
}

type ReplayCase struct {
	ID                   string    `json:"id"`
	User                 string    `json:"user"`
	PredictionAsOf       time.Time `json:"prediction_as_of"`
	Mode                 string    `json:"mode"` // strict or event_date_retrospective
	TargetRootActivityID string    `json:"target_root_activity_id,omitempty"`
}

type ReplayCaseResult struct {
	ID                    string              `json:"id"`
	User                  string              `json:"user"`
	Mode                  string              `json:"mode"`
	PredictionAsOf        time.Time           `json:"prediction_as_of"`
	TargetRootActivityID  string              `json:"target_root_activity_id,omitempty"`
	InputSHA256           string              `json:"input_sha256"`
	Activities            int                 `json:"activities"`
	IndependentActivities int                 `json:"independent_activities"`
	Excluded              map[string]int      `json:"excluded"`
	Versions              []OfflineResult     `json:"versions"`
	Failures              map[Strategy]string `json:"failures,omitempty"`
}

type ReplayReport struct {
	Status                  string                   `json:"status"`
	SidecarSHA256           string                   `json:"sidecar_sha256,omitempty"`
	EvaluationInputSHA256   string                   `json:"evaluation_input_sha256"`
	EvaluationEngineVersion string                   `json:"evaluation_engine_version"`
	EngineeringStatus       string                   `json:"engineering_status"`
	AccuracyStatus          string                   `json:"accuracy_status"`
	ReleaseReady            bool                     `json:"release_ready"`
	ReleaseBlockers         []string                 `json:"release_blockers"`
	FailureKind             string                   `json:"failure_kind,omitempty"`
	Cohorts                 []ReplayCohortEvaluation `json:"cohorts"`
	QualityChecks           []ReplayQualityCheck     `json:"quality_checks"`
	Gates                   []ReplayGate             `json:"gates"`
	Reasons                 []string                 `json:"reasons"`
	SchemaVersion           int                      `json:"schema_version"`
	AsOf                    time.Time                `json:"as_of"`
	CodeVersion             string                   `json:"code_version"`
	SourceVersion           string                   `json:"source_version"`
	ManifestSHA256          string                   `json:"manifest_sha256"`
	V3SourceSHA256          string                   `json:"v3_source_sha256"`
	ProtocolSHA256          string                   `json:"protocol_sha256"`
	Inventory               ReplayInventory          `json:"inventory"`
	Cases                   []ReplayCaseResult       `json:"cases"`
	ValidationEvaluation    ReplayEvaluation         `json:"validation_evaluation"`
	Evaluation              ReplayEvaluation         `json:"evaluation"`
	BaseManifestSHA256      string                   `json:"base_manifest_sha256,omitempty"`
	OutcomeSHA256           string                   `json:"outcome_sha256,omitempty"`
}

type ReplayInventory struct {
	MissingLabels             int            `json:"missing_labels"`
	UnknownHealthAvailability int            `json:"unknown_health_availability"`
	CasesByMode               map[string]int `json:"cases_by_mode"`
	Users                     int            `json:"users"`
	Activities                int            `json:"activities"`
	IndependentActivities     int            `json:"independent_activities"`
	UnknownAvailability       int            `json:"unknown_availability"`
	Devices                   map[string]int `json:"devices"`
	Scenarios                 map[string]int `json:"scenarios"`
	Labels                    map[string]int `json:"labels"`
	HRGrades                  map[string]int `json:"hr_grades"`
	MeasurementQuality        map[string]int `json:"measurement_quality"`
}

// ReplayContentHash hashes the decoded domain payload, independent of JSON
// whitespace/key order in an export. CLI strictly rejects unknown JSON fields.
func ReplayContentHash(value any) string {
	b, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(b)
	return hex.EncodeToString(digest[:])
}

func hashBytes(b []byte) string { d := sha256.Sum256(b); return hex.EncodeToString(d[:]) }

func available(event time.Time, at *time.Time, proof string, cutoff time.Time, mode string) bool {
	if event.After(cutoff) {
		return false
	}
	if at != nil && at.After(cutoff) {
		return false
	}
	return mode == "event_date_retrospective" || at != nil && proof != ""
}

// Replay compares three strategies against identical frozen inputs. No DB,
// network, wall clock, random source, storage write or environment setting is used.
func Replay(m ReplayManifest, codeVersion string) (ReplayReport, error) {
	return replay(m, codeVersion, nil)
}

func replay(m ReplayManifest, codeVersion string, sidecar *ReplayEvaluationSidecar) (ReplayReport, error) {
	if err := validateReplay(m, codeVersion); err != nil {
		return ReplayReport{}, err
	}
	evaluationManifest, err := applyReplaySidecar(m, codeVersion, sidecar)
	if err != nil {
		return ReplayReport{}, err
	}
	out := ReplayReport{BaseManifestSHA256: m.BaseManifestSHA256, OutcomeSHA256: m.OutcomeSHA256, Status: "insufficient", SchemaVersion: 1, AsOf: m.AsOf, CodeVersion: codeVersion, SourceVersion: m.SourceVersion, ManifestSHA256: ReplayContentHash(m), V3SourceSHA256: FrozenV3SourceSHA256(), ProtocolSHA256: hashBytes(evaluationProtocol), Inventory: inventory(m)}
	activities := append([]ReplayActivity(nil), m.Activities...)
	sort.Slice(activities, func(i, j int) bool { return activities[i].ID < activities[j].ID })
	health := append([]ReplayHealth(nil), m.Health...)
	sort.Slice(health, func(i, j int) bool { return health[i].ID < health[j].ID })
	sortedCases := append([]ReplayCase(nil), m.Cases...)
	sort.Slice(sortedCases, func(i, j int) bool { return sortedCases[i].ID < sortedCases[j].ID })
	for _, c := range sortedCases {
		result := ReplayCaseResult{ID: c.ID, User: c.User, Mode: c.Mode, PredictionAsOf: c.PredictionAsOf, TargetRootActivityID: c.TargetRootActivityID, Excluded: map[string]int{}}
		var history []Activity
		var inputMetadata []CandidateMetadata
		var rows []HealthRow
		var usedActivities []ReplayActivity
		var usedHealth []ReplayHealth
		roots := map[string]bool{}
		for _, a := range activities {
			if a.User != c.User {
				continue
			}
			switch {
			case a.Split != "train" || a.RootActivityID == c.TargetRootActivityID:
				result.Excluded["heldout_or_validation"]++
			case !available(a.EventTime, a.AvailableAt, a.AvailabilityEvidence, c.PredictionAsOf, c.Mode):
				result.Excluded["future_or_unavailable"]++
			default:
				history = append(history, a.Activity)
				// Effort metadata is independent of outcome labels and is admitted
				// only with its own as-known-at-the-time proof in strict mode.
				if a.InputEvidence != nil && !available(a.EventTime, a.InputEvidence.AvailableAt, a.InputEvidence.AvailabilityEvidence, c.PredictionAsOf, c.Mode) {
					a.InputEvidence = nil
					result.Excluded["metadata_future_or_unavailable"]++
				}
				meta := CandidateMetadata{ActivityID: a.Activity.LabelID, RootActivityID: a.RootActivityID, SourceVersion: "replay-root-v1", Device: a.Device}
				if a.InputEvidence != nil {
					meta = *a.InputEvidence
					meta.RootActivityID = a.RootActivityID
					if meta.Device == "" {
						meta.Device = a.Device
					}
				}
				inputMetadata = append(inputMetadata, meta)
				// Reference labels never enter the fitting payload or input hash.
				a.Reference = nil
				usedActivities = append(usedActivities, a)
				roots[a.RootActivityID] = true
			}
		}
		for _, h := range health {
			if h.User != c.User {
				continue
			}
			if !available(h.EventTime, h.AvailableAt, h.AvailabilityEvidence, c.PredictionAsOf, c.Mode) {
				result.Excluded["health_future_or_unavailable"]++
				continue
			}
			rows = append(rows, h.Row)
			usedHealth = append(usedHealth, h)
		}
		result.Activities = len(history)
		result.IndependentActivities = len(roots)
		result.InputSHA256 = ReplayContentHash(struct {
			Activities []ReplayActivity
			Health     []ReplayHealth
			AsOf       time.Time
		}{usedActivities, usedHealth, c.PredictionAsOf})
		// asOf is a domain civil day, whereas availability above uses exact instants.
		civilDay := timefmt.ShanghaiDay(c.PredictionAsOf)
		for _, strategy := range []Strategy{StrategyV3, StrategySegmentsOnly, StrategyCandidate} {
			v, err := estimateOfflineWithEvidenceAt(strategy, history, civilDay, rows, inputMetadata, c.PredictionAsOf)
			if err != nil {
				if result.Failures == nil {
					result.Failures = map[Strategy]string{}
				}
				result.Failures[strategy] = "offline_estimator_error"
				continue
			}
			if ReplayContentHash(v) == "" {
				if result.Failures == nil {
					result.Failures = map[Strategy]string{}
				}
				result.Failures[strategy] = "nonfinite_estimator_output"
				continue
			}
			result.Versions = append(result.Versions, v)
		}
		out.Cases = append(out.Cases, result)
	}
	return reportReplayOutcomes(m, evaluationManifest, codeVersion, out, sidecar)
}

// ReportReplayOutcomes renders already-fitted, sealed cases with the same
// scoring and state reduction used by Replay. It never reruns fitting.
func ReportReplayOutcomes(m ReplayManifest, code string, cases []ReplayCaseResult) (ReplayReport, error) {
	var err error
	cases, err = serializableReplayResults(cases)
	if err != nil {
		return ReplayReport{}, err
	}
	out := ReplayReport{Status: "insufficient", SchemaVersion: 1, AsOf: m.AsOf, CodeVersion: code, SourceVersion: m.SourceVersion, ManifestSHA256: ReplayContentHash(m), V3SourceSHA256: FrozenV3SourceSHA256(), ProtocolSHA256: hashBytes(evaluationProtocol), Inventory: inventory(m), Cases: cases, BaseManifestSHA256: m.BaseManifestSHA256, OutcomeSHA256: m.OutcomeSHA256}
	return reportReplayOutcomes(m, m, code, out, nil)
}
func serializableReplayResults(cases []ReplayCaseResult) ([]ReplayCaseResult, error) {
	out := append([]ReplayCaseResult(nil), cases...)
	for i, c := range out {
		failures := map[Strategy]string{}
		for strategy, reason := range c.Failures {
			failures[strategy] = reason
		}
		versions := make([]OfflineResult, 0, len(c.Versions))
		seen := map[Strategy]bool{}
		for _, v := range c.Versions {
			if seen[v.Strategy] || failures[v.Strategy] != "" {
				return nil, fmt.Errorf("duplicate sealed strategy result/failure")
			}
			seen[v.Strategy] = true
			if ReplayContentHash(v) == "" {
				failures[v.Strategy] = "nonfinite_sealed_output"
			} else {
				versions = append(versions, v)
			}
		}
		out[i].Versions = versions
		if len(failures) > 0 {
			out[i].Failures = failures
		}
	}
	return out, nil
}

func reportReplayOutcomes(m, evaluationManifest ReplayManifest, codeVersion string, out ReplayReport, sidecar *ReplayEvaluationSidecar) (ReplayReport, error) {
	var err error
	out.EvaluationInputSHA256 = ReplayContentHash(struct {
		Base    string
		Sidecar *ReplayEvaluationSidecar
	}{out.ManifestSHA256, sidecar})
	if sidecar != nil {
		out.SidecarSHA256 = ReplayContentHash(sidecar)
	}
	out.Cohorts, out.QualityChecks, err = EvaluateReplayOutcomes(evaluationManifest, out.Cases)
	if err != nil {
		return ReplayReport{}, err
	}
	out.Evaluation = legacyReplayEvaluation(out.Cohorts, "final_holdout")
	out.ValidationEvaluation = legacyReplayEvaluation(out.Cohorts, "validation")
	out.EvaluationEngineVersion = "replay_evaluation_v2"
	var deterministic ReplayGate
	out.EngineeringStatus, deterministic = replayEngineering(sidecar)
	out.AccuracyStatus = "passed"
	for _, cohort := range out.Cohorts {
		if cohort.Split != "final_holdout" || cohort.Mode != "strict" {
			continue
		}
		for _, g := range cohort.Gates {
			g.ID = cohort.Family + "." + g.ID
			out.Gates = append(out.Gates, g)
		}
	}
	if syntheticReplay(m) {
		out.Gates = append(out.Gates, ReplayGate{ID: "real_reference_provenance", Status: "insufficient", Threshold: "independent real references", Reason: "synthetic_source_cannot_establish_accuracy"})
	}
	out.AccuracyStatus = gateReduction(out.Gates)
	out.Gates = append(out.Gates, deterministic)
	engineeringGate := ReplayGate{ID: "engineering_acceptance", Status: "insufficient", Threshold: "verified deterministic/E2E/review evidence for exact code version", Unit: "evidence", Observed: out.EngineeringStatus}
	if out.EngineeringStatus == "passed" {
		engineeringGate.Status = "pass"
	}
	if out.EngineeringStatus == "failed" {
		engineeringGate.Status = "fail"
	}
	out.Gates = append(out.Gates, engineeringGate)
	out.Status = gateReduction(out.Gates)
	out.ReleaseReady = out.Status == "passed" && out.EngineeringStatus == "passed"
	for _, g := range out.Gates {
		if g.Status != "pass" {
			out.ReleaseBlockers = append(out.ReleaseBlockers, g.ID+":"+g.Status)
		}
	}
	if out.EngineeringStatus != "passed" {
		out.ReleaseBlockers = append(out.ReleaseBlockers, "external_engineering_acceptance_not_supplied")
	}
	out.Reasons = []string{"candidate_hour_capability_v1_research_parameters_uncalibrated", "candidate_independent_HR_v1_research_parameters_uncalibrated"}
	if out.Inventory.UnknownAvailability > 0 {
		out.Reasons = append(out.Reasons, "historical_availability_not_proven_for_all_exported_inputs")
	}
	if out.Status == "failed" {
		out.FailureKind = "numeric_gate_failed"
		if out.EngineeringStatus == "failed" {
			out.FailureKind = "engineering_acceptance_failed"
		}
		for _, c := range out.Cases {
			if len(c.Failures) > 0 {
				out.FailureKind = "computation_failed"
				break
			}
		}
	}

	return out, nil
}

func inventory(m ReplayManifest) ReplayInventory {
	out := ReplayInventory{Activities: len(m.Activities), Devices: map[string]int{}, Scenarios: map[string]int{}, Labels: map[string]int{}, HRGrades: map[string]int{}, MeasurementQuality: map[string]int{}}
	users, roots := map[string]bool{}, map[string]bool{}
	for _, a := range m.Activities {
		users[a.User] = true
		roots[a.User+"/"+a.RootActivityID] = true
		device := a.Device
		if device == "" {
			device = "unknown"
		}
		out.Devices[device]++
		for _, s := range a.Scenarios {
			out.Scenarios[s]++
		}
		if a.AvailableAt == nil || a.AvailabilityEvidence == "" {
			out.UnknownAvailability++
		}
		if a.Reference != nil {
			out.Labels[a.Reference.Kind]++
			quality := a.Reference.MeasurementQuality
			if quality == "" {
				quality = "not_recorded"
			}
			out.MeasurementQuality[quality]++
			if a.Reference.HRGrade != "" {
				out.HRGrades[a.Reference.HRGrade]++
			}
		}
	}
	for _, h := range m.Health {
		if h.AvailableAt == nil || h.AvailabilityEvidence == "" {
			out.UnknownHealthAvailability++
		}
	}
	out.MissingLabels = len(m.Activities)
	for _, n := range out.Labels {
		out.MissingLabels -= n
	}
	out.CasesByMode = map[string]int{}
	for _, c := range m.Cases {
		out.CasesByMode[c.Mode]++
	}
	out.Users = len(users)
	out.IndependentActivities = len(roots)
	return out
}

func validateReplay(m ReplayManifest, code string) error {
	if ReplayContentHash(m) == "" {
		return fmt.Errorf("manifest contains invalid nonfinite values")
	}
	if m.SchemaVersion != 1 || m.AsOf.IsZero() || m.SourceVersion == "" || code == "" || len(m.Cases) == 0 {
		return fmt.Errorf("replay requires schema_version=1, as_of, source_version, code_version and cases")
	}
	roots := map[string]string{}
	sourceRoots := map[string]string{}
	ids := map[string]bool{}
	bounds := map[string]map[string][2]time.Time{}
	for _, a := range m.Activities {
		if a.ID == "" || a.User == "" || a.RootActivityID == "" || a.EventTime.IsZero() || a.Activity.ActivityDate.IsZero() || a.Activity.LabelID == "" {
			return fmt.Errorf("activity requires id/user/root/event_time/domain date/label")
		}
		if a.InputEvidence != nil {
			meta := a.InputEvidence
			if meta.ActivityID != a.Activity.LabelID || meta.SourceVersion == "" || meta.RootActivityID != "" && meta.RootActivityID != a.RootActivityID {
				return fmt.Errorf("activity %s input evidence identity/version/root mismatch", a.ID)
			}
			if meta.AvailableAt != nil && meta.AvailableAt.Before(a.EventTime) {
				return fmt.Errorf("activity %s input evidence available before event", a.ID)
			}
		}
		if ids[a.ID] {
			return fmt.Errorf("duplicate activity id %s", a.ID)
		}
		ids[a.ID] = true
		if a.Split != "train" && a.Split != "validation" && a.Split != "final_holdout" {
			return fmt.Errorf("unknown split %q", a.Split)
		}
		sourceKey := a.User + "/" + a.Activity.LabelID
		if root, ok := sourceRoots[sourceKey]; ok && root != a.RootActivityID {
			return fmt.Errorf("source activity %s changes root across split", a.ID)
		}
		key := a.User + "/" + a.RootActivityID
		if split, ok := roots[key]; ok && split != a.Split {
			return fmt.Errorf("activity root %s crosses split", key)
		}
		roots[key] = a.Split
		if _, ok := sourceRoots[sourceKey]; ok {
			return fmt.Errorf("duplicate source activity %s", a.ID)
		}
		sourceRoots[sourceKey] = a.RootActivityID
		if ReplayContentHash(a.Activity) != a.ContentSHA256 {
			return fmt.Errorf("activity %s content hash mismatch", a.ID)
		}
		if timefmt.ShanghaiDay(a.EventTime) != a.Activity.ActivityDate {
			return fmt.Errorf("activity %s event/domain civil date mismatch", a.ID)
		}
		if a.AvailableAt != nil && a.AvailableAt.Before(a.EventTime) {
			return fmt.Errorf("activity %s available before event", a.ID)
		}
		if bounds[a.User] == nil {
			bounds[a.User] = map[string][2]time.Time{}
		}
		b, ok := bounds[a.User][a.Split]
		if !ok {
			b = [2]time.Time{a.EventTime, a.EventTime}
		}
		if a.EventTime.Before(b[0]) {
			b[0] = a.EventTime
		}
		if a.EventTime.After(b[1]) {
			b[1] = a.EventTime
		}
		bounds[a.User][a.Split] = b
	}
	for user, b := range bounds {
		order := []string{"train", "validation", "final_holdout"}
		var previous time.Time
		for _, split := range order {
			if times, ok := b[split]; ok {
				if !previous.IsZero() && !times[0].After(previous) {
					return fmt.Errorf("user %s split chronology overlaps", user)
				}
				previous = times[1]
			}
		}
	}
	ids = map[string]bool{}
	for _, h := range m.Health {
		if h.ID == "" || h.User == "" || h.EventTime.IsZero() || h.Row.Date.IsZero() || ids[h.ID] {
			return fmt.Errorf("health metadata missing or duplicate id")
		}
		ids[h.ID] = true
		if ReplayContentHash(h.Row) != h.ContentSHA256 {
			return fmt.Errorf("health %s content hash mismatch", h.ID)
		}
		if timefmt.ShanghaiDay(h.EventTime) != h.Row.Date {
			return fmt.Errorf("health %s event/domain civil date mismatch", h.ID)
		}
		if h.AvailableAt != nil && h.AvailableAt.Before(h.EventTime) {
			return fmt.Errorf("health %s available before event", h.ID)
		}
	}
	ids = map[string]bool{}
	targetCases := map[string]time.Time{}
	targets := map[string]ReplayActivity{}
	for _, a := range m.Activities {
		key := a.User + "/" + a.RootActivityID
		if prior, ok := targets[key]; ok {
			if prior.Reference != nil && a.Reference != nil && prior.ContentSHA256 != a.ContentSHA256 || !prior.EventTime.Equal(a.EventTime) || ReplayContentHash(prior.Reference) != ReplayContentHash(a.Reference) || prior.Device != a.Device || ReplayContentHash(prior.Scenarios) != ReplayContentHash(a.Scenarios) {
				return fmt.Errorf("conflicting target root audit %s", key)
			}
		} else {
			targets[key] = a
		}
	}
	for _, c := range m.Cases {
		if c.ID == "" || c.User == "" || c.PredictionAsOf.IsZero() || c.PredictionAsOf.After(m.AsOf) || ids[c.ID] {
			return fmt.Errorf("case metadata missing, duplicate or prediction after report as_of")
		}
		ids[c.ID] = true
		if c.TargetRootActivityID != "" {
			key := c.User + "/" + c.TargetRootActivityID
			a, ok := targets[key]
			if !ok || a.Split == "train" || !a.EventTime.After(c.PredictionAsOf) || a.EventTime.After(m.AsOf) {
				return fmt.Errorf("case %s target missing, not heldout or not after cutoff", c.ID)
			}
			modeKey := key + "/" + c.Mode
			if prior, ok := targetCases[modeKey]; ok && !prior.Equal(c.PredictionAsOf) {
				return fmt.Errorf("conflicting prediction cutoffs for target %s", key)
			}
			targetCases[modeKey] = c.PredictionAsOf
		}
		if c.Mode != "strict" && c.Mode != "event_date_retrospective" {
			return fmt.Errorf("unknown replay mode %q", c.Mode)
		}
	}
	return nil
}
