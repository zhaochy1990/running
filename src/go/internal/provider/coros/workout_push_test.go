// Provider-level tests for the workout-push adapter methods: the
// query-schedule → calculate → update flow, strength custom-exercise
// fallback, the [STRIDE]-guarded delete sweep, and schedule listing.
package coros

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
)

// workoutMux serves the schedule/query → program/calculate → schedule/update
// flow for a single push. maxIdInPlan is the schedule state the query returns.
func workoutMux(maxIDInPlan int) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/training/schedule/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess,
			`{"id":"PLAN_P","maxIdInPlan":`+itoa(maxIDInPlan)+`,"pbVersion":2}`)
	})
	mux.HandleFunc("/training/program/calculate", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess,
			`{"planDistance":10000000,"planDuration":3600,"planTrainingLoad":45,"planSets":2,"planPitch":190}`)
	})
	mux.HandleFunc("/training/schedule/update", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		programs := body["programs"].([]any)
		program := programs[0].(map[string]any)
		idInPlan := strAny(program["idInPlan"])
		writeEnvelope(w, resultSuccess,
			`{"programs":[{"idInPlan":`+idInPlan+`}]}`)
	})
	return mux
}

func TestPushRunWorkoutFullFlow(t *testing.T) {
	// maxIdInPlan=7 → our workout takes idInPlan=8.
	mux := workoutMux(7)
	p := newTestProvider(t, mux, newFakeWriter())

	id, err := p.PushRunWorkout(context.Background(), testUID, easyRun10km())
	if err != nil {
		t.Fatalf("push run workout: %v", err)
	}
	if id != "8" {
		t.Errorf("idInPlan = %q, want 8 (maxIdInPlan+1)", id)
	}
}

func TestPushRunWorkoutAppliesCalculatedMetrics(t *testing.T) {
	var updateBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/training/schedule/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{"id":"P","maxIdInPlan":"0","pbVersion":2}`)
	})
	mux.HandleFunc("/training/program/calculate", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess,
			`{"planDistance":10000000,"planDuration":3600,"planTrainingLoad":45,"planSets":2,"planPitch":190,"distanceDisplayUnit":1,"exerciseBarChart":[{"width":100}]}`)
	})
	mux.HandleFunc("/training/schedule/update", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&updateBody)
		writeEnvelope(w, resultSuccess, `{}`)
	})
	p := newTestProvider(t, mux, newFakeWriter())

	if _, err := p.PushRunWorkout(context.Background(), testUID, easyRun10km()); err != nil {
		t.Fatalf("push: %v", err)
	}
	program := updateBody["programs"].([]any)[0].(map[string]any)
	// Calculated values must be stamped back onto the program before update.
	if program["distance"] != float64(10000000) {
		t.Errorf("distance = %v, want 10000000 (from calculate)", program["distance"])
	}
	if program["duration"] != float64(3600) {
		t.Errorf("duration = %v, want 3600", program["duration"])
	}
	if program["trainingLoad"] != float64(45) {
		t.Errorf("trainingLoad = %v, want 45", program["trainingLoad"])
	}
	if program["totalSets"] != float64(2) || program["sets"] != float64(2) {
		t.Errorf("sets = %v/%v, want 2/2", program["totalSets"], program["sets"])
	}
	if program["distanceDisplayUnit"] != float64(1) {
		t.Errorf("distanceDisplayUnit = %v, want 1", program["distanceDisplayUnit"])
	}
	entity := updateBody["entities"].([]any)[0].(map[string]any)
	if _, ok := entity["exerciseBarChart"]; !ok {
		t.Errorf("entity bar chart not replaced from calculate response")
	}
}

// emptyCreds is a credential store that reports no stored credentials.
type emptyCreds struct{}

func (emptyCreds) Load(context.Context, string) (Credentials, error) { return Credentials{}, nil }
func (emptyCreds) Save(context.Context, string, Credentials) error   { return nil }

func TestPushRunWorkoutNotLoggedIn(t *testing.T) {
	// Credential store returns empty creds → provider.ErrAuthRequired.
	fw := newFakeWriter()
	p := New(fw, emptyCreds{}, WithClientFactory(func(c Credentials, save CredentialSaver) *Client {
		return NewClient(c, WithRequestDelay(0))
	}))
	_, err := p.PushRunWorkout(context.Background(), testUID, easyRun10km())
	if !errors.Is(err, provider.ErrAuthRequired) {
		t.Fatalf("err = %v, want provider.ErrAuthRequired", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Strength push
// ─────────────────────────────────────────────────────────────────────────────

func strengthWorkout() provider.StrengthWorkout {
	tcode := "T1262"
	return provider.StrengthWorkout{
		Schema: provider.StrengthWorkoutSchema,
		Name:   "力量训练",
		Date:   "2026-05-04",
		Exercises: []provider.StrengthExerciseSpec{{
			CanonicalID: "squat", DisplayName: "深蹲", Sets: 3,
			TargetKind: provider.StrengthTargetReps, TargetValue: 12, RestSeconds: 90,
			ProviderID: &tcode,
		}},
	}
}

func TestPushStrengthWorkoutFullFlow(t *testing.T) {
	var exerciseQueryCount int
	mux := http.NewServeMux()
	mux.HandleFunc("/training/exercise/query", func(w http.ResponseWriter, r *http.Request) {
		exerciseQueryCount++
		writeEnvelope(w, resultSuccess,
			`[{"id":5001,"name":"T1262","sportType":4,"targetType":3,"targetValue":12,"userId":0}]`)
	})
	mux.HandleFunc("/training/schedule/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{"id":"P","maxIdInPlan":3,"pbVersion":2}`)
	})
	mux.HandleFunc("/training/program/calculate", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{"planDuration":2400,"planSets":3}`)
	})
	var updateBody map[string]any
	mux.HandleFunc("/training/schedule/update", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&updateBody)
		writeEnvelope(w, resultSuccess, `{"programs":[{"idInPlan":4}]}`)
	})
	p := newTestProvider(t, mux, newFakeWriter())

	id, err := p.PushStrengthWorkout(context.Background(), testUID, strengthWorkout())
	if err != nil {
		t.Fatalf("push strength: %v", err)
	}
	if id != "4" {
		t.Errorf("idInPlan = %q, want 4", id)
	}
	if exerciseQueryCount != 1 {
		t.Errorf("exercise queries = %d, want 1 (no custom fallback needed)", exerciseQueryCount)
	}
	program := updateBody["programs"].([]any)[0].(map[string]any)
	if program["sportType"] != float64(4) {
		t.Errorf("sportType = %v, want 4 (strength)", program["sportType"])
	}
	exercises := program["exercises"].([]any)
	ex := exercises[0].(map[string]any)
	if ex["originId"] != "5001" || ex["id"] != float64(1) {
		t.Errorf("exercise originId/id = %v/%v, want 5001/1", ex["originId"], ex["id"])
	}
	if ex["targetValue"] != float64(12) || ex["restValue"] != float64(90) {
		t.Errorf("exercise target/rest = %v/%v, want 12/90", ex["targetValue"], ex["restValue"])
	}
}

func TestPushStrengthWorkoutCreatesMissingCustomExercise(t *testing.T) {
	var addCalls, queryCalls int
	var added map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/training/exercise/query", func(w http.ResponseWriter, r *http.Request) {
		queryCalls++
		if queryCalls == 1 {
			// First query: T-code NOT in the library → custom exercise path.
			writeEnvelope(w, resultSuccess, `[]`)
			return
		}
		// Refreshed library carries the newly created exercise.
		writeEnvelope(w, resultSuccess,
			`[{"id":9001,"name":"T1262","sportType":4,"targetType":3,"targetValue":12,"userId":123}]`)
	})
	mux.HandleFunc("/training/exercise/add", func(w http.ResponseWriter, r *http.Request) {
		addCalls++
		_ = json.NewDecoder(r.Body).Decode(&added)
		writeEnvelope(w, resultSuccess, `{"id":9001}`)
	})
	mux.HandleFunc("/training/schedule/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{"id":"P","maxIdInPlan":0,"pbVersion":2}`)
	})
	mux.HandleFunc("/training/program/calculate", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{}`)
	})
	mux.HandleFunc("/training/schedule/update", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{}`)
	})
	p := newTestProvider(t, mux, newFakeWriter())

	if _, err := p.PushStrengthWorkout(context.Background(), testUID, strengthWorkout()); err != nil {
		t.Fatalf("push strength: %v", err)
	}
	if addCalls != 1 {
		t.Errorf("add exercise calls = %d, want 1", addCalls)
	}
	if queryCalls != 2 {
		t.Errorf("exercise queries = %d, want 2 (initial + refreshed)", queryCalls)
	}
	if added["name"] != "深蹲" || added["sportType"] != float64(4) {
		t.Errorf("custom exercise payload = %v", added)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete sweep + schedule listing
// ─────────────────────────────────────────────────────────────────────────────

func deleteScheduleMux(entities, programs string) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/training/schedule/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{"id":"PLAN_1","entities":`+entities+`,"programs":`+programs+`}`)
	})
	return mux
}

func TestDeleteScheduledWorkoutSweepsOnlyStride(t *testing.T) {
	// One [STRIDE] entity + one user-authored entity on the same date.
	entities := `[
		{"happenDay":"20260504","idInPlan":17,"planProgramId":17,"id":"E1"},
		{"happenDay":"20260504","idInPlan":99,"planProgramId":99,"id":"E2"}
	]`
	programs := `[
		{"idInPlan":17,"name":"[STRIDE] Easy 10K","sportType":1},
		{"idInPlan":99,"name":"user-own-workout","sportType":1}
	]`
	mux := deleteScheduleMux(entities, programs)
	mux.HandleFunc("/training/schedule/update", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{}`)
	})
	p := newTestProvider(t, mux, newFakeWriter())

	deleted, err := p.DeleteScheduledWorkout(context.Background(), testUID, "2026-05-04", "")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if !deleted {
		t.Fatal("want deleted=true (one STRIDE entity)")
	}
}

func TestDeleteScheduledWorkoutNoStrideReturnsFalse(t *testing.T) {
	entities := `[{"happenDay":"20260504","idInPlan":99,"planProgramId":99}]`
	programs := `[{"idInPlan":99,"name":"user-own-workout","sportType":1}]`
	mux := deleteScheduleMux(entities, programs)
	p := newTestProvider(t, mux, newFakeWriter())

	deleted, err := p.DeleteScheduledWorkout(context.Background(), testUID, "2026-05-04", "")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if deleted {
		t.Fatal("want deleted=false (no STRIDE entries)")
	}
}

func TestDeleteScheduledWorkoutNameFilter(t *testing.T) {
	// Two STRIDE entries on the same date; --name must touch only the match
	// (regression guard for wiping a second same-day session).
	var deletes int
	entities := `[
		{"happenDay":"20260504","idInPlan":17,"planProgramId":17,"id":"E1"},
		{"happenDay":"20260504","idInPlan":18,"planProgramId":18,"id":"E2"}
	]`
	programs := `[
		{"idInPlan":17,"name":"[STRIDE] Easy 10K","sportType":1},
		{"idInPlan":18,"name":"[STRIDE] 力量 A 下肢","sportType":4}
	]`
	mux := deleteScheduleMux(entities, programs)
	mux.HandleFunc("/training/schedule/update", func(w http.ResponseWriter, r *http.Request) {
		deletes++
		writeEnvelope(w, resultSuccess, `{}`)
	})
	p := newTestProvider(t, mux, newFakeWriter())

	deleted, err := p.DeleteScheduledWorkout(context.Background(), testUID, "2026-05-04", "[STRIDE] 力量 A 下肢")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if !deleted || deletes != 1 {
		t.Fatalf("deleted=%v deletes=%d, want true/1", deleted, deletes)
	}
}

func TestQueryScheduleSummaries(t *testing.T) {
	entities := `[
		{"happenDay":"20260504","idInPlan":17,"planProgramId":17},
		{"happenDay":"20260505","idInPlan":18,"planProgramId":18}
	]`
	programs := `[
		{"idInPlan":17,"name":"[STRIDE] Easy 10K","sportType":1},
		{"idInPlan":18,"name":"user race","sportType":4}
	]`
	mux := deleteScheduleMux(entities, programs)
	p := newTestProvider(t, mux, newFakeWriter())

	summaries, err := p.QuerySchedule(context.Background(), testUID, "2026-05-04", "2026-05-10")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(summaries) != 2 {
		t.Fatalf("summaries = %d, want 2", len(summaries))
	}
	s0 := summaries[0]
	if s0.Date != "2026-05-04" || s0.ProviderWorkoutID != "17" || s0.Name != "[STRIDE] Easy 10K" ||
		s0.Sport != "running" || !s0.IsStrideManaged {
		t.Errorf("summary0 = %+v", s0)
	}
	s1 := summaries[1]
	if s1.Date != "2026-05-05" || s1.Sport != "strength" || s1.IsStrideManaged {
		t.Errorf("summary1 = %+v", s1)
	}
}

func TestQueryExercisesProvider(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/training/exercise/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess,
			`[{"id":1,"name":"T3001"},{"id":2,"name":"T1262"}]`)
	})
	p := newTestProvider(t, mux, newFakeWriter())

	list, err := p.QueryExercises(context.Background(), testUID, "strength")
	if err != nil {
		t.Fatalf("query exercises: %v", err)
	}
	if len(list) != 2 || list[0]["name"] != "T3001" {
		t.Errorf("list = %v", list)
	}
}

// itoa is a tiny int→string helper for building fixture JSON.
func itoa(n int) string {
	return strconv.Itoa(n)
}
