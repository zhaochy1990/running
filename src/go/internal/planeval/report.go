package planeval

import (
	"context"
	"crypto/sha256"
	"fmt"

	"github.com/zhaochy1990/stride/internal/storage"
)

// ResultSummary counts executions, not individual checks. In-flight items are
// explicit so totals remain meaningful when exporting an unfinished task.
type ResultSummary struct {
	Pass    int `json:"pass"`
	Fail    int `json:"fail"`
	Error   int `json:"error"`
	Running int `json:"running"`
}

type ScenarioResultView struct {
	ScenarioView
	Result  string        `json:"result"`
	Summary ResultSummary `json:"summary"`
}

// TaskReportView extends the detail response with immutable, self-contained
// inputs and raw output bytes. No deployment lookup or current catalog reads.
type ReportInputView struct {
	AsOf           string `json:"as_of"`
	RequestJSON    string `json:"request_json"`
	SnapshotJSON   string `json:"snapshot_json"`
	RequestSHA256  string `json:"request_sha256"`
	SnapshotSHA256 string `json:"snapshot_sha256"`
}

type TaskReportView struct {
	TaskDetailView
	Schema           string                     `json:"schema"`
	TaskID           string                     `json:"task_id"`
	ExecutionInputs  map[string]ReportInputView `json:"execution_inputs"`
	ArtifactContents map[string]string          `json:"artifact_contents"`
}

func executionResult(e ExecutionView) string {
	if e.Generate.Status == storage.PlanEvalGenerateFailed {
		return "error"
	}
	if !storage.PlanEvalGenerateTerminal(e.Generate.Status) {
		return "running"
	}
	if e.Artifact != nil && !e.Artifact.SchemaValid {
		return "fail"
	}
	if !storage.PlanEvalEvaluateTerminal(e.Evaluate.Status) {
		return "running"
	}
	if e.Artifact == nil || e.Evaluate.Status != storage.PlanEvalEvaluateDone {
		return "error"
	}
	result := "pass"
	for _, check := range e.Checks {
		if check.Status == storage.PlanEvalCheckError {
			return "error"
		}
		if check.Status == storage.PlanEvalCheckFail {
			result = "fail"
		}
	}
	return result
}

func (s *ResultSummary) add(result string) {
	switch result {
	case "pass":
		s.Pass++
	case "fail":
		s.Fail++
	case "error":
		s.Error++
	default:
		s.Running++
	}
}

func (s ResultSummary) result() string {
	switch {
	case s.Running > 0:
		return "running"
	case s.Error > 0:
		return "error"
	case s.Fail > 0:
		return "fail"
	default:
		return "pass"
	}
}

func (d *TaskDetailView) summarize(scenarios []ScenarioView) {
	byScenario := make(map[string]ResultSummary, len(scenarios))
	d.Progress = TaskProgress{Total: len(d.Executions)}
	for _, e := range d.Executions {
		d.Summary.add(e.Result)
		summary := byScenario[e.ScenarioID]
		summary.add(e.Result)
		byScenario[e.ScenarioID] = summary
		if storage.PlanEvalGenerateTerminal(e.Generate.Status) && storage.PlanEvalEvaluateTerminal(e.Evaluate.Status) {
			d.Progress.Finished++
		}
		if e.Generate.Status == storage.PlanEvalGenerateFailed {
			d.Progress.GenerateFailed++
		}
		ruleFailed := e.Artifact != nil && !e.Artifact.SchemaValid
		for _, check := range e.Checks {
			ruleFailed = ruleFailed || check.Status == storage.PlanEvalCheckFail
		}
		if e.Generate.Status == storage.PlanEvalGenerateDone && ruleFailed {
			d.Progress.RuleFailed++
		}
	}
	d.Result = d.Summary.result()
	d.Scenarios = make([]ScenarioResultView, 0, len(scenarios))
	for _, scene := range scenarios {
		summary := byScenario[scene.ID]
		d.Scenarios = append(d.Scenarios, ScenarioResultView{ScenarioView: scene, Result: summary.result(), Summary: summary})
	}
}

func documentSHA256(document string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(document)))
}

func (s *Service) TaskReport(ctx context.Context, id string) (*TaskReportView, *Error) {
	detail, err := s.TaskDetail(ctx, id)
	if err != nil {
		return nil, err
	}
	report := &TaskReportView{
		TaskDetailView: *detail, Schema: "plan-eval-report/v1", TaskID: detail.ID,
		ExecutionInputs: make(map[string]ReportInputView, len(detail.Executions)), ArtifactContents: make(map[string]string),
	}
	for _, execution := range detail.Executions {
		input, err := s.ExecutionInput(ctx, id, execution.ID)
		if err != nil {
			return nil, err
		}
		report.ExecutionInputs[execution.ID] = ReportInputView{
			AsOf: input.AsOf, RequestJSON: string(input.Request), SnapshotJSON: string(input.Snapshot),
			RequestSHA256: input.RequestSHA256, SnapshotSHA256: input.SnapshotSHA256,
		}
		if execution.Artifact != nil {
			artifact, err := s.Artifact(ctx, execution.Artifact.ID)
			if err != nil {
				return nil, err
			}
			// Keep even invalid JSON as a string, byte-for-byte, for diagnosis.
			report.ArtifactContents[artifact.ID] = artifact.Content
		}
	}
	return report, nil
}
