package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

func testTime() time.Time { return time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC) }

type fakeInjuryStore struct {
	created *storage.InjuryRecord
	items   []*storage.InjuryRecord
}

func (f *fakeInjuryStore) ListInjuries(_ context.Context, _ string, _ string, _ int) (*storage.InjuryPage, error) {
	return &storage.InjuryPage{Items: f.items}, nil
}
func (f *fakeInjuryStore) CreateInjury(_ context.Context, row *storage.InjuryRecord) (*storage.InjuryRecord, error) {
	row.ID = "11111111-1111-4111-8111-111111111111"
	row.CreatedAt, row.UpdatedAt = testTime(), testTime()
	f.created = row
	return row, nil
}
func (f *fakeInjuryStore) UpdateInjury(_ context.Context, _ string, id, description, status, restriction string) (*storage.InjuryRecord, error) {
	return &storage.InjuryRecord{ID: id, Description: description, RecoveryStatus: status, RunningRestriction: restriction, CreatedAt: testTime(), UpdatedAt: testTime()}, nil
}
func (f *fakeInjuryStore) DeleteInjury(_ context.Context, _, _ string) error { return nil }

func TestCreateInjury_RoutesAndTrimsThroughStore(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	injuries := &fakeInjuryStore{}
	h.svc.users.injuries = injuries
	w := h.do(http.MethodPost, "/api/users/me/injuries", `{"description":"knee","recovery_status":"active","running_restriction":"easy_only"}`, h.bearer(t, testSub))
	if w.Code != http.StatusCreated {
		t.Fatalf("code = %d, want 201: %s", w.Code, w.Body.String())
	}
	var got injuryResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.ID == "" || injuries.created == nil {
		t.Fatalf("response/store = %+v/%+v", got, injuries.created)
	}
}

func TestInjuryRoutesRequireUserTier(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.svc.users.injuries = &fakeInjuryStore{}
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
		path := "/api/users/me/injuries"
		if method == http.MethodPut || method == http.MethodDelete {
			path += "/11111111-1111-4111-8111-111111111111"
		}
		if w := h.do(method, path, `{}`, nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s code = %d, want 401", method, w.Code)
		}
	}
}
