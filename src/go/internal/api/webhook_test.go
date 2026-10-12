package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/webhook"
)

// --- fakes -------------------------------------------------------------------

// fakeWebhookAdapter is the single test seam: a provider whose credentials are
// a plain client/secret pair and whose body shape is
// {"events":[{...}]} — one canned event per item.
type fakeWebhookAdapter struct {
	provider   string
	client     string
	secret     string
	parseError error
}

type fakeEventItem struct {
	ProviderUserID     string `json:"providerUserId"`
	ProviderActivityID string `json:"providerActivityId"`
	FitURL             string `json:"fitUrl"`
	PlanWorkoutID      string `json:"planWorkoutId"`
}

func (f *fakeWebhookAdapter) Provider() string { return f.provider }

func (f *fakeWebhookAdapter) VerifyCredentials(headers http.Header) error {
	if headers.Get("client") != f.client || headers.Get("secret") != f.secret {
		return errors.New("credential mismatch")
	}
	return nil
}

func (f *fakeWebhookAdapter) ParseEvents(raw []byte) ([]webhook.ProviderEvent, error) {
	if f.parseError != nil {
		return nil, f.parseError
	}
	var body struct {
		Events []fakeEventItem `json:"events"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("fake: decode body: %w", err)
	}
	events := make([]webhook.ProviderEvent, 0, len(body.Events))
	for _, item := range body.Events {
		events = append(events, webhook.ProviderEvent{
			Provider:           f.provider,
			ProviderUserID:     item.ProviderUserID,
			ProviderActivityID: item.ProviderActivityID,
			EventType:          webhook.EventTypeActivityCreate,
			FitURL:             item.FitURL,
			PlanWorkoutID:      item.PlanWorkoutID,
		})
	}
	return events, nil
}

// fakeWebhookEvents mirrors the storage contract: (provider,
// provider_activity_id) uniqueness with created=false on the duplicate, and
// the row id back-filled in both cases.
type fakeWebhookEvents struct {
	rows   map[string]*storage.ProviderEvent
	nextID uint64
	err    error
}

func newFakeWebhookEvents() *fakeWebhookEvents {
	return &fakeWebhookEvents{rows: map[string]*storage.ProviderEvent{}}
}

func (f *fakeWebhookEvents) CreateProviderEvent(_ context.Context, ev *storage.ProviderEvent) (bool, error) {
	if f.err != nil {
		return false, f.err
	}
	key := ev.Provider + "|" + ev.ProviderActivityID
	if existing, dup := f.rows[key]; dup {
		ev.ID = existing.ID
		return false, nil
	}
	f.nextID++
	ev.ID = f.nextID
	cp := *ev
	f.rows[key] = &cp
	return true, nil
}

// fakeWebhookResolver maps "coros/openid-..." style keys to STRIDE users.
type fakeWebhookResolver struct {
	users map[string]string
	err   error
}

func (f *fakeWebhookResolver) ResolveProviderUser(_ context.Context, provider, providerUserID string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	return f.users[provider+"/"+providerUserID], nil
}

// webhookHarness wires a Service whose webhook surface is fully fake-driven.
type webhookHarness struct {
	svc      *Service
	jobs     *fakeJobs
	events   *fakeWebhookEvents
	resolver *fakeWebhookResolver
	adapter  *fakeWebhookAdapter
}

func newWebhookHarness(t *testing.T, enqueueEnabled bool) *webhookHarness {
	t.Helper()
	adapter := &fakeWebhookAdapter{provider: "fake", client: "c1", secret: "s1"}
	events := newFakeWebhookEvents()
	resolver := &fakeWebhookResolver{users: map[string]string{
		"fake/openid-bound": "user-1",
	}}
	jobs := newFakeJobs()
	svc := NewService(Config{
		Enqueuer: jobs,
		Jobs:     jobs,
		Auth:     NewAuthenticator(testToken, nil),
		WebhookAdapters: map[string]webhook.Adapter{
			adapter.Provider(): adapter,
		},
		WebhookEventStore:     events,
		WebhookUserResolver:   resolver,
		WebhookFetchJobType:   "provider_activity_fetch",
		WebhookEnqueueEnabled: enqueueEnabled,
	})
	return &webhookHarness{svc: svc, jobs: jobs, events: events, resolver: resolver, adapter: adapter}
}

func (h *webhookHarness) push(body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/webhook/push/fake", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, req)
	return w
}

func goodHeaders() map[string]string {
	return map[string]string{"client": "c1", "secret": "s1"}
}

// result extracts the body's result field (the only thing COROS inspects).
func result(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Result string `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response not a result body: %v (%s)", err, w.Body.String())
	}
	return body.Result
}

func eventBody(items ...fakeEventItem) string {
	b, _ := json.Marshal(map[string]any{"events": items})
	return string(b)
}

// --- tests -------------------------------------------------------------------

func TestWebhookPush_UnknownProvider(t *testing.T) {
	h := newWebhookHarness(t, true)
	req := httptest.NewRequest(http.MethodPost, "/webhook/push/who", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", w.Code)
	}
	if r := result(t, w); r == "0000" {
		t.Fatal("unknown provider must answer a non-0000 result so misconfiguration is visible")
	}
	if len(h.events.rows) != 0 || len(h.jobs.byID) != 0 {
		t.Fatal("unknown provider must not record or enqueue anything")
	}
}

func TestWebhookPush_CredentialFailures(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
	}{
		{"missing both", nil},
		{"missing secret", map[string]string{"client": "c1"}},
		{"wrong client", map[string]string{"client": "nope", "secret": "s1"}},
		{"wrong secret", map[string]string{"client": "c1", "secret": "nope"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newWebhookHarness(t, true)
			w := h.push(eventBody(fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-1"}), tc.headers)
			if w.Code != http.StatusForbidden {
				t.Fatalf("code = %d, want 403", w.Code)
			}
			if r := result(t, w); r == "0000" {
				t.Fatal("credential failure must answer a non-0000 result")
			}
			if len(h.events.rows) != 0 || len(h.jobs.byID) != 0 {
				t.Fatal("credential failure must not record or enqueue anything")
			}
		})
	}
}

func TestWebhookPush_ParseFailures(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"undecodable body", "not-json"},
		{"adapter rejects batch", `{"events":[]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newWebhookHarness(t, true)
			if tc.name == "adapter rejects batch" {
				h.adapter.parseError = errors.New("missing required field openId")
			}
			w := h.push(tc.body, goodHeaders())
			if w.Code != http.StatusBadRequest {
				t.Fatalf("code = %d, want 400", w.Code)
			}
			if r := result(t, w); r == "0000" {
				t.Fatal("parse failure must answer a non-0000 result")
			}
			if len(h.events.rows) != 0 || len(h.jobs.byID) != 0 {
				t.Fatal("parse failure must not record or enqueue anything")
			}
		})
	}
}

func TestWebhookPush_SingleEvent(t *testing.T) {
	h := newWebhookHarness(t, true)
	w := h.push(eventBody(fakeEventItem{
		ProviderUserID: "openid-bound", ProviderActivityID: "label-1",
		FitURL: "https://oss.coros.com/fit/a.fit",
	}), goodHeaders())
	if w.Code != http.StatusOK || result(t, w) != "0000" {
		t.Fatalf("code=%d result=%s, want 200/0000 (%s)", w.Code, result(t, w), w.Body.String())
	}
	row := h.events.rows["fake|label-1"]
	if row == nil {
		t.Fatal("event row not recorded")
	}
	if row.UserID == nil || *row.UserID != "user-1" {
		t.Fatalf("user_id = %v, want resolved user-1", row.UserID)
	}
	if row.RawPayload == nil {
		t.Fatal("raw payload not retained")
	}
	j := h.jobs.byIdem[jkey("user-1", "webhook-fake-label-1")]
	if j == nil {
		t.Fatal("fetch job not enqueued")
	}
	if j.Type != "provider_activity_fetch" {
		t.Fatalf("job type = %q", j.Type)
	}
	var input struct {
		EventID uint64 `json:"event_id"`
	}
	if err := json.Unmarshal([]byte(j.InputJSON), &input); err != nil {
		t.Fatalf("job input: %v", err)
	}
	if input.EventID != row.ID {
		t.Fatalf("job event_id = %d, want the provider_events row id %d", input.EventID, row.ID)
	}
}

func TestWebhookPush_BatchEvents(t *testing.T) {
	h := newWebhookHarness(t, true)
	w := h.push(eventBody(
		fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-a"},
		fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-b"},
	), goodHeaders())
	if w.Code != http.StatusOK || result(t, w) != "0000" {
		t.Fatalf("code=%d result=%s, want 200/0000", w.Code, result(t, w))
	}
	if len(h.events.rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(h.events.rows))
	}
	if len(h.jobs.byID) != 2 {
		t.Fatalf("jobs = %d, want 2", len(h.jobs.byID))
	}
}

func TestWebhookPush_DuplicatePushes(t *testing.T) {
	body := eventBody(
		fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-dup"},
		fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-keep"},
	)
	h := newWebhookHarness(t, true)
	for i := 0; i < 2; i++ {
		w := h.push(body, goodHeaders())
		if w.Code != http.StatusOK || result(t, w) != "0000" {
			t.Fatalf("push #%d: code=%d result=%s, want 200/0000 (duplicate pushes are success)", i, w.Code, result(t, w))
		}
	}
	// The re-push re-attempts the enqueue (duplicate events must heal a
	// failed one); the job idempotency key keeps it at one job per activity.
	if len(h.events.rows) != 2 {
		t.Fatalf("rows = %d, want 2 (dedup by unique index)", len(h.events.rows))
	}
	if len(h.jobs.byID) != 2 {
		t.Fatalf("jobs = %d, want 2 (no duplicate fetch)", len(h.jobs.byID))
	}

	// Same-batch duplicates dedup identically.
	w := h.push(eventBody(
		fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-same"},
		fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-same"},
	), goodHeaders())
	if w.Code != http.StatusOK || result(t, w) != "0000" {
		t.Fatalf("code=%d result=%s, want 200/0000", w.Code, result(t, w))
	}
	if row := h.events.rows["fake|label-same"]; row == nil {
		t.Fatal("batch-duplicate event not recorded once")
	}
	if len(h.jobs.byID) != 3 {
		t.Fatalf("jobs = %d, want 3 (2 from before + 1 for label-same)", len(h.jobs.byID))
	}
}

// An enqueue transient failure answers 5xx so COROS re-pushes; the re-push
// hits the recorded event but MUST retry the enqueue — otherwise the fetch
// for that activity is lost forever while the provider stops retrying.
func TestWebhookPush_EnqueueFailureHealsOnRetry(t *testing.T) {
	h := newWebhookHarness(t, true)
	h.jobs.enqError = errors.New("broker down")
	w := h.push(eventBody(fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-1"}), goodHeaders())
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("first push: code = %d, want 500", w.Code)
	}
	if len(h.events.rows) != 1 {
		t.Fatal("the event is durably recorded before the enqueue attempt")
	}

	h.jobs.enqError = nil // broker recovers; COROS re-pushes the same batch
	w = h.push(eventBody(fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-1"}), goodHeaders())
	if w.Code != http.StatusOK || result(t, w) != "0000" {
		t.Fatalf("re-push: code=%d result=%s, want 200/0000", w.Code, result(t, w))
	}
	j := h.jobs.byIdem[jkey("user-1", "webhook-fake-label-1")]
	if j == nil {
		t.Fatal("re-push must heal the failed enqueue")
	}
	if len(h.events.rows) != 1 {
		t.Fatalf("rows = %d, want 1 (still one event)", len(h.events.rows))
	}
	var input struct {
		EventID uint64 `json:"event_id"`
	}
	if err := json.Unmarshal([]byte(j.InputJSON), &input); err != nil {
		t.Fatalf("job input: %v", err)
	}
	if input.EventID != h.events.rows["fake|label-1"].ID {
		t.Fatalf("healed job event_id = %d, want the existing row id %d", input.EventID, h.events.rows["fake|label-1"].ID)
	}
}

func TestWebhookPush_UnboundUser(t *testing.T) {
	h := newWebhookHarness(t, true)
	w := h.push(eventBody(fakeEventItem{ProviderUserID: "openid-nobody", ProviderActivityID: "label-x"}), goodHeaders())
	// An unbound account can never become bound by retrying — answer success
	// so the provider stops pushing it.
	if w.Code != http.StatusOK || result(t, w) != "0000" {
		t.Fatalf("code=%d result=%s, want 200/0000", w.Code, result(t, w))
	}
	row := h.events.rows["fake|label-x"]
	if row == nil {
		t.Fatal("unbound event must still be recorded for audit")
	}
	if row.UserID != nil {
		t.Fatalf("user_id = %v, want NULL", row.UserID)
	}
	if len(h.jobs.byID) != 0 {
		t.Fatal("unbound event must not enqueue a fetch")
	}
}

func TestWebhookPush_TransientFailures(t *testing.T) {
	cases := []struct {
		name   string
		inject func(h *webhookHarness)
	}{
		{"store insert fails", func(h *webhookHarness) { h.events.err = errors.New("db down") }},
		{"resolver fails", func(h *webhookHarness) { h.resolver.err = errors.New("auth svc down") }},
		{"enqueue fails", func(h *webhookHarness) { h.jobs.enqError = errors.New("broker down") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newWebhookHarness(t, true)
			tc.inject(h)
			w := h.push(eventBody(fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-1"}), goodHeaders())
			if w.Code != http.StatusInternalServerError {
				t.Fatalf("code = %d, want 500", w.Code)
			}
			if r := result(t, w); r == "0000" {
				t.Fatal("transient failure must answer a non-0000 result so the push retries")
			}
		})
	}
}

func TestWebhookPush_EnqueueConflictIsSuccess(t *testing.T) {
	// The fetch job's idempotency key already exists (double insurance with
	// the event unique index) — that is "already processed", not a failure.
	h := newWebhookHarness(t, true)
	h.push(eventBody(fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-1"}), goodHeaders())
	// Simulate the event row having been deleted while the job stayed: a new
	// event insert succeeds and Enqueue answers ErrConflict.
	delete(h.events.rows, "fake|label-1")
	w := h.push(eventBody(fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-1"}), goodHeaders())
	if w.Code != http.StatusOK || result(t, w) != "0000" {
		t.Fatalf("code=%d result=%s, want 200/0000", w.Code, result(t, w))
	}
}

func TestWebhookPush_EnqueueDisabled(t *testing.T) {
	h := newWebhookHarness(t, false)
	w := h.push(eventBody(fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-1"}), goodHeaders())
	if w.Code != http.StatusOK || result(t, w) != "0000" {
		t.Fatalf("code=%d result=%s, want 200/0000", w.Code, result(t, w))
	}
	if len(h.events.rows) != 1 {
		t.Fatal("events must be recorded while enqueueing is disabled")
	}
	if len(h.jobs.byID) != 0 {
		t.Fatal("no fetch may be enqueued while the switch is off (handler not shipped)")
	}
}

func TestWebhookPush_NoResolver(t *testing.T) {
	// The auth-service binding query is a follow-up: with no resolver wired
	// the surface still records (and with enqueueing on, treats every user as
	// unbound rather than failing).
	h := newWebhookHarness(t, true)
	// nil the resolver by rebuilding the service without one.
	adapter := &fakeWebhookAdapter{provider: "fake", client: "c1", secret: "s1"}
	events := newFakeWebhookEvents()
	jobs := newFakeJobs()
	svc := NewService(Config{
		Enqueuer: jobs, Jobs: jobs,
		Auth:                  NewAuthenticator(testToken, nil),
		WebhookAdapters:       map[string]webhook.Adapter{"fake": adapter},
		WebhookEventStore:     events,
		WebhookFetchJobType:   "provider_activity_fetch",
		WebhookEnqueueEnabled: true,
	})
	h.svc, h.jobs, h.events = svc, jobs, events

	w := h.push(eventBody(fakeEventItem{ProviderUserID: "openid-bound", ProviderActivityID: "label-1"}), goodHeaders())
	if w.Code != http.StatusOK || result(t, w) != "0000" {
		t.Fatalf("code=%d result=%s, want 200/0000", w.Code, result(t, w))
	}
	if len(h.jobs.byID) != 0 {
		t.Fatal("nil resolver must not enqueue")
	}
}

func TestWebhookPush_BodyTooLarge(t *testing.T) {
	h := newWebhookHarness(t, true)
	big := `{"events":[` + strings.Repeat(`{"providerUserId":"x","providerActivityId":"`+strings.Repeat("a", 1024)+`"}`, 2000) + `]}`
	w := h.push(big, goodHeaders())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400 (body cap)", w.Code)
	}
	if len(h.events.rows) != 0 {
		t.Fatal("oversized body must not record anything")
	}
}

// corosRouteFixture mirrors the official 5.3.3 example shape (a multisport
// parent without top-level fitUrl + a regular run) at route level; the full
// four-item document fixture is the adapter package's regression surface.
const corosRouteFixture = `{"sportDataList":[
	{"openId":"42dbb958c5a146f29ce9f89e05e5195a","labelId":"418173292602490880",
	 "mode":13,"subMode":1,"distance":22000,"calorie":220000,"avgSpeed":0,"avgFrequency":0,
	 "startTime":1522576178,"endTime":1532576178,"startTimezone":32,"endTimezone":32,
	 "triathlonItemList":[{"mode":8,"subMode":1,"distance":5142.43,"calorie":248338,"duration":1592,
		"fitUrl":"https://oss.coros.com/fit/407419767966679040/418173292602490880_2.fit"}]},
	{"openId":"42dbb958c5a146f29ce9f89e05e5195a","labelId":"418173315956375553",
	 "mode":8,"subMode":1,"distance":40000,"calorie":30000,"avgSpeed":368,"avgFrequency":0,
	 "startTime":1522576159,"endTime":1532576159,"startTimezone":32,"endTimezone":32,
	 "fitUrl":"https://oss.coros.com/fit/407419767966679040/418173315956375553.fit"}
]}`

// The real COROS payload must clear the whole route: adapter parse + record +
// enqueue driven by the documented 5.3.3 shape (regression against the
// official examples, exercised through the public route end to end).
func TestWebhookPush_CorosDocFixtureThroughRoute(t *testing.T) {
	events := newFakeWebhookEvents()
	resolver := &fakeWebhookResolver{users: map[string]string{
		"coros/42dbb958c5a146f29ce9f89e05e5195a": "user-1",
	}}
	jobs := newFakeJobs()
	adapter := webhook.NewCorosAdapter("stride", "pair")
	svc := NewService(Config{
		Enqueuer: jobs, Jobs: jobs,
		Auth: NewAuthenticator(testToken, nil),
		WebhookAdapters: map[string]webhook.Adapter{
			adapter.Provider(): adapter,
		},
		WebhookEventStore:     events,
		WebhookUserResolver:   resolver,
		WebhookFetchJobType:   "provider_activity_fetch",
		WebhookEnqueueEnabled: true,
	})
	req := httptest.NewRequest(http.MethodPost, "/webhook/push/coros",
		strings.NewReader(corosRouteFixture))
	req.Header.Set("client", "stride")
	req.Header.Set("secret", "pair")
	w := httptest.NewRecorder()
	svc.Router().ServeHTTP(w, req)
	if w.Code != http.StatusOK || result(t, w) != "0000" {
		t.Fatalf("code=%d result=%s body=%s, want 200/0000", w.Code, result(t, w), w.Body.String())
	}
	if len(events.rows) != 2 {
		t.Fatalf("rows = %d, want 2 (multisport + run)", len(events.rows))
	}
	if len(jobs.byID) != 2 {
		t.Fatalf("jobs = %d, want 2", len(jobs.byID))
	}
	// The multisport row keeps a NULL fit_url: its FIT downloads live on the
	// triathlonItemList children inside raw_payload.
	tri := events.rows["coros|418173292602490880"]
	if tri == nil || tri.FitURL != nil {
		t.Fatalf("multisport fit_url = %v, want NULL", tri)
	}
}
