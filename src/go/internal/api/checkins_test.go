package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

type fakeCheckInStore struct {
	result *storage.CheckInResult
	status *storage.CheckInStatus
	page   *storage.PointPage
	err    error
	calls  []string
	now    time.Time
	userID string
	cursor string
	limit  int
}

func (f *fakeCheckInStore) CreateCheckIn(_ context.Context, userID string, now time.Time) (*storage.CheckInResult, error) {
	f.calls = append(f.calls, "create")
	f.userID, f.now = userID, now
	if f.err != nil {
		return nil, f.err
	}
	return f.result, nil
}

func (f *fakeCheckInStore) GetCheckInStatus(_ context.Context, userID string, now time.Time) (*storage.CheckInStatus, error) {
	f.calls = append(f.calls, "status")
	f.userID, f.now = userID, now
	if f.err != nil {
		return nil, f.err
	}
	return f.status, nil
}

func (f *fakeCheckInStore) ListPointTransactions(_ context.Context, userID, cursor string, limit int) (*storage.PointPage, error) {
	f.calls = append(f.calls, "points")
	f.userID, f.cursor, f.limit = userID, cursor, limit
	if f.err != nil {
		return nil, f.err
	}
	return f.page, nil
}

func checkInHarness(t *testing.T, store CheckInStore) *userHarness {
	t.Helper()
	h := newUserHarness(t, FeatureConfig{})
	h.svc.users.checkins = store
	return h
}

func TestCreateCheckIn_RoutesThroughStore(t *testing.T) {
	store := &fakeCheckInStore{result: &storage.CheckInResult{
		StreakDays: 3, CyclePosition: 3, PointsEarned: 1, Balance: 3,
	}}
	h := checkInHarness(t, store)
	w := h.do(http.MethodPost, "/api/users/me/check-ins", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var got checkInResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.AlreadyCheckedIn || got.StreakDays != 3 || got.CyclePosition != 3 || got.PointsEarned != 1 || got.Balance != 3 || got.D7Completed {
		t.Fatalf("response = %+v", got)
	}
	if store.userID != testSub {
		t.Fatalf("store got user %q", store.userID)
	}
}

func TestCreateCheckIn_DuplicateShape(t *testing.T) {
	store := &fakeCheckInStore{result: &storage.CheckInResult{
		AlreadyCheckedIn: true, StreakDays: 7, CyclePosition: 7, PointsEarned: 0, Balance: 11, D7Completed: true,
	}}
	h := checkInHarness(t, store)
	w := h.do(http.MethodPost, "/api/users/me/check-ins", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (duplicate is never an error): %s", w.Code, w.Body.String())
	}
	var got checkInResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.AlreadyCheckedIn || got.PointsEarned != 0 || !got.D7Completed {
		t.Fatalf("duplicate response = %+v", got)
	}
}

func TestGetCheckInStatus_Shape(t *testing.T) {
	store := &fakeCheckInStore{status: &storage.CheckInStatus{
		Date:       time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC),
		CanCheckIn: true, RewardPreview: 1, WouldStartNewCycle: false,
		StreakDays: 3,
		Cycle: []storage.CheckInCycleCell{
			{Position: 1, Points: 1, Status: "checked"},
			{Position: 2, Points: 1, Status: "checked"},
			{Position: 3, Points: 1, Status: "checked"},
			{Position: 4, Points: 1, Status: "today"},
			{Position: 5, Points: 2, Status: "upcoming"},
			{Position: 6, Points: 2, Status: "upcoming"},
			{Position: 7, Points: 3, Status: "upcoming"},
		},
		Balance: 3, MonthLabel: "2026-11",
		MonthChecked: []storage.CheckInMonthEntry{
			{Date: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), Points: 1},
			{Date: time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC), Points: 1},
			{Date: time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC), Points: 1},
		},
	}}
	h := checkInHarness(t, store)
	w := h.do(http.MethodGet, "/api/users/me/check-ins/status", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	var got checkInStatusResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Today.Date != "2026-11-04" || !got.Today.CanCheckIn || got.Today.RewardPreview != 1 || got.Today.WouldStartNewCycle {
		t.Fatalf("today block = %+v", got.Today)
	}
	if got.StreakDays != 3 || len(got.Cycle) != 7 {
		t.Fatalf("streak/cycle = %d/%d", got.StreakDays, len(got.Cycle))
	}
	if got.Cycle[3].Status != "today" || got.Cycle[4].Status != "upcoming" {
		t.Fatalf("cycle cells = %+v", got.Cycle)
	}
	if got.Month.Label != "2026-11" || len(got.Month.Checked) != 3 || got.Month.Checked[0].Date != "2026-11-01" || got.Month.Checked[2].Points != 1 {
		t.Fatalf("month block = %+v", got.Month)
	}
	if got.Balance != 3 {
		t.Fatalf("balance = %d", got.Balance)
	}
}

func TestListPoints_ShapeAndParams(t *testing.T) {
	store := &fakeCheckInStore{page: &storage.PointPage{
		Items: []*storage.PointTransaction{
			{ID: "20000000-0000-4000-8000-000000000001", Type: storage.PointTypeEarnCheckin, Amount: 1, Ref: "ref-1",
				CreatedAt: time.Date(2026, 11, 3, 1, 0, 0, 0, time.UTC)},
			{ID: "10000000-0000-4000-8000-000000000002", Type: storage.PointTypeEarnCheckin, Amount: 2, Ref: "ref-2",
				CreatedAt: time.Date(2026, 11, 2, 1, 0, 0, 0, time.UTC)},
		},
		Balance:    3,
		NextCursor: "page-2",
	}}
	h := checkInHarness(t, store)
	w := h.do(http.MethodGet, "/api/users/me/points?limit=2&cursor=page-1", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	var got pointsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Balance != 3 || len(got.Transactions) != 2 || got.NextCursor == nil || *got.NextCursor != "page-2" {
		t.Fatalf("points response = %+v", got)
	}
	if got.Transactions[0].ID == "" || got.Transactions[0].Type != "earn_checkin" || got.Transactions[0].CreatedAt == "" {
		t.Fatalf("transaction row = %+v", got.Transactions[0])
	}
	if store.cursor != "page-1" || store.limit != 2 {
		t.Fatalf("store params cursor=%q limit=%d", store.cursor, store.limit)
	}
}

func TestCheckInRoutes_ValidationAndErrors(t *testing.T) {
	// No store wired → 503.
	h := checkInHarness(t, nil)
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/users/me/check-ins"},
		{http.MethodGet, "/api/users/me/check-ins/status"},
		{http.MethodGet, "/api/users/me/points"},
	} {
		if w := h.do(tc.method, tc.path, "", h.bearer(t, testSub)); w.Code != http.StatusServiceUnavailable {
			t.Errorf("%s %s without store: code = %d, want 503", tc.method, tc.path, w.Code)
		}
	}

	store := &fakeCheckInStore{}
	h = checkInHarness(t, store)
	// All three endpoints demand the user tier.
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/users/me/check-ins"},
		{http.MethodGet, "/api/users/me/check-ins/status"},
		{http.MethodGet, "/api/users/me/points"},
	} {
		if w := h.do(tc.method, tc.path, "", nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s anonymous: code = %d, want 401", tc.method, tc.path, w.Code)
		}
	}

	// Bad limit → 422.
	if w := h.do(http.MethodGet, "/api/users/me/points?limit=abc", "", h.bearer(t, testSub)); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad limit: code = %d, want 422", w.Code)
	}
	// Bad cursor → 422.
	store.err = &storage.PointCursorError{Message: "invalid points cursor"}
	if w := h.do(http.MethodGet, "/api/users/me/points?cursor=bad", "", h.bearer(t, testSub)); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad cursor: code = %d, want 422", w.Code)
	}
	// Over-limit page size surfaces as 422, same as the injuries list.
	store.err = &storage.PointValidationError{Message: "limit must be between 1 and 50"}
	if w := h.do(http.MethodGet, "/api/users/me/points?limit=999", "", h.bearer(t, testSub)); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("store limit error: code = %d, want 422", w.Code)
	}
}
