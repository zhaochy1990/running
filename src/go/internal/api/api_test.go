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

func jkey(a, b string) string { return a + "|" + b }

func (f *fakeJobs) Enqueue(_ context.Context, spec job.EnqueueSpec) (string, error) {
	if f.enqError != nil {
		return "", f.enqError
	}
	if spec.IdempotencyKey != "" {
		if _, ok := f.byIdem[jkey(spec.UserID, spec.IdempotencyKey)]; ok {
			return "", job.ErrConflict
		}
	}
	f.nextID++
	id := "job-" + string(rune('a'+f.nextID))
	j := &job.Job{ID: id, UserID: spec.UserID, CreatedBy: spec.CreatedBy, Type: spec.Type, Status: job.StatusQueued, InputJSON: spec.InputJSON, IdempotencyKey: spec.IdempotencyKey}
	f.byID[id] = j
	if spec.IdempotencyKey != "" {
		f.byIdem[jkey(spec.UserID, spec.IdempotencyKey)] = j
	}
	return id, nil
}

func (f *fakeJobs) Get(_ context.Context, id string) (*job.Job, error) {
	if j, ok := f.byID[id]; ok {
		return j, nil
	}
	return nil, &job.ErrNotFound{Key: id}
}

func (f *fakeJobs) JobByIdempotencyKey(_ context.Context, userID, key string) (*job.Job, error) {
	if j, ok := f.byIdem[jkey(userID, key)]; ok {
		return j, nil
	}
	return nil, &job.ErrNotFound{Key: jkey(userID, key)}
}

type fakeRuns struct {
	byID                map[string]*job.PipelineRun
	byIdem              map[string]*job.PipelineRun
	order               []*job.PipelineRun
	nextID              int
	startErr            error
	startAfterCreateErr error
}

func newFakeRuns() *fakeRuns {
	return &fakeRuns{byID: map[string]*job.PipelineRun{}, byIdem: map[string]*job.PipelineRun{}}
}

// seedRun inserts a run directly (bypassing StartPipeline) so list tests can set
// an explicit UserID/CreatedBy.
func (f *fakeRuns) seedRun(r *job.PipelineRun) {
	f.byID[r.RunID] = r
	f.order = append(f.order, r)
}

func (f *fakeRuns) StartPipeline(_ context.Context, name, userID, createdBy, idem, inputJSON string) (string, error) {
	return f.startPipeline(name, userID, createdBy, idem, inputJSON, "")
}

func (f *fakeRuns) StartPipelineWithID(_ context.Context, runID, name, userID, createdBy, idem, inputJSON string) (string, error) {
	return f.startPipeline(name, userID, createdBy, idem, inputJSON, runID)
}

func (f *fakeRuns) startPipeline(name, userID, createdBy, idem, inputJSON, runID string) (string, error) {
	if f.startErr != nil {
		return "", f.startErr
	}
	if idem != "" {
		if _, ok := f.byIdem[jkey(userID, idem)]; ok {
			return "", job.ErrConflict
		}
	}
	f.nextID++
	id := runID
	if id == "" {
		id = "run-" + string(rune('a'+f.nextID))
	}
	r := &job.PipelineRun{RunID: id, UserID: userID, CreatedBy: createdBy, Name: name, InputJSON: inputJSON, Status: job.StatusRunning, IdempotencyKey: idem}
	f.byID[id] = r
	f.order = append(f.order, r)
	if idem != "" {
		f.byIdem[jkey(userID, idem)] = r
	}
	if f.startAfterCreateErr != nil {
		if _, ok := f.startAfterCreateErr.(*job.PublishFailedError); ok {
			r.Status = job.StatusFailed
		}
		return id, f.startAfterCreateErr
	}
	return id, nil
}

func (f *fakeRuns) Get(_ context.Context, id string) (*job.PipelineRun, error) {
	if r, ok := f.byID[id]; ok {
		return r, nil
	}
	return nil, &job.ErrNotFound{Key: id}
}

// PipelineRunsByUser returns the seeded runs whose UserID matches, in insertion
// order (deterministic for tests via the recorded order slice).
func (f *fakeRuns) PipelineRunsByUser(_ context.Context, userID string) ([]*job.PipelineRun, error) {
	out := []*job.PipelineRun{}
	for _, r := range f.order {
		if r.UserID == userID {
			out = append(out, r)
		}
	}
	return out, nil
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
		Enqueuer:                jobs,
		Jobs:                    jobs,
		JobsIdem:                jobs,
		Pipelines:               runs,
		Runs:                    runs,
		RunsList:                runs,
		RunsIdem:                runs,
		JobUserInitiable:        map[string]bool{"hello": false, "watch_sync": true},
		PipelineUserInitiable:   map[string]bool{"onboarding": true, "internal_only": false},
		WatchSyncJobType:        "watch_sync",
		SyncPipelineFull:        "onboarding",
		SyncPipelineIncremental: "data_sync",
		Auth:                    NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
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

func TestOnboardingReadiness_AdvertisesAtomicWebContract(t *testing.T) {
	h := newHarness(t)
	w := h.do(http.MethodGet, "/readyz/onboarding", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var got onboardingReadinessResponse
	mustJSON(t, w, &got)
	if got.ContractVersion != onboardingContractVersion {
		t.Errorf("contract_version = %q, want %q", got.ContractVersion, onboardingContractVersion)
	}
	if len(got.Routes) != len(onboardingWebRouteContracts) {
		t.Fatalf("route count = %d, want %d", len(got.Routes), len(onboardingWebRouteContracts))
	}
	for i, want := range onboardingWebRouteContracts {
		if got.Routes[i] != want {
			t.Errorf("route %d = %+v, want %+v", i, got.Routes[i], want)
		}
	}

	// The public declaration must track real authenticated registrations. These
	// requests stop at auth middleware, so they cannot mutate user state.
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/users/me/profile"},
		{http.MethodPost, "/api/users/me/profile"},
		{http.MethodPatch, "/api/users/me/profile"},
		{http.MethodGet, "/api/users/me/injuries"},
		{http.MethodPost, "/api/users/me/injuries"},
		{http.MethodPut, "/api/users/me/injuries/contract-probe-injury"},
		{http.MethodDelete, "/api/users/me/injuries/contract-probe-injury"},
		{http.MethodPost, "/api/users/me/watch/login"},
		{http.MethodPost, "/api/contract-probe-user/sync"},
		{http.MethodGet, "/api/pipelines/contract-probe-run"},
		{http.MethodGet, "/api/jobs/contract-probe-job"},
		{http.MethodPost, "/api/users/me/onboarding/complete"},
	} {
		response := h.do(route.method, route.path, "", nil)
		if response.Code != http.StatusUnauthorized {
			t.Errorf("%s %s = %d, want 401", route.method, route.path, response.Code)
		}
	}
}

func TestPlanSetupReadiness_AdvertisesReaderContract(t *testing.T) {
	h := newHarness(t)
	w := h.do(http.MethodGet, "/readyz/plan-setup", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var got planSetupReadinessResponse
	mustJSON(t, w, &got)
	if got.ContractVersion != planSetupContractVersion || got.ReaderContractVersion != seasonPlanReaderVersion {
		t.Fatalf("readiness = %+v", got)
	}
	if len(got.Routes) != len(planSetupRouteContracts) {
		t.Fatalf("route count = %d, want %d", len(got.Routes), len(planSetupRouteContracts))
	}
	for i, want := range planSetupRouteContracts {
		if got.Routes[i] != want {
			t.Errorf("route %d = %+v, want %+v", i, got.Routes[i], want)
		}
	}
}

func TestCreateJob_Unauthorized(t *testing.T) {
	h := newHarness(t)
	w := h.do(http.MethodPost, "/jobs", `{"type":"hello"}`, nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", w.Code)
	}
}

func TestCreateJob_Internal_AnyTypeSystemJob(t *testing.T) {
	h := newHarness(t)
	w := h.do(http.MethodPost, "/jobs", `{"type":"hello"}`, internalHdr())
	if w.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202: %s", w.Code, w.Body.String())
	}
	var resp enqueueJobResponse
	mustJSON(t, w, &resp)
	if resp.JobID == "" {
		t.Fatalf("resp = %+v", resp)
	}
	// A system (internal, no user_id) job carries an empty subject.
	j, err := h.jobs.Get(context.Background(), resp.JobID)
	if err != nil || j.UserID != "" {
		t.Fatalf("system job user_id = %q (err %v), want empty", j.UserID, err)
	}
}

func TestCreateJob_User_DerivesUserFromSub(t *testing.T) {
	h := newHarness(t)
	tok := h.userToken(t, "user-123")
	// A client-supplied user_id must be ignored for the user tier.
	w := h.do(http.MethodPost, "/jobs", `{"type":"watch_sync","user_id":"someone-else"}`,
		map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202: %s", w.Code, w.Body.String())
	}
	var resp enqueueJobResponse
	mustJSON(t, w, &resp)
	j, err := h.jobs.Get(context.Background(), resp.JobID)
	if err != nil || j.UserID != "user-123" {
		t.Fatalf("subject = %q (err %v), want user-123", j.UserID, err)
	}
	if j.CreatedBy != "user-123" {
		t.Fatalf("created_by = %q, want user-123", j.CreatedBy)
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

func TestGetJob_UserScoping(t *testing.T) {
	h := newHarness(t)
	// Seed a job owned by user-123.
	id, _ := h.jobs.Enqueue(context.Background(), job.EnqueueSpec{Type: "watch_sync", UserID: "user-123"})
	tok := h.userToken(t, "user-123")

	ok := h.do(http.MethodGet, "/jobs/"+id, "", map[string]string{"Authorization": "Bearer " + tok})
	if ok.Code != http.StatusOK {
		t.Fatalf("own get code = %d, want 200: %s", ok.Code, ok.Body.String())
	}

	// Another user must not see it exists — 404, not 403.
	otherTok := h.userToken(t, "other-user")
	notMine := h.do(http.MethodGet, "/jobs/"+id, "", map[string]string{"Authorization": "Bearer " + otherTok})
	if notMine.Code != http.StatusNotFound {
		t.Fatalf("cross-user code = %d, want 404", notMine.Code)
	}

	missing := h.do(http.MethodGet, "/jobs/nope", "", map[string]string{"Authorization": "Bearer " + tok})
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing code = %d, want 404", missing.Code)
	}

	alias := h.do(http.MethodGet, "/api/jobs/"+id, "", map[string]string{"Authorization": "Bearer " + tok})
	if alias.Code != http.StatusOK {
		t.Fatalf("API alias code = %d, want 200: %s", alias.Code, alias.Body.String())
	}
}

func TestStartPipeline_UserInitiableAndUnknown(t *testing.T) {
	h := newHarness(t)
	tok := h.userToken(t, "user-9")

	ok := h.do(http.MethodPost, "/pipelines", `{"name":"onboarding"}`, map[string]string{"Authorization": "Bearer " + tok})
	if ok.Code != http.StatusAccepted {
		t.Fatalf("start code = %d, want 202: %s", ok.Code, ok.Body.String())
	}
	var resp startPipelineResponse
	mustJSON(t, ok, &resp)
	if resp.RunID == "" || resp.PipelineName != "onboarding" {
		t.Fatalf("resp = %+v", resp)
	}
	// Subject and creator are both the JWT sub for a user-started run.
	run, err := h.runs.Get(context.Background(), resp.RunID)
	if err != nil || run.UserID != "user-9" || run.CreatedBy != "user-9" {
		t.Fatalf("run subject/creator = %q/%q (err %v), want user-9/user-9", run.UserID, run.CreatedBy, err)
	}

	unknown := h.do(http.MethodPost, "/pipelines", `{"name":"does-not-exist"}`, map[string]string{"Authorization": "Bearer " + tok})
	if unknown.Code != http.StatusBadRequest {
		t.Fatalf("unknown code = %d, want 400", unknown.Code)
	}

	// A missing name (empty body or body without name) is a 400.
	for _, missingBody := range []string{"", `{}`, `{"user_id":"user-9"}`} {
		missing := h.do(http.MethodPost, "/pipelines", missingBody, map[string]string{"Authorization": "Bearer " + tok})
		if missing.Code != http.StatusBadRequest {
			t.Fatalf("missing-name body %q code = %d, want 400", missingBody, missing.Code)
		}
	}

	// A malformed (non-EOF) body is a 400.
	malformed := h.do(http.MethodPost, "/pipelines", `{`, map[string]string{"Authorization": "Bearer " + tok})
	if malformed.Code != http.StatusBadRequest {
		t.Fatalf("malformed body code = %d, want 400", malformed.Code)
	}

	// A user may not start an internal-only pipeline.
	forbidden := h.do(http.MethodPost, "/pipelines", `{"name":"internal_only"}`, map[string]string{"Authorization": "Bearer " + tok})
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("internal-only code = %d, want 403", forbidden.Code)
	}
}

func TestListUserPipelines_Unauthorized(t *testing.T) {
	h := newHarness(t)
	w := h.do(http.MethodGet, "/api/users/user-a/pipelines", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", w.Code)
	}
}

func TestGetPipelineRun_APIAlias(t *testing.T) {
	h := newHarness(t)
	h.runs.seedRun(&job.PipelineRun{RunID: "r1", UserID: "user-a", Name: "data_sync", Status: job.StatusRunning})
	tok := h.userToken(t, "user-a")

	w := h.do(http.MethodGet, "/api/pipelines/r1", "", map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp runStateResponse
	mustJSON(t, w, &resp)
	if resp.RunID != "r1" || resp.PipelineName != "data_sync" || resp.Status != string(job.StatusRunning) {
		t.Fatalf("response = %+v", resp)
	}
}

func TestListUserPipelines_UserScoping(t *testing.T) {
	h := newHarness(t)
	// Two runs for user-a, one for user-b (keyed by subject user_id).
	h.runs.seedRun(&job.PipelineRun{RunID: "r1", UserID: "user-a", Name: "onboarding", Status: job.StatusRunning})
	h.runs.seedRun(&job.PipelineRun{RunID: "r2", UserID: "user-a", Name: "onboarding", Status: job.StatusDone})
	h.runs.seedRun(&job.PipelineRun{RunID: "r3", UserID: "user-b", Name: "onboarding", Status: job.StatusRunning})

	tok := h.userToken(t, "user-a")

	// A user sees exactly their own runs.
	own := h.do(http.MethodGet, "/api/users/user-a/pipelines", "", map[string]string{"Authorization": "Bearer " + tok})
	if own.Code != http.StatusOK {
		t.Fatalf("own list code = %d, want 200: %s", own.Code, own.Body.String())
	}
	var resp userPipelinesResponse
	mustJSON(t, own, &resp)
	if len(resp.Pipelines) != 2 {
		t.Fatalf("got %d runs, want 2: %+v", len(resp.Pipelines), resp.Pipelines)
	}
	for _, p := range resp.Pipelines {
		if p.UserID != "user-a" {
			t.Fatalf("leaked a run belonging to %q", p.UserID)
		}
	}

	// A user may not list another user's runs.
	cross := h.do(http.MethodGet, "/api/users/user-b/pipelines", "", map[string]string{"Authorization": "Bearer " + tok})
	if cross.Code != http.StatusForbidden {
		t.Fatalf("cross-user code = %d, want 403", cross.Code)
	}
}

func TestListUserPipelines_InternalListsAnyUser(t *testing.T) {
	h := newHarness(t)
	h.runs.seedRun(&job.PipelineRun{RunID: "r1", UserID: "user-a", CreatedBy: "user-a", Name: "onboarding", Status: job.StatusRunning})
	h.runs.seedRun(&job.PipelineRun{RunID: "r2", UserID: "user-b", CreatedBy: "", Name: "onboarding", Status: job.StatusRunning})

	// An internal caller may list any user.
	anyUser := h.do(http.MethodGet, "/api/users/user-a/pipelines", "", internalHdr())
	if anyUser.Code != http.StatusOK {
		t.Fatalf("internal list code = %d, want 200: %s", anyUser.Code, anyUser.Body.String())
	}
	var a userPipelinesResponse
	mustJSON(t, anyUser, &a)
	if len(a.Pipelines) != 1 || a.Pipelines[0].UserID != "user-a" {
		t.Fatalf("internal list of user-a = %+v", a.Pipelines)
	}

	// A run internal-triggered for a subject is listed under that subject.
	subjectRuns := h.do(http.MethodGet, "/api/users/user-b/pipelines", "", internalHdr())
	if subjectRuns.Code != http.StatusOK {
		t.Fatalf("subject list code = %d, want 200", subjectRuns.Code)
	}
	var b userPipelinesResponse
	mustJSON(t, subjectRuns, &b)
	if len(b.Pipelines) != 1 || b.Pipelines[0].UserID != "user-b" {
		t.Fatalf("subject list = %+v", b.Pipelines)
	}
}

func TestStartPipeline_RecordsIdentities(t *testing.T) {
	h := newHarness(t)
	tok := h.userToken(t, "user-7")

	// User-triggered start records user_id == created_by == sub, listed under the user.
	start := h.do(http.MethodPost, "/pipelines", `{"name":"onboarding"}`, map[string]string{"Authorization": "Bearer " + tok})
	if start.Code != http.StatusAccepted {
		t.Fatalf("start code = %d, want 202: %s", start.Code, start.Body.String())
	}
	list := h.do(http.MethodGet, "/api/users/user-7/pipelines", "", map[string]string{"Authorization": "Bearer " + tok})
	var resp userPipelinesResponse
	mustJSON(t, list, &resp)
	if len(resp.Pipelines) != 1 || resp.Pipelines[0].UserID != "user-7" || resp.Pipelines[0].CreatedBy != "user-7" {
		t.Fatalf("user-triggered run not recorded under sub: %+v", resp.Pipelines)
	}

	// Internal-triggered start for a subject: user_id is the subject, created_by empty.
	internalStart := h.do(http.MethodPost, "/pipelines", `{"name":"onboarding","user_id":"user-x"}`, internalHdr())
	if internalStart.Code != http.StatusAccepted {
		t.Fatalf("internal start code = %d, want 202: %s", internalStart.Code, internalStart.Body.String())
	}
	var isr startPipelineResponse
	mustJSON(t, internalStart, &isr)
	run, err := h.runs.Get(context.Background(), isr.RunID)
	if err != nil || run.UserID != "user-x" || run.CreatedBy != "" {
		t.Fatalf("internal run subject/creator = %q/%q (err %v), want user-x/empty", run.UserID, run.CreatedBy, err)
	}
	internalList := h.do(http.MethodGet, "/api/users/user-x/pipelines", "", internalHdr())
	var iresp userPipelinesResponse
	mustJSON(t, internalList, &iresp)
	if len(iresp.Pipelines) != 1 || iresp.Pipelines[0].UserID != "user-x" {
		t.Fatalf("internal-triggered run not under subject: %+v", iresp.Pipelines)
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

func TestHealth_ReflectsChecks(t *testing.T) {
	svc := NewService(Config{
		Auth: NewAuthenticator("t", nil),
		Health: map[string]health.Check{
			"mysql":  func(context.Context) error { return nil },
			"broker": func(context.Context) error { return errors.New("down") },
		},
	})
	w := httptest.NewRecorder()
	svc.Router().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503 (a check is failing)", w.Code)
	}
}

// TestCORSPreflight_AllowsBrowserMethods guards the direct-browser tier (ADR
// 0017): every method the routing manifest can send from the browser must be
// advertised in the preflight Access-Control-Allow-Methods, or the fetch is
// blocked by CORS before it leaves the page. Regression: DELETE /api/users/me/watch
// was blocked because the middleware only listed GET, POST, OPTIONS.
func TestCORSPreflight_AllowsBrowserMethods(t *testing.T) {
	const origin = "https://stride-running.cn"
	svc := NewService(Config{
		Auth:        NewAuthenticator("t", nil),
		CORSOrigins: []string{origin},
	})

	for _, reqMethod := range []string{
		http.MethodGet,
		http.MethodPost,
		http.MethodPut,
		http.MethodPatch,
		http.MethodDelete,
	} {
		r := httptest.NewRequest(http.MethodOptions, "/api/users/me/watch", nil)
		r.Header.Set("Origin", origin)
		r.Header.Set("Access-Control-Request-Method", reqMethod)
		w := httptest.NewRecorder()
		svc.Router().ServeHTTP(w, r)

		if w.Code != http.StatusNoContent {
			t.Fatalf("preflight (%s) code = %d, want 204", reqMethod, w.Code)
		}
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != origin {
			t.Fatalf("preflight (%s) allow-origin = %q, want %q", reqMethod, got, origin)
		}
		allow := w.Header().Get("Access-Control-Allow-Methods")
		if !strings.Contains(allow, reqMethod) {
			t.Fatalf("preflight allow-methods = %q, missing %s", allow, reqMethod)
		}
	}
}
