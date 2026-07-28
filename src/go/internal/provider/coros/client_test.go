package coros

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
)

func TestHashPassword(t *testing.T) {
	// Reference MD5("password").
	if got := HashPassword("password"); got != "5f4dcc3b5aa765d61d8327deb882cf99" {
		t.Errorf("HashPassword(password) = %q", got)
	}
}

// testServer returns success for the given data payload, with the standard
// COROS envelope.
func writeEnvelope(w http.ResponseWriter, code, data string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"result":"` + code + `","data":` + data + `}`))
}

func testClient(t *testing.T, h http.Handler, creds Credentials, saver CredentialSaver) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	bases := map[string]string{"global": srv.URL, "cn": srv.URL, "eu": srv.URL}
	return NewClient(creds,
		WithBases(bases),
		WithHTTPClient(srv.Client()),
		WithRequestDelay(0),
		WithCredentialSaver(saver),
	)
}

func TestLogin(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/account/login", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{"accessToken":"tok-abc","userId":987654321}`)
	})
	mux.HandleFunc("/account/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{}`)
	})

	var saved Credentials
	var savedCalled bool
	c := testClient(t, mux, Credentials{}, func(cr Credentials) error {
		saved, savedCalled = cr, true
		return nil
	})

	creds, err := c.Login(context.Background(), "a@b.com", "password")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if creds.AccessToken != "tok-abc" {
		t.Errorf("token = %q, want tok-abc", creds.AccessToken)
	}
	if creds.UserID != "987654321" {
		t.Errorf("userId = %q, want 987654321 (numeric coerced to string)", creds.UserID)
	}
	if creds.PwdHash != HashPassword("password") {
		t.Errorf("pwd_hash not stored")
	}
	if creds.Region == "" {
		t.Errorf("region not detected")
	}
	if !savedCalled || saved.AccessToken != "tok-abc" {
		t.Errorf("CredentialSaver not called with fresh creds")
	}
}

func TestRequestRefreshOnExpiry(t *testing.T) {
	const freshToken = "fresh-token"
	var loginCount int32
	mux := http.NewServeMux()
	mux.HandleFunc("/account/login", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&loginCount, 1)
		writeEnvelope(w, resultSuccess, `{"accessToken":"`+freshToken+`"}`)
	})
	mux.HandleFunc("/activity/query", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("accesstoken") == freshToken {
			writeEnvelope(w, resultSuccess, `{"dataList":[]}`)
			return
		}
		writeEnvelope(w, resultTokenExpired, `{}`)
	})

	c := testClient(t, mux,
		Credentials{Email: "a@b.com", PwdHash: "h", AccessToken: "stale", Region: "global", UserID: "1"},
		func(Credentials) error { return nil })

	data, err := c.ListActivities(context.Background(), 1, 20)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if string(data) != `{"dataList":[]}` {
		t.Errorf("data = %s", data)
	}
	if n := atomic.LoadInt32(&loginCount); n != 1 {
		t.Errorf("re-login count = %d, want 1", n)
	}
	if tok, _ := c.currentToken(); tok != freshToken {
		t.Errorf("token not refreshed, got %q", tok)
	}
}

func TestConcurrentRefreshReLoginsOnce(t *testing.T) {
	const freshToken = "fresh-token"
	var loginCount int32
	mux := http.NewServeMux()
	mux.HandleFunc("/account/login", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&loginCount, 1)
		writeEnvelope(w, resultSuccess, `{"accessToken":"`+freshToken+`"}`)
	})
	mux.HandleFunc("/activity/query", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("accesstoken") == freshToken {
			writeEnvelope(w, resultSuccess, `{"dataList":[]}`)
			return
		}
		writeEnvelope(w, resultTokenExpired, `{}`)
	})

	c := testClient(t, mux,
		Credentials{Email: "a@b.com", PwdHash: "h", AccessToken: "stale", Region: "global", UserID: "1"},
		func(Credentials) error { return nil })

	const workers = 16
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.ListActivities(context.Background(), 1, 20); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent list: %v", err)
	}
	// The single-token barrier must collapse N concurrent expiries into 1 re-login.
	if n := atomic.LoadInt32(&loginCount); n != 1 {
		t.Errorf("re-login count = %d, want 1 (barrier failed)", n)
	}
}

func TestRequestNotLoggedIn(t *testing.T) {
	c := NewClient(Credentials{}, WithRequestDelay(0))
	if _, err := c.ListActivities(context.Background(), 1, 20); err == nil {
		t.Fatal("expected auth error when no token")
	}
}

func TestAPIErrorSurfaced(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/dashboard/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, "9999", `{}`)
	})
	c := testClient(t, mux,
		Credentials{AccessToken: "tok", Region: "global"}, func(Credentials) error { return nil })
	_, err := c.GetDashboard(context.Background())
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Code != "9999" {
		t.Fatalf("expected *APIError{9999}, got %v", err)
	}
}
