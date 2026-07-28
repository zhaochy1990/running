package garmin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

// ─────────────────────────────────────────────────────────────────────────────
// Host-rewriting transport: all Garmin hosts (sso./connectapi./S3) route to one
// httptest server; the mux keys on path.
// ─────────────────────────────────────────────────────────────────────────────

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

func mockHTTPClient(srv *httptest.Server) *http.Client {
	base, _ := url.Parse(srv.URL)
	return &http.Client{Transport: rewriteTransport{base: base, rt: srv.Client().Transport}}
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory storage.Writer
// ─────────────────────────────────────────────────────────────────────────────

type fakeWriter struct {
	activities map[string]*storage.Activity
	health     map[string]*storage.DailyHealth
	hrv        map[string]*storage.DailyHRV
	dashboards int
	races      int
	meta       map[string]string
}

func newFakeWriter() *fakeWriter {
	return &fakeWriter{
		activities: map[string]*storage.Activity{},
		health:     map[string]*storage.DailyHealth{},
		hrv:        map[string]*storage.DailyHRV{},
		meta:       map[string]string{},
	}
}

func (f *fakeWriter) ActivityExists(_ context.Context, _, labelID string) (bool, error) {
	_, ok := f.activities[labelID]
	return ok, nil
}
func (f *fakeWriter) UpsertActivity(_ context.Context, a *storage.Activity, _ []storage.Lap, _ []storage.TimeseriesPoint, _ []storage.ActivityWatchZone) error {
	f.activities[a.LabelID] = a
	return nil
}
func (f *fakeWriter) UpsertDailyHealth(_ context.Context, h *storage.DailyHealth) error {
	f.health[h.Date] = h
	return nil
}
func (f *fakeWriter) UpsertDashboard(context.Context, *storage.Dashboard) error {
	f.dashboards++
	return nil
}
func (f *fakeWriter) UpsertDailyHRV(_ context.Context, h *storage.DailyHRV) error {
	f.hrv[h.Date] = h
	return nil
}
func (f *fakeWriter) UpsertRacePrediction(context.Context, *storage.RacePrediction) error {
	f.races++
	return nil
}
func (f *fakeWriter) SetMeta(_ context.Context, _, key, value string) error {
	f.meta[key] = value
	return nil
}
func (f *fakeWriter) GetMeta(_ context.Context, _, key string) (string, bool, error) {
	v, ok := f.meta[key]
	return v, ok, nil
}

// captureCreds records the last saved bundle and can pre-seed a logged-in one.
type captureCreds struct {
	seed  Credentials
	saved *Credentials
}

func (c *captureCreds) Load(context.Context, string) (Credentials, error) { return c.seed, nil }
func (c *captureCreds) Save(_ context.Context, _ string, cr Credentials) error {
	cp := cr
	c.saved = &cp
	return nil
}

// newTestProvider wires a Provider whose client talks to srv via the rewrite
// transport. creds pre-seeds/captures credentials; the returned fakeWriter
// exposes what was stored.
func newTestProvider(t *testing.T, mux http.Handler, creds CredentialStore) (*Provider, *fakeWriter) {
	t.Helper()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	fw := newFakeWriter()
	factory := func(c Credentials, save CredentialSaver) *Client {
		return NewClient(c,
			WithHTTPClient(mockHTTPClient(srv)),
			WithDomain("garmin.com"),
			WithRequestDelay(0),
			WithCredentialSaver(save))
	}
	return New(fw, creds, WithClientFactory(factory)), fw
}

// loggedInCreds is a pre-authenticated bundle for sync tests.
func loggedInCreds() *captureCreds {
	return &captureCreds{seed: Credentials{
		Email:  "a@b.com",
		Region: "global",
		OAuth1: OAuth1Token{OAuthToken: "OT", OAuthTokenSecret: "OS", Domain: "garmin.com"},
		// expired OAuth2 forces an exchange via the mock on first request.
		DisplayName: "", // force ensureProfile fetch
	}}
}

// garminMux builds a mock Garmin API covering the auth + sync endpoints.
func garminMux() *http.ServeMux {
	mux := http.NewServeMux()

	// OAuth1 consumer creds (S3).
	mux.HandleFunc("/oauth_consumer.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"consumer_key":"CK","consumer_secret":"CS"}`))
	})
	// SSO sign-in + login.
	mux.HandleFunc("/mobile/sso/en/sign-in", func(w http.ResponseWriter, _ *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "GARMIN-SSO", Value: "x"})
		w.Write([]byte("<html></html>"))
	})
	mux.HandleFunc("/mobile/api/login", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"responseStatus":{"type":"SUCCESSFUL"},"serviceTicketId":"ST-123"}`))
	})
	mux.HandleFunc("/portal/sso/embed", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	})
	// OAuth1 preauthorized (form-encoded) + OAuth2 exchange (json).
	mux.HandleFunc("/oauth-service/oauth/preauthorized", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("oauth_token=OT&oauth_token_secret=OS"))
	})
	mux.HandleFunc("/oauth-service/oauth/exchange/user/2.0", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"scope":"CONNECT","jti":"j","token_type":"Bearer","access_token":"AT","refresh_token":"RT","expires_in":3600,"refresh_token_expires_in":86400}`))
	})
	// Profile.
	mux.HandleFunc("/userprofile-service/socialProfile", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"displayName":"dn-123","userName":"runner"}`))
	})

	// Activities list: page 1 has two, later pages empty.
	mux.HandleFunc("/activitylist-service/activities/search/activities", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("start") == "0" {
			w.Write([]byte(`[
				{"activityId":1001,"activityType":{"typeKey":"running"},"startTimeGMT":"2026-05-09 23:00:00","distance":10000.0,"duration":3000.0,"averageSpeed":3.33,"averageHR":150},
				{"activityId":1002,"activityType":{"typeKey":"running"},"startTimeGMT":"2026-05-08 23:00:00","distance":8000.0,"duration":2400.0,"averageSpeed":3.33,"averageHR":148}
			]`))
			return
		}
		w.Write([]byte(`[]`))
	})
	// Activity sub-resources (details/splits/weather) — prefix match.
	mux.HandleFunc("/activity-service/activity/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case hasSuffix(r.URL.Path, "/details"):
			w.Write([]byte(`{"metricDescriptors":[{"key":"directHeartRate","metricsIndex":0}],"activityDetailMetrics":[{"metrics":[150.0]}]}`))
		case hasSuffix(r.URL.Path, "/splits"):
			w.Write([]byte(`{"lapDTOs":[{"lapIndex":1,"distance":1000.0,"duration":300.0}]}`))
		case hasSuffix(r.URL.Path, "/weather"):
			w.Write([]byte(`{"temp":18.0,"relativeHumidity":55}`))
		default:
			w.Write([]byte(`{}`))
		}
	})

	// Health endpoints (return signal for any date).
	mux.HandleFunc("/metrics-service/metrics/trainingstatus/aggregated/", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"mostRecentTrainingStatus":{"latestTrainingStatusData":{"d1":{"primaryTrainingDevice":true,"acuteTrainingLoadDTO":{"dailyTrainingLoadAcute":300,"dailyTrainingLoadChronic":250,"acwrStatus":"OPTIMAL"}}}}}`))
	})
	mux.HandleFunc("/usersummary-service/usersummary/daily/", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"restingHeartRate":45,"bodyBatteryHighestValue":90,"averageStressLevel":30}`))
	})
	mux.HandleFunc("/wellness-service/wellness/dailySleepData/", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"dailySleepDTO":{"sleepTimeSeconds":27000,"sleepScores":{"overall":{"value":80}}}}`))
	})
	mux.HandleFunc("/hrv-service/hrv/", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"hrvSummary":{"lastNightAvg":70,"weeklyAvg":66,"baseline":{"balancedLow":55,"balancedUpper":80}}}`))
	})
	mux.HandleFunc("/biometric-service/biometric/latestLactateThreshold", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`[{"heartRate":170,"speed":0.44}]`))
	})
	mux.HandleFunc("/metrics-service/metrics/racepredictions/latest/", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"time5K":1200,"time10K":2500}`))
	})
	return mux
}

func hasSuffix(s, suffix string) bool {
	return len(s) >= len(suffix) && s[len(s)-len(suffix):] == suffix
}
