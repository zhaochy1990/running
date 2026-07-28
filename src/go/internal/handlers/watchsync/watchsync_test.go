package watchsync

import (
	"context"
	"errors"
	"testing"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/provider"
)

// fakeProvider implements the minimal Provider the handler needs.
type fakeProvider struct {
	loggedIn   bool
	loginErr   error
	syncErr    error
	result     provider.SyncResult
	gotUser    string
	gotOpts    provider.SyncOptions
	emit       []provider.SyncProgress // progress events to replay through opts.Progress
	syncCalled bool
}

func (f *fakeProvider) IsLoggedIn(user string) (bool, error) {
	return f.loggedIn, f.loginErr
}

func (f *fakeProvider) SyncUser(_ context.Context, user string, opts provider.SyncOptions) (provider.SyncResult, error) {
	f.syncCalled = true
	f.gotUser = user
	f.gotOpts = opts
	for _, e := range f.emit {
		if opts.Progress != nil {
			opts.Progress(e)
		}
	}
	return f.result, f.syncErr
}

func run(t *testing.T, f *fakeProvider, input string) (string, error, []string, []int) {
	t.Helper()
	h := New(f)
	var stages []string
	var pcts []int
	hb := func(stage string, pct int) error {
		stages = append(stages, stage)
		pcts = append(pcts, pct)
		return nil
	}
	res, err := h(context.Background(), &job.Job{PartitionKey: "u-123", InputJSON: input}, hb)
	return res, err, stages, pcts
}

func TestHandler_DefaultsToFullAll(t *testing.T) {
	f := &fakeProvider{loggedIn: true, result: provider.SyncResult{Activities: 3, Health: 2}}
	res, err, _, _ := run(t, f, "") // empty payload -> default full + all
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if f.gotUser != "u-123" {
		t.Errorf("user = %q, want u-123", f.gotUser)
	}
	if f.gotOpts.Mode != provider.SyncFull {
		t.Errorf("mode = %v, want full (default)", f.gotOpts.Mode)
	}
	if f.gotOpts.Content != provider.ContentAll {
		t.Errorf("content = %v, want all (default)", f.gotOpts.Content)
	}
	if res != `{"activities":3,"health":2,"mode":"full"}` {
		t.Errorf("result = %s", res)
	}
}

func TestHandler_ParsesPayload(t *testing.T) {
	f := &fakeProvider{loggedIn: true}
	_, err, _, _ := run(t, f, `{"mode":"incremental","content":"health","limit":50}`)
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if f.gotOpts.Mode != provider.SyncIncremental {
		t.Errorf("mode = %v, want incremental", f.gotOpts.Mode)
	}
	if f.gotOpts.Content != provider.ContentHealth {
		t.Errorf("content = %v, want health", f.gotOpts.Content)
	}
	if f.gotOpts.Limit != 50 {
		t.Errorf("limit = %d, want 50", f.gotOpts.Limit)
	}
}

func TestHandler_NotLoggedIn_Permanent(t *testing.T) {
	f := &fakeProvider{loggedIn: false}
	_, err, _, _ := run(t, f, "")
	pe, ok := job.AsPermanent(err)
	if !ok {
		t.Fatalf("want PermanentError, got %v", err)
	}
	if pe.Code != "not_logged_in" {
		t.Errorf("code = %q, want not_logged_in", pe.Code)
	}
	if f.syncCalled {
		t.Error("SyncUser must not run when not logged in")
	}
}

func TestHandler_AuthError_Permanent(t *testing.T) {
	f := &fakeProvider{loggedIn: true, syncErr: provider.ErrAuthRequired}
	_, err, _, _ := run(t, f, "")
	pe, ok := job.AsPermanent(err)
	if !ok {
		t.Fatalf("want PermanentError, got %v", err)
	}
	if pe.Code != "auth_failed" {
		t.Errorf("code = %q, want auth_failed", pe.Code)
	}
}

func TestHandler_TransientError_Retryable(t *testing.T) {
	f := &fakeProvider{loggedIn: true, syncErr: errors.New("connection reset")}
	_, err, _, _ := run(t, f, "")
	if err == nil {
		t.Fatal("want error")
	}
	if _, ok := job.AsPermanent(err); ok {
		t.Errorf("transient error must NOT be permanent: %v", err)
	}
}

func TestHandler_BadPayload_Permanent(t *testing.T) {
	f := &fakeProvider{loggedIn: true}
	_, err, _, _ := run(t, f, `{"mode":"sideways"}`)
	pe, ok := job.AsPermanent(err)
	if !ok {
		t.Fatalf("want PermanentError for bad payload, got %v", err)
	}
	if pe.Code != "bad_payload" {
		t.Errorf("code = %q, want bad_payload", pe.Code)
	}
	if f.syncCalled {
		t.Error("SyncUser must not run on bad payload")
	}
}

func TestHandler_BridgesProgressToHeartbeat(t *testing.T) {
	f := &fakeProvider{
		loggedIn: true,
		emit: []provider.SyncProgress{
			{"phase": "activities", "current": 5, "total": 10, "percent": 45},
			{"phase": "health", "current": 1, "total": 1, "percent": 95},
		},
	}
	_, err, stages, pcts := run(t, f, "")
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if len(stages) != 2 || stages[0] != "activities" || stages[1] != "health" {
		t.Fatalf("stages = %v", stages)
	}
	if len(pcts) != 2 || pcts[0] != 45 || pcts[1] != 95 {
		t.Fatalf("percents = %v", pcts)
	}
}
