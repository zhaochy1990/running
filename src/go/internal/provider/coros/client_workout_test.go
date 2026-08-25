// Client-level tests for the workout / training-schedule endpoints: params,
// yfheader auth, one-shot token refresh, and the no-blind-retry policy on
// write endpoints.
package coros

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func credsWithToken(token string) Credentials {
	return Credentials{Email: "a@b.com", PwdHash: "h", AccessToken: token, Region: "global", UserID: "42"}
}

func TestQueryScheduleParams(t *testing.T) {
	var gotStart, gotEnd, gotSupport string
	mux := http.NewServeMux()
	mux.HandleFunc("/training/schedule/query", func(w http.ResponseWriter, r *http.Request) {
		gotStart = r.URL.Query().Get("startDate")
		gotEnd = r.URL.Query().Get("endDate")
		gotSupport = r.URL.Query().Get("supportRestExercise")
		writeEnvelope(w, resultSuccess, `{"data":{"id":"P1","maxIdInPlan":"3","pbVersion":2}}`)
	})
	c := testClient(t, mux, credsWithToken("tok"), func(Credentials) error { return nil })

	if _, err := c.QuerySchedule(context.Background(), "20260501", "20260728"); err != nil {
		t.Fatalf("query schedule: %v", err)
	}
	if gotStart != "20260501" || gotEnd != "20260728" || gotSupport != "1" {
		t.Errorf("params = %q/%q/%q, want 20260501/20260728/1", gotStart, gotEnd, gotSupport)
	}
}

func TestPostJSONSendsYFHeader(t *testing.T) {
	var gotYF, gotAuth string
	var gotBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/training/program/calculate", func(w http.ResponseWriter, r *http.Request) {
		gotYF = r.Header.Get("yfheader")
		gotAuth = r.Header.Get("accesstoken")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		writeEnvelope(w, resultSuccess, `{"data":{"planDuration":3600}}`)
	})
	c := testClient(t, mux, credsWithToken("tok"), func(Credentials) error { return nil })

	prog := map[string]any{"name": "Easy 10K", "sportType": 1}
	if _, err := c.CalculateWorkout(context.Background(), prog, map[string]any{}); err != nil {
		t.Fatalf("calculate: %v", err)
	}
	if gotYF != `{"userId":"42"}` {
		t.Errorf("yfheader = %q, want {\"userId\":\"42\"}", gotYF)
	}
	if gotAuth != "tok" {
		t.Errorf("accesstoken = %q, want tok", gotAuth)
	}
	if gotBody["name"] != "Easy 10K" {
		t.Errorf("body = %v", gotBody)
	}
}

func TestPostJSONRefreshesTokenOnceOnExpiry(t *testing.T) {
	const freshToken = "fresh-token"
	var loginCount int32
	mux := http.NewServeMux()
	mux.HandleFunc("/account/login", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&loginCount, 1)
		writeEnvelope(w, resultSuccess, `{"accessToken":"`+freshToken+`"}`)
	})
	mux.HandleFunc("/training/schedule/update", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("accesstoken") == freshToken {
			writeEnvelope(w, resultSuccess, `{"data":{"programs":[{"idInPlan":9}]}}`)
			return
		}
		writeEnvelope(w, resultTokenExpired, `{}`)
	})
	c := testClient(t, mux, credsWithToken("stale"), func(Credentials) error { return nil })

	data, err := c.UpdateSchedule(context.Background(), []any{}, []any{}, []any{}, 2)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if !strings.Contains(string(data), `"idInPlan":9`) {
		t.Errorf("data = %s", data)
	}
	if n := atomic.LoadInt32(&loginCount); n != 1 {
		t.Errorf("re-login count = %d, want 1", n)
	}
	if tok, _ := c.currentToken(); tok != freshToken {
		t.Errorf("token not refreshed, got %q", tok)
	}
}

func TestPostJSONDoesNotRetryBusinessCode(t *testing.T) {
	// A write endpoint must NOT blind-retry a non-success COROS business code
	// (that could double-apply a workout). The APIError surfaces immediately.
	var calls int32
	mux := http.NewServeMux()
	mux.HandleFunc("/training/schedule/update", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeEnvelope(w, "1031", `{"message":"parameter error"}`)
	})
	c := testClient(t, mux, credsWithToken("tok"), func(Credentials) error { return nil })

	_, err := c.UpdateSchedule(context.Background(), []any{}, []any{}, []any{}, 2)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "1031") {
		t.Errorf("error = %v, want 1031", err)
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Errorf("calls = %d, want 1 (no blind retry on business code)", n)
	}
}

func TestQueryExercisesParams(t *testing.T) {
	var gotSport, gotUser, gotYF string
	mux := http.NewServeMux()
	mux.HandleFunc("/training/exercise/query", func(w http.ResponseWriter, r *http.Request) {
		gotSport = r.URL.Query().Get("sportType")
		gotUser = r.URL.Query().Get("userId")
		gotYF = r.Header.Get("yfheader")
		writeEnvelope(w, resultSuccess, `[{"id":1,"name":"T3001","targetType":3}]`)
	})
	c := testClient(t, mux, credsWithToken("tok"), func(Credentials) error { return nil })

	if _, err := c.QueryExercises(context.Background(), 4); err != nil {
		t.Fatalf("query exercises: %v", err)
	}
	if gotSport != "4" || gotUser != "42" || gotYF != `{"userId":"42"}` {
		t.Errorf("params = %q/%q yf=%q, want 4/42 {\"userId\":\"42\"}", gotSport, gotUser, gotYF)
	}
}

func TestAddExercisePostsBody(t *testing.T) {
	var gotBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/training/exercise/add", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		writeEnvelope(w, resultSuccess, `{"id":"T9999"}`)
	})
	c := testClient(t, mux, credsWithToken("tok"), func(Credentials) error { return nil })

	ex := map[string]any{"name": "Custom Squat", "sportType": 4, "targetValue": 12}
	data, err := c.AddExercise(context.Background(), ex)
	if err != nil {
		t.Fatalf("add exercise: %v", err)
	}
	if gotBody["name"] != "Custom Squat" || gotBody["targetValue"] != float64(12) {
		t.Errorf("body = %v", gotBody)
	}
	var created map[string]any
	if err := json.Unmarshal(data, &created); err != nil || created["id"] != "T9999" {
		t.Errorf("created = %v, %v", created, err)
	}
}

func TestDeleteScheduledWorkoutBody(t *testing.T) {
	// Mirrors Python client.delete_scheduled_workout: a schedule/update call
	// carrying versionObjects with status=3 (delete) for the entity.
	var gotBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/training/schedule/update", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		writeEnvelope(w, resultSuccess, `{"data":{}}`)
	})
	c := testClient(t, mux, credsWithToken("tok"), func(Credentials) error { return nil })

	entity := map[string]any{"idInPlan": "17", "planProgramId": "17", "id": "E1"}
	if _, err := c.DeleteScheduledWorkout(context.Background(), entity, "PLAN_1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	vos := gotBody["versionObjects"].([]any)
	vo := vos[0].(map[string]any)
	if vo["id"] != "17" || vo["planProgramId"] != "17" || vo["labelId"] != "E1" || vo["planId"] != "PLAN_1" || vo["status"] != float64(3) {
		t.Errorf("versionObject = %v", vo)
	}
	if gotBody["pbVersion"] != float64(2) {
		t.Errorf("pbVersion = %v", gotBody["pbVersion"])
	}
}
