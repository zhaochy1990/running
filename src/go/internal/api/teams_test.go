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

	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/authsvc"
	"github.com/zhaochy1990/stride/internal/storage"
)

const (
	teamUserA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	teamUserB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	teamUserC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
)

type fakeTeamAuth struct {
	teams      []authsvc.Team
	team       *authsvc.Team
	membership *authsvc.Membership
	status     *authsvc.StatusResponse
	members    []authsvc.Member
	myTeams    []authsvc.MyTeam

	listTeamsErr error
	createErr    error
	getErr       error
	joinErr      error
	leaveErr     error
	transferErr  error
	deleteErr    error
	membersErr   error
	myTeamsErr   error

	authorizations  []string
	memberCalls     int
	lastTeamID      string
	lastName        string
	lastDescription *string
	lastNewOwner    string
}

func (f *fakeTeamAuth) record(auth, teamID string) {
	f.authorizations = append(f.authorizations, auth)
	f.lastTeamID = teamID
}
func (f *fakeTeamAuth) ListTeams(_ context.Context, auth string) ([]authsvc.Team, error) {
	f.record(auth, "")
	return f.teams, f.listTeamsErr
}
func (f *fakeTeamAuth) CreateTeam(_ context.Context, auth, name string, description *string) (*authsvc.Team, error) {
	f.record(auth, "")
	f.lastName, f.lastDescription = name, description
	return f.team, f.createErr
}
func (f *fakeTeamAuth) GetTeam(_ context.Context, auth, teamID string) (*authsvc.Team, error) {
	f.record(auth, teamID)
	return f.team, f.getErr
}
func (f *fakeTeamAuth) JoinTeam(_ context.Context, auth, teamID string) (*authsvc.Membership, error) {
	f.record(auth, teamID)
	return f.membership, f.joinErr
}
func (f *fakeTeamAuth) LeaveTeam(_ context.Context, auth, teamID string) (*authsvc.StatusResponse, error) {
	f.record(auth, teamID)
	return f.status, f.leaveErr
}
func (f *fakeTeamAuth) TransferTeamOwner(_ context.Context, auth, teamID, owner string) (*authsvc.Team, error) {
	f.record(auth, teamID)
	f.lastNewOwner = owner
	return f.team, f.transferErr
}
func (f *fakeTeamAuth) DeleteTeam(_ context.Context, auth, teamID string) error {
	f.record(auth, teamID)
	return f.deleteErr
}
func (f *fakeTeamAuth) ListMembers(_ context.Context, auth, teamID string) ([]authsvc.Member, error) {
	f.record(auth, teamID)
	f.memberCalls++
	return f.members, f.membersErr
}
func (f *fakeTeamAuth) ListMyTeams(_ context.Context, auth string) ([]authsvc.MyTeam, error) {
	f.record(auth, "")
	return f.myTeams, f.myTeamsErr
}

type fakeTeamStore struct {
	feed             []storage.Activity
	feedErr          error
	mileage          *storage.TeamMileageResult
	mileageErr       error
	profiles         map[string]storage.UserProfile
	profilesErr      error
	likes            map[storage.TeamActivityKey][]storage.TeamLike
	likesErr         error
	activityLikes    []storage.TeamLike
	activityLikesErr error
	putErr           error
	deleteErr        error

	feedCalls         int
	bulkLikeCalls     int
	profileCalls      int
	putCalls          int
	deleteCalls       int
	activityLikeCalls int
	feedIDs           []string
	feedDays          int
	feedLimit         int
	feedNow           time.Time
	bulkTeamID        string
	bulkTargets       []storage.TeamActivityKey
	mileageIDs        []string
	mileagePeriod     storage.TeamMileagePeriod
	mileageNow        time.Time
	putLike           *storage.TeamLike
	deleteArgs        []string
}

func (f *fakeTeamStore) TeamFeed(_ context.Context, ids []string, days, limit int, now time.Time) ([]storage.Activity, error) {
	f.feedCalls++
	f.feedIDs, f.feedDays, f.feedLimit, f.feedNow = append([]string{}, ids...), days, limit, now
	return f.feed, f.feedErr
}
func (f *fakeTeamStore) TeamMileage(_ context.Context, ids []string, period storage.TeamMileagePeriod, now time.Time) (*storage.TeamMileageResult, error) {
	f.mileageIDs, f.mileagePeriod, f.mileageNow = append([]string{}, ids...), period, now
	return f.mileage, f.mileageErr
}
func (f *fakeTeamStore) UserProfilesByIDs(_ context.Context, _ []string) (map[string]storage.UserProfile, error) {
	f.profileCalls++
	if f.profiles == nil {
		return map[string]storage.UserProfile{}, f.profilesErr
	}
	return f.profiles, f.profilesErr
}
func (f *fakeTeamStore) PutTeamLike(_ context.Context, like *storage.TeamLike) error {
	f.putCalls++
	copy := *like
	f.putLike = &copy
	if f.putErr == nil {
		key := storage.TeamActivityKey{OwnerUserID: like.OwnerUserID, LabelID: like.LabelID}
		f.activityLikes = upsertFakeLike(f.activityLikes, copy)
		if f.likes == nil {
			f.likes = map[storage.TeamActivityKey][]storage.TeamLike{}
		}
		f.likes[key] = append([]storage.TeamLike{}, f.activityLikes...)
	}
	return f.putErr
}
func (f *fakeTeamStore) DeleteTeamLike(_ context.Context, teamID, ownerID, labelID, likerID string) (bool, error) {
	f.deleteCalls++
	f.deleteArgs = []string{teamID, ownerID, labelID, likerID}
	deleted := false
	kept := f.activityLikes[:0]
	for _, like := range f.activityLikes {
		if like.LikerUserID == likerID {
			deleted = true
			continue
		}
		kept = append(kept, like)
	}
	f.activityLikes = kept
	return deleted, f.deleteErr
}
func (f *fakeTeamStore) TeamLikesForActivity(_ context.Context, _, _, _ string) ([]storage.TeamLike, error) {
	f.activityLikeCalls++
	return append([]storage.TeamLike{}, f.activityLikes...), f.activityLikesErr
}
func (f *fakeTeamStore) TeamLikesForActivities(_ context.Context, teamID string, targets []storage.TeamActivityKey) (map[storage.TeamActivityKey][]storage.TeamLike, error) {
	f.bulkLikeCalls++
	f.bulkTeamID = teamID
	f.bulkTargets = append([]storage.TeamActivityKey{}, targets...)
	if f.likes == nil {
		return map[storage.TeamActivityKey][]storage.TeamLike{}, f.likesErr
	}
	return f.likes, f.likesErr
}

func upsertFakeLike(rows []storage.TeamLike, like storage.TeamLike) []storage.TeamLike {
	for i := range rows {
		if rows[i].LikerUserID == like.LikerUserID {
			rows[i].LikerDisplayName = like.LikerDisplayName
			return rows
		}
	}
	if like.CreatedAt.IsZero() {
		like.CreatedAt = time.Date(2026, 8, 6, 1, 0, 0, 0, time.UTC)
	}
	return append(rows, like)
}

type teamHarness struct {
	svc        *Service
	auth       *fakeTeamAuth
	store      *fakeTeamStore
	activities *fakeActivityStore
	key        *rsa.PrivateKey
}

func newTeamHarness(t *testing.T) *teamHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	auth := &fakeTeamAuth{}
	store := &fakeTeamStore{}
	activities := &fakeActivityStore{}
	svc := NewService(Config{Auth: NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)), TeamAuth: auth, TeamStore: store, ActivityStore: activities})
	return &teamHarness{svc: svc, auth: auth, store: store, activities: activities, key: key}
}

func (h *teamHarness) token(t *testing.T, sub string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"sub": sub, "iss": testIssuer, "aud": testAudience, "exp": time.Now().Add(time.Hour).Unix()})
	s, err := tok.SignedString(h.key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return s
}

func (h *teamHarness) do(t *testing.T, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, req)
	return w
}

func (h *teamHarness) bearer(t *testing.T, userID string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + h.token(t, userID)}
}

func TestTeamRoutesRequireJWTUserTier(t *testing.T) {
	paths := []struct{ method, path string }{
		{http.MethodGet, "/api/teams"},
		{http.MethodPost, "/api/teams"},
		{http.MethodGet, "/api/teams/team-1"},
		{http.MethodDelete, "/api/teams/team-1"},
		{http.MethodPost, "/api/teams/team-1/join"},
		{http.MethodPost, "/api/teams/team-1/leave"},
		{http.MethodPost, "/api/teams/team-1/transfer-owner"},
		{http.MethodGet, "/api/teams/team-1/members"},
		{http.MethodGet, "/api/teams/team-1/feed"},
		{http.MethodGet, "/api/teams/team-1/mileage"},
		{http.MethodGet, "/api/teams/team-1/activities/" + teamUserB + "/run-1"},
		{http.MethodPost, "/api/teams/team-1/activities/" + teamUserB + "/run-1/likes"},
		{http.MethodDelete, "/api/teams/team-1/activities/" + teamUserB + "/run-1/likes"},
		{http.MethodGet, "/api/teams/team-1/activities/" + teamUserB + "/run-1/likes"},
		{http.MethodGet, "/api/users/me/teams"},
	}
	for _, tc := range paths {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			h := newTeamHarness(t)
			w := h.do(t, tc.method, tc.path, `{}`, internalHdr())
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("code = %d, body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestTeamProxyRoutesForwardOriginalAuthorizationAndPreserveContracts(t *testing.T) {
	t.Run("list and my teams fall back empty", func(t *testing.T) {
		h := newTeamHarness(t)
		h.auth.listTeamsErr = &authsvc.AuthServiceUnavailable{Detail: "down"}
		h.auth.myTeamsErr = &authsvc.AuthServiceUnavailable{Detail: "down"}
		header := h.bearer(t, teamUserA)
		for _, path := range []string{"/api/teams", "/api/users/me/teams"} {
			w := h.do(t, http.MethodGet, path, "", header)
			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"teams":[]`) {
				t.Fatalf("%s: code=%d body=%s", path, w.Code, w.Body.String())
			}
		}
		if len(h.auth.authorizations) != 2 || h.auth.authorizations[0] != header["Authorization"] {
			t.Fatalf("forwarded = %#v", h.auth.authorizations)
		}
	})

	t.Run("create validates and forwards", func(t *testing.T) {
		h := newTeamHarness(t)
		h.auth.team = &authsvc.Team{ID: "team-1", Name: "Fast"}
		header := h.bearer(t, teamUserA)
		w := h.do(t, http.MethodPost, "/api/teams", `{"name":"  Fast  ","description":"Runners"}`, header)
		if w.Code != http.StatusOK || h.auth.lastName != "Fast" || h.auth.lastDescription == nil || *h.auth.lastDescription != "Runners" {
			t.Fatalf("code=%d body=%s name=%q desc=%v", w.Code, w.Body.String(), h.auth.lastName, h.auth.lastDescription)
		}
		if h.auth.authorizations[0] != header["Authorization"] {
			t.Fatalf("authorization = %q", h.auth.authorizations[0])
		}
		for _, body := range []string{`{}`, `{"name":1}`, `{"name":"ok","description":4}`} {
			w = h.do(t, http.MethodPost, "/api/teams", body, header)
			if w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), `"detail"`) {
				t.Fatalf("body %s => %d %s", body, w.Code, w.Body.String())
			}
		}
	})

	t.Run("get 404 and mutation errors", func(t *testing.T) {
		h := newTeamHarness(t)
		h.auth.getErr = &authsvc.AuthServiceError{StatusCode: 404, Detail: "missing"}
		w := h.do(t, http.MethodGet, "/api/teams/team-1", "", h.bearer(t, teamUserA))
		if w.Code != 404 || w.Body.String() != `{"detail":"missing"}` {
			t.Fatalf("get = %d %s", w.Code, w.Body.String())
		}
		h.auth.joinErr = &authsvc.AuthServiceError{StatusCode: 409, Detail: "already joined"}
		w = h.do(t, http.MethodPost, "/api/teams/team-1/join", "", h.bearer(t, teamUserA))
		if w.Code != 409 || w.Body.String() != `{"detail":"already joined"}` {
			t.Fatalf("join = %d %s", w.Code, w.Body.String())
		}
		h.auth.joinErr = &authsvc.AuthServiceError{StatusCode: 422, Detail: map[string]any{"field": "name", "messages": []any{"required"}}}
		w = h.do(t, http.MethodPost, "/api/teams/team-1/join", "", h.bearer(t, teamUserA))
		if w.Code != 422 || w.Body.String() != `{"detail":{"field":"name","messages":["required"]}}` {
			t.Fatalf("structured join = %d %s", w.Code, w.Body.String())
		}
		h.auth.leaveErr = &authsvc.AuthServiceUnavailable{StatusCode: 502, Detail: "bad gateway"}
		w = h.do(t, http.MethodPost, "/api/teams/team-1/leave", "", h.bearer(t, teamUserA))
		if w.Code != 503 || !strings.Contains(w.Body.String(), `auth-service unavailable: auth-service 502: bad gateway`) {
			t.Fatalf("leave = %d %s", w.Code, w.Body.String())
		}
	})

	t.Run("join leave transfer delete success", func(t *testing.T) {
		h := newTeamHarness(t)
		h.auth.membership = &authsvc.Membership{TeamID: "team-1", UserID: teamUserA, Role: "member"}
		h.auth.status = &authsvc.StatusResponse{Status: "left"}
		h.auth.team = &authsvc.Team{ID: "team-1", OwnerUserID: teamUserB}
		header := h.bearer(t, teamUserA)
		cases := []struct{ method, path, body string }{
			{http.MethodPost, "/api/teams/team-1/join", ""},
			{http.MethodPost, "/api/teams/team-1/leave", ""},
			{http.MethodPost, "/api/teams/team-1/transfer-owner", `{"new_owner_user_id":"` + teamUserB + `"}`},
			{http.MethodDelete, "/api/teams/team-1", ""},
		}
		for _, tc := range cases {
			if w := h.do(t, tc.method, tc.path, tc.body, header); w.Code != 200 {
				t.Fatalf("%s %s => %d %s", tc.method, tc.path, w.Code, w.Body.String())
			}
		}
		if h.auth.lastNewOwner != teamUserB {
			t.Fatalf("owner = %q", h.auth.lastNewOwner)
		}
		if w := h.do(t, http.MethodPost, "/api/teams/team-1/transfer-owner", `{"new_owner_user_id":"bad"}`, header); w.Code != 422 {
			t.Fatalf("bad owner code = %d", w.Code)
		}
	})
}

func TestTeamMembersBatchNamePrecedence(t *testing.T) {
	h := newTeamHarness(t)
	authName, fallbackName := "Auth Display", "Auth Name"
	h.auth.members = []authsvc.Member{
		{UserID: teamUserA, DisplayName: &authName, Name: &fallbackName},
		{UserID: teamUserB, Name: &fallbackName},
		{UserID: teamUserC},
	}
	h.store.profiles = map[string]storage.UserProfile{teamUserA: {UserID: teamUserA, DisplayName: "Local Name"}}
	w := h.do(t, http.MethodGet, "/api/teams/team-1/members", "", h.bearer(t, teamUserA))
	if w.Code != 200 {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
	var resp membersResponse
	mustJSON(t, w, &resp)
	if h.store.profileCalls != 1 || *resp.Members[0].DisplayName != "Local Name" || *resp.Members[1].DisplayName != "Auth Name" || *resp.Members[2].DisplayName != teamUserC {
		t.Fatalf("members=%+v profile calls=%d", resp.Members, h.store.profileCalls)
	}

	h.auth.membersErr = &authsvc.AuthServiceUnavailable{Detail: "down"}
	w = h.do(t, http.MethodGet, "/api/teams/team-1/members", "", h.bearer(t, teamUserA))
	if w.Code != 200 || w.Body.String() != `{"members":[]}` {
		t.Fatalf("fallback=%d %s", w.Code, w.Body.String())
	}
}

func TestTeamFeedBatchesMySQLAndLikesWithShanghaiFormatting(t *testing.T) {
	h := newTeamHarness(t)
	h.auth.members = []authsvc.Member{{UserID: teamUserA}, {UserID: teamUserB}}
	h.store.profiles = map[string]storage.UserProfile{teamUserB: {UserID: teamUserB, DisplayName: "Runner B"}}
	distance, duration, pace := 12345.0, 3600.0, 300.0
	route := `{"points":[[1,2]]}`
	h.store.feed = []storage.Activity{{UserID: teamUserB, LabelID: "run-1", SportType: 100, Date: time.Date(2026, 8, 5, 17, 0, 0, 0, time.UTC), DistanceM: &distance, DurationS: &duration, AvgPaceSKm: &pace, RouteThumbJSON: &route}}
	key := storage.TeamActivityKey{OwnerUserID: teamUserB, LabelID: "run-1"}
	h.store.likes = map[storage.TeamActivityKey][]storage.TeamLike{key: {
		{LikerUserID: teamUserA, LikerDisplayName: "A"}, {LikerUserID: teamUserB, LikerDisplayName: "B"}, {LikerUserID: teamUserC}, {LikerUserID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", LikerDisplayName: "D"},
	}}
	now := time.Date(2026, 8, 6, 4, 0, 0, 0, time.UTC)
	h.svc.teams.now = func() time.Time { return now }
	w := h.do(t, http.MethodGet, "/api/teams/team-1/feed?days=7&limit_per_user=5", "", h.bearer(t, teamUserA))
	if w.Code != 200 {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
	var resp teamFeedResponse
	mustJSON(t, w, &resp)
	if h.auth.memberCalls != 1 || h.store.feedCalls != 1 || h.store.bulkLikeCalls != 1 || h.store.profileCalls != 1 {
		t.Fatalf("calls members=%d feed=%d likes=%d profiles=%d", h.auth.memberCalls, h.store.feedCalls, h.store.bulkLikeCalls, h.store.profileCalls)
	}
	if h.store.feedDays != 7 || h.store.feedLimit != 5 || !h.store.feedNow.Equal(now) || len(h.store.bulkTargets) != 1 || h.store.bulkTeamID != "team-1" {
		t.Fatalf("feed inputs=%+v", h.store)
	}
	activity := resp.Activities[0]
	if activity.Date != "2026-08-06T01:00:00+08:00" || activity.DisplayName != "Runner B" || activity.DistanceKM != 12.35 || activity.DurationFmt != "01:00:00" || activity.PaceFmt != "5:00/km" {
		t.Fatalf("activity=%+v", activity)
	}
	if activity.LikeCount != 4 || !activity.YouLiked || len(activity.TopLikers) != 3 || activity.TopLikers[2] != "cccccccc" {
		t.Fatalf("likes=%+v", activity)
	}
	var raw map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	routeValue := raw["activities"].([]any)[0].(map[string]any)["route_thumb"]
	if _, ok := routeValue.(map[string]any); !ok {
		t.Fatalf("route_thumb type=%T value=%v", routeValue, routeValue)
	}
}

func TestTeamFeedValidationAndLikeFailureFallback(t *testing.T) {
	h := newTeamHarness(t)
	h.auth.members = []authsvc.Member{{UserID: teamUserA}}
	h.store.feed = []storage.Activity{{UserID: teamUserA, LabelID: "run-1", Date: time.Now()}}
	h.store.likesErr = errors.New("likes unavailable")
	for _, query := range []string{"?days=0", "?days=x", "?limit_per_user=101"} {
		w := h.do(t, http.MethodGet, "/api/teams/team-1/feed"+query, "", h.bearer(t, teamUserA))
		if w.Code != 422 {
			t.Fatalf("query %q code=%d body=%s", query, w.Code, w.Body.String())
		}
	}
	w := h.do(t, http.MethodGet, "/api/teams/team-1/feed", "", h.bearer(t, teamUserA))
	if w.Code != 200 {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
	var resp teamFeedResponse
	mustJSON(t, w, &resp)
	if h.store.feedDays != 30 || h.store.feedLimit != 20 || resp.Activities[0].LikeCount != 0 || resp.Activities[0].YouLiked || len(resp.Activities[0].TopLikers) != 0 {
		t.Fatalf("resp=%+v defaults=%d/%d", resp, h.store.feedDays, h.store.feedLimit)
	}
}

func TestTeamDetailUsesMembershipAndSharedAssembler(t *testing.T) {
	t.Run("caller and target membership", func(t *testing.T) {
		h := newTeamHarness(t)
		h.auth.members = []authsvc.Member{{UserID: teamUserB}}
		w := h.do(t, http.MethodGet, "/api/teams/team-1/activities/"+teamUserB+"/run-1", "", h.bearer(t, teamUserA))
		if w.Code != 403 || !strings.Contains(w.Body.String(), "Caller is not a member") {
			t.Fatalf("caller=%d %s", w.Code, w.Body.String())
		}
		if h.activities.gotDetailID != "" {
			t.Fatal("activity store called before authorization")
		}
		h.auth.members = []authsvc.Member{{UserID: teamUserA}}
		w = h.do(t, http.MethodGet, "/api/teams/team-1/activities/"+teamUserB+"/run-1", "", h.bearer(t, teamUserA))
		if w.Code != 404 || !strings.Contains(w.Body.String(), "User is not in this team") {
			t.Fatalf("target=%d %s", w.Code, w.Body.String())
		}
	})

	t.Run("same assembler includes timeseries", func(t *testing.T) {
		h := newTeamHarness(t)
		h.auth.members = []authsvc.Member{{UserID: teamUserA}, {UserID: teamUserB}}
		h.activities.activity = &storage.Activity{UserID: teamUserB, LabelID: "run-1", Date: time.Now()}
		h.activities.laps = map[string][]storage.Lap{}
		h.activities.series = []storage.TimeseriesPoint{{Timestamp: i64ptr(1)}}
		w := h.do(t, http.MethodGet, "/api/teams/team-1/activities/"+teamUserB+"/run-1", "", h.bearer(t, teamUserA))
		if w.Code != 200 {
			t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
		}
		var resp activityDetailResponse
		mustJSON(t, w, &resp)
		if !h.activities.tsCalled || resp.Timeseries == nil || len(*resp.Timeseries) != 1 || strings.Join(h.activities.gotLapTypes, ",") != "autoKm,type2" {
			t.Fatalf("assembler resp=%+v store=%+v", resp, h.activities)
		}
	})

	t.Run("not found and store error", func(t *testing.T) {
		h := newTeamHarness(t)
		h.auth.members = []authsvc.Member{{UserID: teamUserA}, {UserID: teamUserB}}
		w := h.do(t, http.MethodGet, "/api/teams/team-1/activities/"+teamUserB+"/missing", "", h.bearer(t, teamUserA))
		if w.Code != 404 || !strings.Contains(w.Body.String(), "Activity not found") {
			t.Fatalf("missing=%d %s", w.Code, w.Body.String())
		}
		h.activities.actErr = errors.New("db")
		w = h.do(t, http.MethodGet, "/api/teams/team-1/activities/"+teamUserB+"/broken", "", h.bearer(t, teamUserA))
		if w.Code != 500 || strings.Contains(w.Body.String(), "db") {
			t.Fatalf("error=%d %s", w.Code, w.Body.String())
		}
	})
}

func TestTeamMileageShanghaiPeriodRankingAndMembership(t *testing.T) {
	h := newTeamHarness(t)
	nameA, nameB := "Zed", "Amy"
	h.auth.members = []authsvc.Member{{UserID: teamUserA, Name: &nameA}, {UserID: teamUserB, Name: &nameB}, {UserID: teamUserC}}
	start := time.Date(2026, 8, 3, 0, 0, 0, 0, time.FixedZone("Asia/Shanghai", 8*3600))
	end := time.Date(2026, 8, 6, 12, 0, 0, 0, time.FixedZone("Asia/Shanghai", 8*3600))
	h.store.mileage = &storage.TeamMileageResult{PeriodStart: start, PeriodEnd: end, Rows: []storage.TeamMileage{{UserID: teamUserA, TotalKM: 10.004, ActivityCount: 2}, {UserID: teamUserB, TotalKM: 10.004, ActivityCount: 2}, {UserID: teamUserC}}}
	now := end.UTC()
	h.svc.teams.now = func() time.Time { return now }
	w := h.do(t, http.MethodGet, "/api/teams/team-1/mileage?period=week", "", h.bearer(t, teamUserA))
	if w.Code != 200 {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
	var resp teamMileageResponse
	mustJSON(t, w, &resp)
	if h.auth.memberCalls != 1 || h.store.mileagePeriod != storage.TeamMileageWeek || !h.store.mileageNow.Equal(now) {
		t.Fatalf("inputs period=%s now=%s calls=%d", h.store.mileagePeriod, h.store.mileageNow, h.auth.memberCalls)
	}
	if resp.PeriodStart != "2026-08-03T00:00:00+08:00" || resp.PeriodEnd != "2026-08-06T12:00:00+08:00" || len(resp.Rankings) != 3 {
		t.Fatalf("resp=%+v", resp)
	}
	if resp.Rankings[0].DisplayName != "Amy" || resp.Rankings[1].DisplayName != "Zed" || resp.Rankings[2].TotalKM != 0 {
		t.Fatalf("rankings=%+v", resp.Rankings)
	}

	w = h.do(t, http.MethodGet, "/api/teams/team-1/mileage?period=quarter", "", h.bearer(t, teamUserA))
	if w.Code != 422 {
		t.Fatalf("invalid period=%d %s", w.Code, w.Body.String())
	}
	h.auth.members = []authsvc.Member{{UserID: teamUserB}}
	w = h.do(t, http.MethodGet, "/api/teams/team-1/mileage", "", h.bearer(t, teamUserA))
	if w.Code != 403 {
		t.Fatalf("outsider=%d %s", w.Code, w.Body.String())
	}
}

func TestTeamLikesMembershipValidationNoActivityCheckAndIdempotency(t *testing.T) {
	h := newTeamHarness(t)
	localName := "Local A"
	h.auth.members = []authsvc.Member{{UserID: teamUserA}, {UserID: teamUserB}}
	h.store.profiles = map[string]storage.UserProfile{teamUserA: {UserID: teamUserA, DisplayName: localName}}
	path := "/api/teams/team-1/activities/" + teamUserB + "/missing-activity/likes"
	header := h.bearer(t, teamUserA)

	w := h.do(t, http.MethodPost, path, "", header)
	if w.Code != 200 {
		t.Fatalf("first like=%d %s", w.Code, w.Body.String())
	}
	w = h.do(t, http.MethodPost, path, "", header)
	if w.Code != 200 {
		t.Fatalf("second like=%d %s", w.Code, w.Body.String())
	}
	var mutation likeMutationResponse
	mustJSON(t, w, &mutation)
	if mutation.Count != 1 || !mutation.Liked || !mutation.YouLiked || h.store.putCalls != 2 {
		t.Fatalf("mutation=%+v puts=%d", mutation, h.store.putCalls)
	}
	if h.store.putLike.LikerDisplayName != localName || h.store.putLike.LabelID != "missing-activity" || h.activities.gotDetailID != "" {
		t.Fatalf("like=%+v activity lookup=%q", h.store.putLike, h.activities.gotDetailID)
	}

	w = h.do(t, http.MethodDelete, path, "", header)
	if w.Code != 200 {
		t.Fatalf("unlike=%d %s", w.Code, w.Body.String())
	}
	w = h.do(t, http.MethodDelete, path, "", header)
	if w.Code != 200 {
		t.Fatalf("second unlike=%d %s", w.Code, w.Body.String())
	}
	mustJSON(t, w, &mutation)
	if mutation.Count != 0 || mutation.Liked || mutation.YouLiked || h.store.deleteCalls != 2 {
		t.Fatalf("unlike=%+v deletes=%d", mutation, h.store.deleteCalls)
	}
}

func TestTeamLikesGetNameResolutionAndValidation(t *testing.T) {
	h := newTeamHarness(t)
	authB := "Current B"
	h.auth.members = []authsvc.Member{{UserID: teamUserA}, {UserID: teamUserB, DisplayName: &authB}}
	h.store.activityLikes = []storage.TeamLike{
		{LikerUserID: teamUserA, LikerDisplayName: "Stored A", CreatedAt: time.Date(2026, 8, 6, 1, 0, 0, 0, time.UTC)},
		{LikerUserID: teamUserB, LikerDisplayName: "Stored B", CreatedAt: time.Date(2026, 8, 6, 2, 0, 0, 0, time.UTC)},
		{LikerUserID: teamUserC, LikerDisplayName: "Stored C", CreatedAt: time.Date(2026, 8, 6, 3, 0, 0, 0, time.UTC)},
	}
	h.store.profiles = map[string]storage.UserProfile{teamUserA: {UserID: teamUserA, DisplayName: "Local A"}}
	path := "/api/teams/team-1/activities/" + teamUserB + "/run-1/likes"
	w := h.do(t, http.MethodGet, path, "", h.bearer(t, teamUserA))
	if w.Code != 200 {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
	var resp likesResponse
	mustJSON(t, w, &resp)
	if resp.Count != 3 || !resp.YouLiked || resp.Likers[0].DisplayName != "Local A" || resp.Likers[1].DisplayName != "Current B" || resp.Likers[2].DisplayName != "Stored C" {
		t.Fatalf("resp=%+v", resp)
	}

	for _, badPath := range []string{
		"/api/teams/bad.team/activities/" + teamUserB + "/run-1/likes",
		"/api/teams/team-1/activities/not-a-uuid/run-1/likes",
		"/api/teams/team-1/activities/" + teamUserB + "/bad.label/likes",
	} {
		w = h.do(t, http.MethodGet, badPath, "", h.bearer(t, teamUserA))
		if w.Code != 422 {
			t.Fatalf("bad path %s => %d %s", badPath, w.Code, w.Body.String())
		}
	}

	h.auth.members = []authsvc.Member{{UserID: teamUserA}}
	w = h.do(t, http.MethodGet, path, "", h.bearer(t, teamUserA))
	if w.Code != 404 {
		t.Fatalf("missing target=%d %s", w.Code, w.Body.String())
	}
	h.auth.members = []authsvc.Member{{UserID: teamUserB}}
	w = h.do(t, http.MethodGet, path, "", h.bearer(t, teamUserA))
	if w.Code != 403 {
		t.Fatalf("missing caller=%d %s", w.Code, w.Body.String())
	}
}
