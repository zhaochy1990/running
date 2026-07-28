package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/health"
	"github.com/zhaochy1990/stride/internal/job"
)

func TestMain(m *testing.M) {
	gin.SetMode(gin.TestMode)
	m.Run()
}

// --- fakes -------------------------------------------------------------------

type fakeJobs struct {
	byID     map[string]*job.Job
	byIdem   map[string]*job.Job
	nextID   int
	enqError error
}

func newFakeJobs() *fakeJobs {
	return &fakeJobs{byID: map[string]*job.Job{}, byIdem: map[string]*job.Job{}}
}

func jkey(pk, id string) string { return pk + "|" + id }

func (f *fakeJobs) Enqueue(_ context.Context, spec job.EnqueueSpec) (string, error) {
	if f.enqError != nil {
		return "", f.enqError
	}
	if spec.IdempotencyKey != "" {
		if _, ok := f.byIdem[jkey(spec.PartitionKey, spec.IdempotencyKey)]; ok {
			return "", job.ErrConflict
		}
	}
	f.nextID++
	id := "job-" + string(rune('a'+f.nextID))
	j := &job.Job{ID: id, PartitionKey: spec.PartitionKey, Type: spec.Type, Status: job.StatusQueued, InputJSON: spec.InputJSON, IdempotencyKey: spec.IdempotencyKey}
	f.byID[jkey(spec.PartitionKey, id)] = j
	if spec.IdempotencyKey != "" {
		f.byIdem[jkey(spec.PartitionKey, spec.IdempotencyKey)] = j
	}
	return id, nil
}

func (f *fakeJobs) Get(_ context.Context, pk, id string) (*job.Job, error) {
	if j, ok := f.byID[jkey(pk, id)]; ok {
		return j, nil
	}
	return nil, &job.ErrNotFound{Key: jkey(pk, id)}
}

func (f *fakeJobs) JobByIdempotencyKey(_ context.Context, pk, key string) (*job.Job, error) {
	if j, ok := f.byIdem[jkey(pk, key)]; ok {
		return j, nil
	}
	return nil, &job.ErrNotFound{Key: jkey(pk, key)}
}

type fakeRuns struct {
	byID   map[string]*job.PipelineRun
	byIdem map[string]*job.PipelineRun
	nextID int
}

func newFakeRuns() *fakeRuns {
	return &fakeRuns{byID: map[string]*job.PipelineRun{}, byIdem: map[string]*job.PipelineRun{}}
}

func (f *fakeRuns) StartPipeline(_ context.Context, name, pk, idem string) (string, error) {
	if idem != "" {
		if _, ok := f.byIdem[jkey(pk, idem)]; ok {
			return "", job.ErrConflict
		}
	}
	f.nextID++
	id := "run-" + string(rune('a'+f.nextID))
	r := &job.PipelineRun{RunID: id, PartitionKey: pk, Name: name, Status: job.StatusRunning, IdempotencyKey: idem}
	f.byID[jkey(pk, id)] = r
	if idem != "" {
		f.byIdem[jkey(pk, idem)] = r
	}
	return id, nil
}

func (f *fakeRuns) Get(_ context.Context, pk, id string) (*job.PipelineRun, error) {
	if r, ok := f.byID[jkey(pk, id)]; ok {
		return r, nil
	}
	return nil, &job.ErrNotFound{Key: jkey(pk, id)}
}

func (f *fakeRuns) PipelineRunByIdempotencyKey(_ context.Context, pk, key string) (*job.PipelineRun, error) {
	if r, ok := f.byIdem[jkey(pk, key)]; ok {
		return r, nil
	}
	return nil, &job.ErrNotFound{Key: jkey(pk, key)}
}

// --- harness -----------------------------------------------------------------

const (
	testIssuer   = "https://auth.example.com"
	testAudience = "stride"
	testToken    = "s3cr3t-internal"
)

type harness struct {
	svc  *Service
	jobs *fakeJobs
	runs *fakeRuns
	key  *rsa.PrivateKey
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	jobs := newFakeJobs()
	runs := newFakeRuns()
	svc := NewService(Config{
		Enqueuer:              jobs,
		Jobs:                  jobs,
		JobsIdem:              jobs,
		Pipelines:             runs,
		Runs:                  runs,
		RunsIdem:              runs,
		JobUserInitiable:      map[string]bool{"hello": false, "watch_sync": true},
		PipelineUserInitiable: map[string]bool{"onboarding": true, "internal_only": false},
		Auth:                  NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
	})
	return &harness{svc: svc, jobs: jobs, runs: runs, key: key}
}

func (h *harness) userToken(t *testing.T, sub string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": sub,
		"iss": testIssuer,
		"aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Unix(),
	})
	s, err := tok.SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

func (h *harness) do(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, r)
	return w
}

func internalHdr() map[string]string { return map[string]string{"X-Internal-Token": testToken} }

// --- tests -------------------------------------------------------------------

func TestCreateJob_Unauthorized(t *testing.T) {
	h := newHarness(t)
	w := h.do(http.MethodPost, "/jobs", `{"type":"hello"}`, nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", w.Code)
	}
}

func TestCreateJob_Internal_AnyTypeAndPartition(t *testing.T) {
	h := newHarness(t)
	w := h.do(http.MethodPost, "/jobs", `{"type":"hello","partition_key":"Global"}`, internalHdr())
	if w.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202: %s", w.Code, w.Body.String())
	}
	var resp enqueueJobResponse
	mustJSON(t, w, &resp)
	if resp.JobID == "" || resp.PartitionKey != "Global" {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestCreateJob_User_DerivesPartitionFromSub(t *testing.T) {
	h := newHarness(t)
	tok := h.userToken(t, "user-123")
	// A client-supplied partition_key must be ignored for the user tier.
	w := h.do(http.MethodPost, "/jobs", `{"type":"watch_sync","partition_key":"someone-else"}`,
		map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202: %s", w.Code, w.Body.String())
	}
	var resp enqueueJobResponse
	mustJSON(t, w, &resp)
	if resp.PartitionKey != "user-123" {
		t.Fatalf("partition = %q, want user-123", resp.PartitionKey)
	}
}

func TestCreateJob_User_NonInitiableForbidden(t *testing.T) {
	h := newHarness(t)
	tok := h.userToken(t, "user-123")
	w := h.do(http.MethodPost, "/jobs", `{"type":"hello"}`, map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403: %s", w.Code, w.Body.String())
	}
}

func TestCreateJob_UnknownType(t *testing.T) {
	h := newHarness(t)
	w := h.do(http.MethodPost, "/jobs", `{"type":"nope"}`, internalHdr())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", w.Code)
	}
}

func TestCreateJob_IdempotentReplay(t *testing.T) {
	h := newHarness(t)
	hdr := internalHdr()
	hdr["Idempotency-Key"] = "abc"
	first := h.do(http.MethodPost, "/jobs", `{"type":"hello"}`, hdr)
	if first.Code != http.StatusAccepted {
		t.Fatalf("first code = %d, want 202", first.Code)
	}
	var a enqueueJobResponse
	mustJSON(t, first, &a)

	second := h.do(http.MethodPost, "/jobs", `{"type":"hello"}`, hdr)
	if second.Code != http.StatusOK {
		t.Fatalf("second code = %d, want 200 (dedup)", second.Code)
	}
	var b enqueueJobResponse
	mustJSON(t, second, &b)
	if b.JobID != a.JobID || !b.Deduplicated {
		t.Fatalf("dedup mismatch: a=%+v b=%+v", a, b)
	}
}

func TestGetJob_UserPartitionScoping(t *testing.T) {
	h := newHarness(t)
	// Seed a job in user-123's partition.
	id, _ := h.jobs.Enqueue(context.Background(), job.EnqueueSpec{Type: "watch_sync", PartitionKey: "user-123"})
	tok := h.userToken(t, "user-123")

	ok := h.do(http.MethodGet, "/jobs/user-123/"+id, "", map[string]string{"Authorization": "Bearer " + tok})
	if ok.Code != http.StatusOK {
		t.Fatalf("own get code = %d, want 200: %s", ok.Code, ok.Body.String())
	}

	forbidden := h.do(http.MethodGet, "/jobs/other-user/"+id, "", map[string]string{"Authorization": "Bearer " + tok})
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("cross-partition code = %d, want 403", forbidden.Code)
	}

	missing := h.do(http.MethodGet, "/jobs/user-123/nope", "", map[string]string{"Authorization": "Bearer " + tok})
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing code = %d, want 404", missing.Code)
	}
}

func TestStartPipeline_UserInitiableAndUnknown(t *testing.T) {
	h := newHarness(t)
	tok := h.userToken(t, "user-9")

	ok := h.do(http.MethodPost, "/pipelines/onboarding", "", map[string]string{"Authorization": "Bearer " + tok})
	if ok.Code != http.StatusAccepted {
		t.Fatalf("start code = %d, want 202: %s", ok.Code, ok.Body.String())
	}
	var resp startPipelineResponse
	mustJSON(t, ok, &resp)
	if resp.RunID == "" || resp.PartitionKey != "user-9" || resp.PipelineName != "onboarding" {
		t.Fatalf("resp = %+v", resp)
	}

	unknown := h.do(http.MethodPost, "/pipelines/does-not-exist", "", map[string]string{"Authorization": "Bearer " + tok})
	if unknown.Code != http.StatusBadRequest {
		t.Fatalf("unknown code = %d, want 400", unknown.Code)
	}

	// A user may not start an internal-only pipeline.
	forbidden := h.do(http.MethodPost, "/pipelines/internal_only", "", map[string]string{"Authorization": "Bearer " + tok})
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("internal-only code = %d, want 403", forbidden.Code)
	}
}

func TestBadJWTRejected(t *testing.T) {
	h := newHarness(t)
	// A token signed by a different key must fail verification.
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": "user-1", "iss": testIssuer, "aud": testAudience, "exp": time.Now().Add(time.Hour).Unix(),
	})
	signed, _ := tok.SignedString(other)
	w := h.do(http.MethodPost, "/jobs", `{"type":"watch_sync"}`, map[string]string{"Authorization": "Bearer " + signed})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", w.Code)
	}
}

func mustJSON(t *testing.T, w *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), v); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
}

func TestHealthz_ReflectsChecks(t *testing.T) {
	svc := NewService(Config{
		Auth: NewAuthenticator("t", nil),
		Health: map[string]health.Check{
			"mysql":  func(context.Context) error { return nil },
			"broker": func(context.Context) error { return errors.New("down") },
		},
	})
	w := httptest.NewRecorder()
	svc.Router().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503 (a check is failing)", w.Code)
	}
}
