package planeval

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"sync"

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

const maxReportBytes int64 = 4 << 30

var errReportTooLarge = errors.New("report exceeds 4 GiB")

type reportWriter struct {
	io.Writer
	remaining int64
}

func (w *reportWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, errReportTooLarge
	}
	n, err := w.Writer.Write(p)
	w.remaining -= int64(n)
	return n, err
}

// TaskReport retains its slot until cleanup after HTTP copying. Read/encoding
// errors occur before headers; temporary files contain private original bytes.
func (s *Service) TaskReport(ctx context.Context, id string) (*os.File, func(), *Error) {
	select {
	case s.reportSlot <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, s.internal(ctx.Err())
	}
	release := sync.OnceFunc(func() { <-s.reportSlot })
	keepSlot := false
	defer func() {
		if !keepSlot {
			release()
		}
	}()
	task, readErr := s.store.GetPlanEvalTask(ctx, id)
	if readErr != nil {
		return nil, nil, s.mapStorageError(readErr)
	}
	// Settlement commits the terminal task and all results atomically; afterwards
	// neither worker leases nor cleanup can change these frozen records.
	if task.Status != storage.PlanEvalTaskDone {
		return nil, nil, &Error{Status: 409, Code: "task_not_final", Detail: "任务尚未终结，请等待全部执行项完成后导出。", Extra: map[string]any{"task_id": task.ID, "status": task.Status}}
	}
	detail, err := s.taskDetail(ctx, task.ID, false)
	if err != nil {
		return nil, nil, err
	}
	file, e := os.CreateTemp("", "plan-eval-report-*.json")
	if e != nil {
		return nil, nil, s.internal(e)
	}
	// Unlink while open: even a process crash cannot leave private report files.
	if e = os.Remove(file.Name()); e != nil {
		file.Close()
		return nil, nil, s.internal(e)
	}
	cleanup := sync.OnceFunc(func() { file.Close(); release() })
	if e = writeTaskReport(ctx, &reportWriter{Writer: file, remaining: maxReportBytes}, detail, s.store.PlanEvalExecutionInput, s.store.GetPlanEvalArtifact); e == nil {
		_, e = file.Seek(0, io.SeekStart)
	}
	if e != nil {
		cleanup()
		if errors.Is(e, errReportTooLarge) {
			return nil, nil, fail(413, "report_too_large", "报告超过 4 GiB，请拆分任务后重试。")
		}
		return nil, nil, s.internal(e)
	}
	keepSlot = true
	return file, cleanup, nil
}

func writeTaskReport(ctx context.Context, w io.Writer, detail *TaskDetailView,
	readInput func(context.Context, string) (*storage.PlanEvalExecution, error),
	readArtifact func(context.Context, string) (*storage.PlanEvalArtifact, error),
) error {
	write := func(raw []byte) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		_, err := w.Write(raw)
		return err
	}
	value := func(v any) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		return write(raw)
	}
	header, err := json.Marshal(struct {
		TaskDetailView
		Schema string `json:"schema"`
		TaskID string `json:"task_id"`
	}{*detail, "plan-eval-report/v1", detail.ID})
	if err != nil {
		return err
	}
	if err = write(header[:len(header)-1]); err != nil {
		return err
	}
	if err = write([]byte(`,"execution_inputs":{`)); err != nil {
		return err
	}
	// Match encoding/json's map-key order regardless of database row order.
	executions := append([]ExecutionView(nil), detail.Executions...)
	sort.Slice(executions, func(i, j int) bool { return executions[i].ID < executions[j].ID })
	for i, execution := range executions {
		if err = ctx.Err(); err != nil {
			return err
		}
		input, err := readInput(ctx, execution.ID)
		if err != nil {
			return err
		}
		if input.TaskID != detail.ID || input.ID != execution.ID {
			return storage.ErrPlanEvalNotFound
		}
		if i > 0 {
			if err = write([]byte(",")); err != nil {
				return err
			}
		}
		if err = value(execution.ID); err != nil {
			return err
		}
		if err = write([]byte(":")); err != nil {
			return err
		}
		if err = value(ReportInputView{
			AsOf: input.AsOf, RequestJSON: input.RequestJSON, SnapshotJSON: input.SnapshotJSON,
			RequestSHA256: documentSHA256(input.RequestJSON), SnapshotSHA256: documentSHA256(input.SnapshotJSON),
		}); err != nil {
			return err
		}
	}
	if err = write([]byte(`},"artifact_contents":{`)); err != nil {
		return err
	}
	artifactIDs := []string{}
	for _, execution := range executions {
		if execution.Artifact != nil {
			artifactIDs = append(artifactIDs, execution.Artifact.ID)
		}
	}
	sort.Strings(artifactIDs)
	for i, id := range artifactIDs {
		if err = ctx.Err(); err != nil {
			return err
		}
		artifact, err := readArtifact(ctx, id)
		if err != nil {
			return err
		}
		if artifact.TaskID != detail.ID || artifact.ID != id {
			return storage.ErrPlanEvalNotFound
		}
		if i > 0 {
			if err = write([]byte(",")); err != nil {
				return err
			}
		}
		if err = value(id); err != nil {
			return err
		}
		if err = write([]byte(":")); err != nil {
			return err
		}
		// Even invalid JSON is a string, preserving its original bytes and digest.
		if err = value(artifact.Content); err != nil {
			return err
		}
	}
	return write([]byte("}}"))
}
