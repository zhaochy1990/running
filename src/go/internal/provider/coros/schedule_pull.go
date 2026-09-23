// schedule_pull.go decodes the step-level COROS schedule/query payload into the
// canonical watch-schedule/v1 envelope (ADR 0036 / 0038). It is the read-side
// companion to workout.go's push builder: the push half maps run-workout/v1 →
// COROS exercises, this half maps COROS exercises → run-workout/v1.
package coros

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// PullWatchSchedule fetches the step-level schedule for [start, end] (ISO
// YYYY-MM-DD) and normalizes it into the canonical envelope. Strength sessions
// are skipped and counted; [STRIDE]-authored entries are excluded to avoid the
// self-loop (ADR 0036).
func (p *Provider) PullWatchSchedule(ctx context.Context, user, start, end string) (provider.WatchSchedulePull, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return provider.WatchSchedulePull{}, err
	}
	return p.pullWatchSchedule(ctx, client, user, start, end)
}

// pullWatchSchedule is the client-bound core shared by PullWatchSchedule and the
// schedule phase of SyncUser (so the sync path reuses the already rate-limited
// client rather than re-loading credentials).
func (p *Provider) pullWatchSchedule(ctx context.Context, client *Client, _, start, end string) (provider.WatchSchedulePull, error) {
	data, err := client.QuerySchedule(ctx, strings.ReplaceAll(start, "-", ""), strings.ReplaceAll(end, "-", ""))
	if err != nil {
		return provider.WatchSchedulePull{}, err
	}
	return decodeWatchSchedule(data, start, end, time.Now().UTC().Format(time.RFC3339))
}

// syncSchedule runs the watch-schedule phase of a sync: pull → persist → update
// the sync result metadata (ADR 0038 decision 4).
func (p *Provider) syncSchedule(ctx context.Context, client *Client, user string, res *provider.SyncResult) error {
	from, to := provider.SchedulePullWindow()
	pull, err := p.pullWatchSchedule(ctx, client, user, from, to)
	if err != nil {
		return err
	}

	rows := make([]storage.WatchSchedule, 0, len(pull.Schedule.Sessions))
	for _, sess := range pull.Schedule.Sessions {
		specJSON, err := json.Marshal(sess.Spec)
		if err != nil {
			return fmt.Errorf("coros: marshal watch session spec: %w", err)
		}
		fetchedAt, err := time.Parse(time.RFC3339, pull.Schedule.Fetch.FetchedAt)
		if err != nil {
			fetchedAt = time.Now().UTC()
		}
		rows = append(rows, storage.WatchSchedule{
			Provider:   pull.Schedule.Provider,
			EntityID:   sess.SourceIDs.EntityID,
			Date:       sess.Date,
			Kind:       sess.Kind,
			Name:       sess.Spec.Name,
			SpecJSON:   string(specJSON),
			FetchedAt:  fetchedAt,
			WindowFrom: pull.Schedule.Fetch.WindowFrom,
			WindowTo:   pull.Schedule.Fetch.WindowTo,
		})
	}
	if err := p.store.UpsertWatchSchedules(ctx, user, rows); err != nil {
		return err
	}

	res.ScheduleSessions = len(rows)
	res.ScheduleSkippedStrength = pull.SkippedStrength
	res.ScheduleSkippedStride = pull.SkippedStride
	res.ScheduleSkippedInvalid = pull.SkippedInvalid
	return nil
}

// rawScheduleProgram is the program half of a schedule/query response. The
// step-level content lives in Exercises (the same shape workout.go pushes).
type rawScheduleProgram struct {
	IDInPlan  any              `json:"idInPlan"`
	Name      string           `json:"name"`
	SportType int              `json:"sportType"`
	Exercises []map[string]any `json:"exercises"`
}

// decodeWatchSchedule normalizes a raw schedule/query payload into the canonical
// envelope plus the skip counts. `from`/`to`/`fetchedAt` are recorded verbatim
// in the fetch metadata; they are the caller's pull-window declaration.
func decodeWatchSchedule(raw json.RawMessage, from, to, fetchedAt string) (provider.WatchSchedulePull, error) {
	var sched struct {
		Entities []struct {
			HappenDay any `json:"happenDay"`
			IDInPlan  any `json:"idInPlan"`
		} `json:"entities"`
		Programs []rawScheduleProgram `json:"programs"`
	}
	if err := json.Unmarshal(raw, &sched); err != nil {
		return provider.WatchSchedulePull{}, fmt.Errorf("coros: decode schedule: %w", err)
	}

	programs := make(map[string]rawScheduleProgram, len(sched.Programs))
	for _, prog := range sched.Programs {
		if id := strAny(prog.IDInPlan); id != "" {
			programs[id] = prog
		}
	}

	pull := provider.WatchSchedulePull{
		Schedule: provider.WatchSchedule{
			Schema:   provider.WatchScheduleSchema,
			Provider: providerName,
			Fetch:    provider.WatchFetchMeta{FetchedAt: fetchedAt, WindowFrom: from, WindowTo: to},
		},
	}
	for _, e := range sched.Entities {
		id := strAny(e.IDInPlan)
		prog, ok := programs[id]
		if !ok {
			pull.SkippedInvalid++
			continue
		}
		date := corosDateToISO(strAny(e.HappenDay))
		if prog.SportType == 4 { // strength: not modelled in v1 (ADR 0036)
			pull.SkippedStrength++
			continue
		}
		if strings.HasPrefix(prog.Name, "[STRIDE]") { // self-loop exclusion
			pull.SkippedStride++
			continue
		}
		spec, err := corosProgramToRunWorkout(prog, date)
		if err != nil {
			pull.SkippedInvalid++
			continue
		}
		pull.Schedule.Sessions = append(pull.Schedule.Sessions, provider.WatchSession{
			Date:      date,
			Kind:      provider.WatchSessionKindRun,
			SourceIDs: provider.WatchSourceIDs{Provider: providerName, EntityID: id},
			Spec:      *spec,
		})
	}
	return pull, nil
}

// corosProgramToRunWorkout maps one running COROS program into a run-workout/v1
// document. A program with no decodable steps is an error (it would otherwise
// silently drop content).
func corosProgramToRunWorkout(prog rawScheduleProgram, date string) (*provider.RunWorkout, error) {
	blocks, err := corosExercisesToBlocks(prog.Exercises)
	if err != nil {
		return nil, err
	}
	if len(blocks) == 0 {
		return nil, fmt.Errorf("coros: program %q has no runnable steps", prog.Name)
	}
	return &provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   prog.Name,
		Date:   date,
		Blocks: blocks,
	}, nil
}

// corosExercisesToBlocks rebuilds the flat COROS exercise list into
// run-workout/v1 blocks. A group container (isGroup=true, exerciseType=0)
// becomes one multi-repeat block whose children are the following exercises
// carrying its groupId; every other exercise is a single-repeat block.
func corosExercisesToBlocks(exercises []map[string]any) ([]provider.WorkoutBlock, error) {
	var blocks []provider.WorkoutBlock
	for i := 0; i < len(exercises); i++ {
		ex := exercises[i]
		if boolAny(ex["isGroup"]) {
			groupID := strAny(ex["id"])
			sets := max(intAny(ex["sets"]), 1)
			var steps []provider.WorkoutStep
			j := i + 1
			for j < len(exercises) && strAny(exercises[j]["groupId"]) == groupID {
				step, err := corosExerciseToStep(exercises[j])
				if err != nil {
					return nil, err
				}
				steps = append(steps, step)
				j++
			}
			if len(steps) == 0 {
				return nil, fmt.Errorf("coros: interval group %s has no steps", groupID)
			}
			blocks = append(blocks, provider.WorkoutBlock{Steps: steps, Repeat: sets})
			i = j - 1
			continue
		}
		step, err := corosExerciseToStep(ex)
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, provider.WorkoutBlock{Steps: []provider.WorkoutStep{step}, Repeat: 1})
	}
	return blocks, nil
}

// corosExerciseToStep maps one non-group COROS exercise to a run-workout/v1
// step. Group containers never reach here (corosExercisesToBlocks consumes them).
func corosExerciseToStep(ex map[string]any) (provider.WorkoutStep, error) {
	kind, ok := corosStepKind(intAny(ex["exerciseType"]))
	if !ok {
		return provider.WorkoutStep{}, fmt.Errorf("coros: unsupported exerciseType %v", ex["exerciseType"])
	}
	return provider.WorkoutStep{
		StepKind: kind,
		Duration: corosDuration(intAny(ex["targetType"]), intAny(ex["targetValue"])),
		Target:   corosTarget(ex),
	}, nil
}

// corosStepKind maps the COROS exerciseType role onto the canonical step kind.
func corosStepKind(t int) (provider.StepKind, bool) {
	switch t {
	case 1:
		return provider.StepWarmup, true
	case 2:
		return provider.StepWork, true
	case 3:
		return provider.StepCooldown, true
	case 4:
		return provider.StepRecovery, true
	default:
		return "", false
	}
}

// corosDuration maps the COROS targetType/targetValue pair onto a step duration.
// targetType 5 is distance in millimetres, 2 is time in seconds; anything else
// (including "open") degrades to an open duration.
func corosDuration(targetType, targetValue int) provider.Duration {
	switch targetType {
	case 5:
		return provider.DurationOfDistanceM(float64(targetValue) / 1000)
	case 2:
		return provider.DurationOfTimeS(float64(targetValue))
	default:
		return provider.OpenDuration()
	}
}

// corosTarget maps COROS intensity onto a canonical target. intensityType 3 is
// an absolute pace target whose intensityValue/intensityValueExtend are ms/km
// (faster bound first); intensityType 2 is an absolute HR target whose
// intensityValue/intensityValueExtend are bare bpm (intensityMultiplier is 0 —
// verified against real-account samples on 2026-09-23: 134–150 bpm at
// intensityPercent 80000 and 170–176 bpm at 103000 for an athlete with LT HR
// ≈166). When an absolute value is present it wins over intensityPercent;
// percent-only steps (zero absolute value) keep degrading to open — relative
// targets are not modelled on the pull side in v1 (ADR 0038).
func corosTarget(ex map[string]any) provider.Target {
	switch intAny(ex["intensityType"]) {
	case 2:
		lowBPM := floatAny(ex["intensityValue"])
		highBPM := floatAny(ex["intensityValueExtend"])
		if lowBPM <= 0 {
			return provider.OpenTarget()
		}
		if highBPM <= 0 {
			highBPM = lowBPM
		}
		// HRRangeBPM orders Low = lower bpm (easier), High = higher (harder).
		return provider.HRRangeBPM(int(lowBPM), int(highBPM))
	case 3:
		fastMS := floatAny(ex["intensityValue"])
		slowMS := floatAny(ex["intensityValueExtend"])
		if fastMS <= 0 {
			return provider.OpenTarget()
		}
		if slowMS <= 0 {
			slowMS = fastMS
		}
		// PaceRangeSKM orders Low = slower (larger s/km), High = faster (smaller s/km).
		return provider.PaceRangeSKM(slowMS/1000, fastMS/1000)
	default:
		return provider.OpenTarget()
	}
}

// boolAny coerces a JSON value (bool, number, or "true"/"1") to bool.
func boolAny(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case float64:
		return t != 0
	case float32:
		return t != 0
	case int:
		return t != 0
	case int64:
		return t != 0
	case string:
		return t == "true" || t == "1"
	case json.Number:
		f, _ := t.Float64()
		return f != 0
	default:
		return false
	}
}
