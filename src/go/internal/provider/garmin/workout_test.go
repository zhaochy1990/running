// Client + provider-level tests for Garmin workout push: upload → schedule
// flow, POST plumbing, and the not-logged-in path.
package garmin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/provider"
)

// workoutMux wraps garminMux (auth/profile/exchange fixtures) with the
// workout-service endpoints for a push run.
func workoutMux(t *testing.T) *http.ServeMux {
	mux := garminMux()
	mux.HandleFunc("/workout-service/workout", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Errorf("content-type = %q, want application/json", ct)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["workoutName"] == "" {
			t.Errorf("workoutName missing")
		}
		w.Write([]byte(`{"workoutId":12345,"ownerId":1}`))
	})
	mux.HandleFunc("/workout-service/schedule/12345", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["date"] != "2026-05-01" {
			t.Errorf("schedule date = %v, want 2026-05-01", body["date"])
		}
		w.Write([]byte(`{"scheduledWorkoutId":99}`))
	})
	return mux
}

func TestUploadWorkoutPostsBody(t *testing.T) {
	var gotBody map[string]any
	mux := garminMux()
	mux.HandleFunc("/workout-service/workout", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Write([]byte(`{"workoutId":7}`))
	})
	c := newTestClient(t, mux)

	data, err := c.UploadWorkout(context.Background(), map[string]any{"workoutName": "Easy 10K", "sportType": map[string]any{"sportTypeKey": "running"}})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	var up struct {
		WorkoutID float64 `json:"workoutId"`
	}
	if err := json.Unmarshal(data, &up); err != nil || up.WorkoutID != 7 {
		t.Errorf("upload response = %s, %v", data, err)
	}
	if gotBody["workoutName"] != "Easy 10K" {
		t.Errorf("body = %v", gotBody)
	}
}

func TestScheduleWorkoutPostsDate(t *testing.T) {
	var gotPath, gotDate string
	mux := garminMux()
	mux.HandleFunc("/workout-service/schedule/", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotDate, _ = body["date"].(string)
		w.Write([]byte(`{}`))
	})
	c := newTestClient(t, mux)

	if _, err := c.ScheduleWorkout(context.Background(), 12345, "2026-05-01"); err != nil {
		t.Fatalf("schedule: %v", err)
	}
	if gotPath != "/workout-service/schedule/12345" {
		t.Errorf("path = %q", gotPath)
	}
	if gotDate != "2026-05-01" {
		t.Errorf("date = %q", gotDate)
	}
}

func TestPushRunWorkoutFullFlow(t *testing.T) {
	p, _ := newTestProvider(t, workoutMux(t), loggedInCreds())

	id, err := p.PushRunWorkout(context.Background(), testUID, garminEasyRun10km())
	if err != nil {
		t.Fatalf("push run workout: %v", err)
	}
	if id != "12345" {
		t.Errorf("workoutId = %q, want 12345", id)
	}
}

func TestPushRunWorkoutNotLoggedIn(t *testing.T) {
	p, _ := newTestProvider(t, workoutMux(t), &captureCreds{}) // no seed → empty bundle

	_, err := p.PushRunWorkout(context.Background(), testUID, garminEasyRun10km())
	if !errors.Is(err, provider.ErrAuthRequired) {
		t.Fatalf("err = %v, want provider.ErrAuthRequired", err)
	}
}

func TestPushRunWorkoutNoWorkoutID(t *testing.T) {
	mux := garminMux()
	mux.HandleFunc("/workout-service/workout", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{}`))
	})
	p, _ := newTestProvider(t, mux, loggedInCreds())

	_, err := p.PushRunWorkout(context.Background(), testUID, garminEasyRun10km())
	if err == nil || !strings.Contains(err.Error(), "no workoutId") {
		t.Fatalf("err = %v, want no workoutId", err)
	}
}

// newTestClient builds a Garmin Client whose domain points at the httptest
// server (through the rewrite transport) with a valid OAuth2 bearer so no
// exchange is triggered.
func newTestClient(t *testing.T, mux http.Handler) *Client {
	t.Helper()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return NewClient(Credentials{
		Email:  "a@b.com",
		Region: "global",
		OAuth2: OAuth2Token{AccessToken: "AT", ExpiresAt: time.Now().Add(time.Hour).Unix()},
	}, WithHTTPClient(mockHTTPClient(srv)), WithDomain("garmin.com"), WithRequestDelay(0))
}
