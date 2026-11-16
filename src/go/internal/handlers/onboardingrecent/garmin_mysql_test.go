// garmin_mysql_test.go is the Garmin end-to-end seam test of the onboarding
// recent-stage executor (devops#1007): the real session tables on real MySQL
// (T02's claim/dispatch/sweep), the real executor handler (devops#1008's
// provider-agnostic one) over the real Garmin adapter on an httptest provider
// API, with real watch-domain persistence (activities through the blob-backed
// fenced publish path, daily health, dashboard). Named TestOnboardingRecent*
// so the CI step that runs this package against MySQL picks it up.
package onboardingrecent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/onboardingsync"
	"github.com/zhaochy1990/stride/internal/provider/garmin"
	"github.com/zhaochy1990/stride/internal/storage"
)

// garminAPI is a compact Garmin Connect stand-in: a logged-in OAuth bundle,
// an activity list with in-window and older pages, detail/splits/weather, and
// per-day health + dashboard endpoints with signal for every date.
type garminAPI struct {
	srv       *httptest.Server
	listCalls int
	mu        sync.Mutex
}

func newGarminAPI(t *testing.T) *garminAPI {
	t.Helper()
	api := &garminAPI{}
	mux := http.NewServeMux()
	mux.HandleFunc("/activitylist-service/activities/search/activities", func(w http.ResponseWriter, r *http.Request) {
		api.mu.Lock()
		api.listCalls++
		api.mu.Unlock()
		switch r.URL.Query().Get("start") {
		case "0":
			fmt.Fprint(w, `[
				{"activityId":1001,"activityType":{"typeKey":"running"},"startTimeGMT":"2026-11-06 23:30:00","distance":10000.0,"duration":3000.0,"averageSpeed":3.33,"averageHR":150},
				{"activityId":1002,"activityType":{"typeKey":"running"},"startTimeGMT":"2026-10-20 02:00:00","distance":8000.0,"duration":2400.0,"averageSpeed":3.33,"averageHR":148}
			]`)
		default:
			// An older page: the walk stops here.
			fmt.Fprint(w, `[
				{"activityId":1000,"activityType":{"typeKey":"running"},"startTimeGMT":"2026-05-01 08:00:00","distance":5000.0,"duration":1500.0,"averageSpeed":3.33,"averageHR":140}
			]`)
		}
	})
	mux.HandleFunc("/activity-service/activity/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/details"):
			fmt.Fprint(w, `{"startTimeGMT":"2026-11-06 23:30:00","metricDescriptors":[{"key":"directHeartRate","metricsIndex":0}],"activityDetailMetrics":[{"metrics":[150.0]}]}`)
		case strings.HasSuffix(r.URL.Path, "/splits"):
			fmt.Fprint(w, `{"lapDTOs":[{"lapIndex":1,"distance":1000.0,"duration":300.0}]}`)
		case strings.HasSuffix(r.URL.Path, "/weather"):
			fmt.Fprint(w, `{"temp":18.0,"relativeHumidity":55}`)
		default:
			fmt.Fprint(w, `{}`)
		}
	})
	mux.HandleFunc("/metrics-service/metrics/trainingstatus/aggregated/", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"mostRecentTrainingStatus":{"latestTrainingStatusData":{"d1":{"primaryTrainingDevice":true,"acuteTrainingLoadDTO":{"dailyTrainingLoadAcute":300,"dailyTrainingLoadChronic":250,"acwrStatus":"OPTIMAL"}}}}}`)
	})
	mux.HandleFunc("/usersummary-service/usersummary/daily/", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"restingHeartRate":45,"bodyBatteryHighestValue":90,"averageStressLevel":30}`)
	})
	mux.HandleFunc("/wellness-service/wellness/dailySleepData/", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"dailySleepDTO":{"sleepTimeSeconds":27000,"sleepScores":{"overall":{"value":80}}}}`)
	})
	mux.HandleFunc("/hrv-service/hrv/", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"hrvSummary":{"lastNightAvg":70,"weeklyAvg":66,"baseline":{"balancedLow":55,"balancedUpper":80}}}`)
	})
	mux.HandleFunc("/biometric-service/biometric/latestLactateThreshold", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `[{"heartRate":170,"speed":0.44}]`)
	})
	mux.HandleFunc("/metrics-service/metrics/racepredictions/latest/", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"time5K":1200,"time10K":2500}`)
	})
	mux.HandleFunc("/userprofile-service/socialProfile", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"displayName":"dn-123","userName":"runner"}`)
	})
	mux.HandleFunc("/oauth-service/oauth/exchange/user/2.0", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"scope":"CONNECT","jti":"j","token_type":"Bearer","access_token":"AT","refresh_token":"RT","expires_in":3600,"refresh_token_expires_in":86400}`)
	})
	mux.HandleFunc("/oauth_consumer.json", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"consumer_key":"CK","consumer_secret":"CS"}`)
	})
	api.srv = httptest.NewServer(mux)
	t.Cleanup(api.srv.Close)
	return api
}

func (a *garminAPI) listCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.listCalls
}

type rewriteTransport struct {
	base *url.URL
	rt   http.RoundTripper
}

func (t rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = t.base.Scheme
	req.URL.Host = t.base.Host
	req.Host = t.base.Host
	return t.rt.RoundTrip(req)
}

// factory pins the provider's HTTP client to the httptest server.
func (a *garminAPI) factory() garmin.ProviderOption {
	base, _ := url.Parse(a.srv.URL)
	return garmin.WithClientFactory(func(c garmin.Credentials, save garmin.CredentialSaver) *garmin.Client {
		return garmin.NewClient(c,
			garmin.WithHTTPClient(&http.Client{Transport: rewriteTransport{base: base, rt: a.srv.Client().Transport}}),
			garmin.WithDomain("garmin.com"),
			garmin.WithRequestDelay(0),
			garmin.WithCredentialSaver(save),
		)
	})
}

// seedGarminCredential stores a logged-in Garmin OAuth bundle for uid.
func seedGarminCredential(ctx context.Context, t *testing.T, st *storage.Store, uid string) {
	t.Helper()
	secret, err := json.Marshal(map[string]any{
		"oauth1": map[string]any{"oauth_token": "OT", "oauth_token_secret": "OS", "domain": "garmin.com"},
		"oauth2": map[string]any{"scope": "CONNECT", "jti": "j", "token_type": "Bearer",
			"access_token": "AT", "refresh_token": "RT", "expires_in": 3600,
			"expires_at": time.Now().Add(time.Hour).Unix(), "refresh_token_expires_in": 86400,
			"refresh_token_expires_at": time.Now().Add(24 * time.Hour).Unix()},
		"display_name": "dn-123", "user_name": "runner",
	})
	if err != nil {
		t.Fatalf("marshal secret: %v", err)
	}
	email, region := "a@b.com", "global"
	if err := st.SaveCredential(ctx, &storage.ProviderCredential{
		UserID: uid, Provider: "garmin", Email: &email, Region: &region,
		Secret: secret, UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("credential: %v", err)
	}
}

// The Garmin executor runs the whole T02→T04 seam: real session rows, real
// dispatch, the provider-agnostic handler over the real adapter and store,
// fenced activity publishes, honest gap accounting, and idempotent
// re-delivery.
func TestOnboardingRecent_GarminEndToEndWithSweep(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	api := newGarminAPI(t)
	uid := uuid.NewString()
	seedGarminCredential(ctx, t, st, uid)

	enq := &fakeEnqueuer{}
	svc, err := onboardingsync.New(onboardingsync.Config{
		Store: st, Enqueuer: enq, Jobs: st, Runs: st,
		JobType:            JobType,
		AnalysisJobType:    "onboarding_recent_analysis",
		LegacyFullPipeline: "onboarding",
		Logger:             zap.NewNop(),
	})
	if err != nil {
		t.Fatalf("service: %v", err)
	}
	// Claim with a FIXED anchor (like the coros suite's seedSession) so the
	// fixture dates stay inside the window regardless of the run date: the
	// 90-day activities window is 2026-08-19..2026-11-16, health 28 days.
	claim, err := st.ClaimOrCreateOnboardingSyncSession(ctx, storage.OnboardingSyncClaimSpec{
		UserID: uid, Provider: "garmin",
		AnchorDay: "2026-11-16", AnchorAtUTC: time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC),
		StageNames: []string{storage.OnboardingSyncStageRecentRaw},
		WorkItems: map[string][]storage.OnboardingSyncWorkItemSpec{
			storage.OnboardingSyncStageRecentRaw: {
				{Kind: "activities", RangeFrom: "2026-08-19", RangeTo: "2026-11-16"},
				{Kind: "health", RangeFrom: "2026-10-20", RangeTo: "2026-11-16"},
				{Kind: "dashboard", RangeFrom: "2026-11-16", RangeTo: "2026-11-16"},
			},
		},
		IdempotencyKey: func(stage, sessionID string, rev int64) string {
			return fmt.Sprintf("t1007:%s:%s:rev%d", sessionID, stage, rev)
		},
	})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	sess := claim.Session
	if !sess.ShellReady {
		t.Fatal("shell_ready before dispatch")
	}
	if err := svc.DispatchSession(ctx, sess.SessionID); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if len(enq.specs) != 1 {
		t.Fatalf("dispatches = %d, want 1 stage job", len(enq.specs))
	}
	// Persist the dispatched job row like the real enqueuer does.
	spec, jobID := enq.specs[0], enq.ids[0]
	now := time.Now().UTC()
	j := &job.Job{
		ID: jobID, UserID: uid, Type: JobType,
		Status: job.StatusRunning, InputJSON: spec.InputJSON, IdempotencyKey: spec.IdempotencyKey,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := st.Jobs().Create(ctx, j); err != nil {
		t.Fatalf("job create: %v", err)
	}

	gp := garmin.New(st, garmin.NewStorageCredentialStore(st), api.factory(), garmin.WithProviderRequestDelay(0))
	h := New(Config{
		Resolve: func(context.Context, string) (Provider, error) { return gp, nil },
		Store:   st, Sessions: st, Jobs: 2,
	})
	result, err := h(ctx, j, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("executor: %v", err)
	}
	var sr onboardingsync.StageResult
	if err := json.Unmarshal([]byte(result), &sr); err != nil {
		t.Fatalf("result json: %v", err)
	}
	if sr.Stage != storage.OnboardingSyncStageRecentRaw {
		t.Errorf("stage = %q, want recent_raw", sr.Stage)
	}
	// Activities exist only on two days of the 90-day window (2026-10-20 and
	// 2026-11-07 Shanghai — the 23:30 GMT start lands on the next Shanghai
	// day), so the activities channel records the empty stretches as gaps;
	// the health channel answered with signal through the anchor day, so the
	// stage-level observed window merges to 2026-10-20..2026-11-16 and the
	// stage is completed_with_gaps, never silently read as fully covered.
	if sr.Status != storage.OnboardingSyncCoverageCompletedWithGaps || len(sr.Gaps) == 0 {
		t.Errorf("status = %q gaps = %+v, want completed_with_gaps with the empty stretches", sr.Status, sr.Gaps)
	}
	fmtObs := func(p *string) string {
		if p == nil {
			return "<nil>"
		}
		return *p
	}
	if sr.ObservedFrom == nil || *sr.ObservedFrom != "2026-10-20" ||
		sr.ObservedTo == nil || *sr.ObservedTo != "2026-11-16" {
		t.Errorf("observed = %s..%s, want 2026-10-20..2026-11-16 (merged data days)",
			fmtObs(sr.ObservedFrom), fmtObs(sr.ObservedTo))
	}

	j.Status = job.StatusDone
	j.ResultJSON = result
	done := time.Now().UTC()
	j.CompletedAt = &done
	if err := st.Jobs().Update(ctx, j); err != nil {
		t.Fatalf("job done: %v", err)
	}
	svc.Sweep(ctx)
	finishAnalysisStage(t, st, svc, enq, sess)

	got, err := st.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
	if err != nil || got.State != storage.OnboardingSyncStateCompletedWithGaps {
		t.Fatalf("session state = %s err=%v, want completed_with_gaps", got.State, err)
	}

	// Work items carry their complete-fetch credentials; the activities item
	// is a gap item (empty stretches) with its proof, health/dashboard done.
	items, err := st.ListOnboardingSyncWorkItems(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	if err != nil {
		t.Fatalf("items: %v", err)
	}
	for _, it := range items {
		switch it.Kind {
		case "health", "dashboard":
			if it.Status != storage.OnboardingSyncItemDone {
				t.Errorf("item %s status = %s, want done (every endpoint answered with signal)", it.Kind, it.Status)
			}
			if it.FetchCredential == nil || *it.FetchCredential == "" {
				t.Errorf("item %s done without a complete-fetch credential", it.Kind)
			}
		case "activities":
			if it.Status != storage.OnboardingSyncItemGap {
				t.Errorf("item activities status = %s, want gap (empty stretches recorded)", it.Status)
			}
		}
	}

	// Real persistence: the in-window activities landed in MySQL (the older
	// page's activity must NOT have been fetched or written).
	for _, label := range []string{"1001", "1002"} {
		exists, err := st.ActivityExists(ctx, uid, label)
		if err != nil || !exists {
			t.Errorf("activity %s exists=%v err=%v, want true", label, exists, err)
		}
	}
	if exists, _ := st.ActivityExists(ctx, uid, "1000"); exists {
		t.Error("out-of-window activity 1000 must not be written")
	}

	// The readiness view serves recent_data=ready_with_gaps off the coverage.
	view, err := svc.View(ctx, uid)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if string(view.Readiness.RecentData) != "ready_with_gaps" {
		t.Errorf("recent_data readiness = %q, want ready_with_gaps (view=%+v)", view.Readiness.RecentData, view)
	}

	// Re-delivery idempotence: the finalized session re-serves its coverage
	// without touching the provider.
	before := api.listCount()
	again, err := h(ctx, j, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("re-delivery: %v", err)
	}
	var sr2 onboardingsync.StageResult
	_ = json.Unmarshal([]byte(again), &sr2)
	if sr2.Status != storage.OnboardingSyncCoverageCompletedWithGaps || api.listCount() != before {
		t.Errorf("re-delivery status=%q listCalls delta=%d, want the recorded outcome with no provider traffic",
			sr2.Status, api.listCount()-before)
	}
}
