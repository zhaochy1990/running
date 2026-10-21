package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/storage"
)

// fakeRoadmapStore is an in-memory RoadmapStore. It models the UNIQUE vote,
// the release-time snapshot freeze and the delete-cascades-votes behaviour;
// the MySQL specifics (column sizes, real UNIQUE enforcement) are pinned
// against a real database in internal/storage.
type fakeRoadmapStore struct {
	features map[uint64]*storage.RoadmapFeature
	votes    map[uint64]map[string]bool // feature id -> voter set
	nextID   uint64
}

func newFakeRoadmapStore() *fakeRoadmapStore {
	return &fakeRoadmapStore{
		features: map[uint64]*storage.RoadmapFeature{},
		votes:    map[uint64]map[string]bool{},
	}
}

func (f *fakeRoadmapStore) seed(row *storage.RoadmapFeature) uint64 {
	f.nextID++
	row.ID = f.nextID
	if row.CreatedAt.IsZero() {
		row.CreatedAt = time.Now().UTC()
	}
	f.features[row.ID] = row
	return row.ID
}

func (f *fakeRoadmapStore) ListRoadmapFeatures(_ context.Context, status string) ([]storage.RoadmapFeature, error) {
	out := []storage.RoadmapFeature{}
	for _, row := range f.features {
		if status == "" || row.Status == status {
			out = append(out, *row)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (f *fakeRoadmapStore) GetRoadmapFeature(_ context.Context, id uint64) (*storage.RoadmapFeature, error) {
	if row := f.features[id]; row != nil {
		cp := *row
		return &cp, nil
	}
	return nil, storage.ErrRoadmapFeatureNotFound
}

func (f *fakeRoadmapStore) CreateRoadmapFeature(_ context.Context, row *storage.RoadmapFeature) error {
	f.nextID++
	row.ID = f.nextID
	now := time.Now().UTC()
	row.CreatedAt, row.UpdatedAt = now, now
	f.features[row.ID] = row
	return nil
}

func (f *fakeRoadmapStore) UpdateRoadmapFeature(_ context.Context, row *storage.RoadmapFeature, releasing bool) error {
	if f.features[row.ID] == nil {
		return storage.ErrRoadmapFeatureNotFound
	}
	if releasing {
		now := time.Now().UTC()
		row.ReleasedAt = &now
		row.VotesSnapshot = uint64(len(f.votes[row.ID]))
	}
	cp := *row
	cp.UpdatedAt = time.Now().UTC()
	f.features[row.ID] = &cp
	*row = cp
	return nil
}

func (f *fakeRoadmapStore) DeleteRoadmapFeature(_ context.Context, id uint64) error {
	if f.features[id] == nil {
		return storage.ErrRoadmapFeatureNotFound
	}
	delete(f.features, id)
	delete(f.votes, id) // votes die with the feature
	return nil
}

func (f *fakeRoadmapStore) RoadmapVoteCounts(_ context.Context) (map[uint64]uint64, error) {
	out := map[uint64]uint64{}
	for fid, voters := range f.votes {
		out[fid] = uint64(len(voters))
	}
	return out, nil
}

func (f *fakeRoadmapStore) RoadmapVoteIDsByUser(_ context.Context, userID string) ([]uint64, error) {
	out := []uint64{}
	for fid, voters := range f.votes {
		if voters[userID] {
			out = append(out, fid)
		}
	}
	return out, nil
}

func (f *fakeRoadmapStore) AddRoadmapVote(_ context.Context, userID string, featureID uint64) error {
	if f.votes[featureID] == nil {
		f.votes[featureID] = map[string]bool{}
	}
	f.votes[featureID][userID] = true
	return nil
}

func (f *fakeRoadmapStore) RemoveRoadmapVote(_ context.Context, userID string, featureID uint64) error {
	delete(f.votes[featureID], userID)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

type roadmapHarness struct {
	svc   *Service
	store *fakeRoadmapStore
	key   *rsa.PrivateKey
}

func newRoadmapHarness(t *testing.T) *roadmapHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	store := newFakeRoadmapStore()
	svc := NewService(Config{
		Auth:         NewAuthenticator(testToken, verifier),
		RoadmapStore: store,
	})
	return &roadmapHarness{svc: svc, store: store, key: key}
}

func (h *roadmapHarness) token(t *testing.T, audience, sub string) map[string]string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": audience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	if audience == testAdminAudience {
		claims["role"] = "admin"
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + signed}
}

func (h *roadmapHarness) userToken(t *testing.T, sub string) map[string]string {
	return h.token(t, testAudience, sub)
}

func (h *roadmapHarness) adminToken(t *testing.T) map[string]string {
	return h.token(t, testAdminAudience, "00000000-0000-4000-8000-000000000001")
}

func (h *roadmapHarness) do(t *testing.T, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	reader := strings.NewReader("")
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = strings.NewReader(string(encoded))
	}
	r := httptest.NewRequest(method, path, reader)
	r.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, r)
	return w
}

// decodeRoadmapJSON unwraps a JSON response body into dst.
func decodeRoadmapJSON(t *testing.T, w *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), dst); err != nil {
		t.Fatalf("unmarshal %s: %v", w.Body.String(), err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

func TestRoadmap_TierGuards(t *testing.T) {
	h := newRoadmapHarness(t)
	user := h.userToken(t, "11111111-2222-4333-8333-333333333333")
	admin := h.adminToken(t)

	// No token → 401 on both surfaces.
	if w := h.do(t, http.MethodGet, "/api/roadmap", nil, nil); w.Code != http.StatusUnauthorized {
		t.Errorf("no-token user list: status = %d, want 401", w.Code)
	}
	if w := h.do(t, http.MethodGet, "/api/admin/roadmap/features", nil, nil); w.Code != http.StatusUnauthorized {
		t.Errorf("no-token admin list: status = %d, want 401", w.Code)
	}
	// Admin tier is refused on the user surface (rejectAdminCaller group)…
	if w := h.do(t, http.MethodGet, "/api/roadmap", nil, admin); w.Code != http.StatusForbidden {
		t.Errorf("admin on user list: status = %d, want 403", w.Code)
	}
	if w := h.do(t, http.MethodPost, "/api/roadmap/features/1/vote", nil, admin); w.Code != http.StatusForbidden {
		t.Errorf("admin on vote: status = %d, want 403", w.Code)
	}
	// …and user callers are refused on the admin surface.
	if w := h.do(t, http.MethodGet, "/api/admin/roadmap/features", nil, user); w.Code != http.StatusForbidden {
		t.Errorf("user on admin list: status = %d, want 403", w.Code)
	}
	if w := h.do(t, http.MethodPost, "/api/admin/roadmap/features", map[string]any{"title": "x"}, user); w.Code != http.StatusForbidden {
		t.Errorf("user on admin create: status = %d, want 403", w.Code)
	}
}

func TestRoadmap_UserList(t *testing.T) {
	h := newRoadmapHarness(t)
	hdr := h.userToken(t, "11111111-2222-4333-8333-333333333333")
	other := h.userToken(t, "22222222-3333-4444-8444-444444444444")
	ctx := context.Background()

	now := time.Now().UTC()
	backlogAt := func(title string, age time.Duration) *storage.RoadmapFeature {
		return &storage.RoadmapFeature{Title: title, Status: storage.RoadmapStatusBacklog, CreatedAt: now.Add(-age)}
	}
	a := h.store.seed(backlogAt("想法A", 24*time.Hour)) // new, 2 votes
	h.store.features[a].Summary = "概述A"
	h.store.features[a].Description = "## 详细描述A"
	b := h.store.seed(backlogAt("想法B", 8*24*time.Hour)) // old, 1 vote
	c := h.store.seed(backlogAt("想法C", 24*time.Hour))   // new, 0 votes
	h.store.seed(&storage.RoadmapFeature{Title: "草稿I", Status: storage.RoadmapStatusDraft, CreatedAt: now.Add(-24 * time.Hour)})
	h.store.seed(&storage.RoadmapFeature{Title: "排期F", Status: storage.RoadmapStatusAccepted, PlannedNote: "2026.03"})
	h.store.seed(&storage.RoadmapFeature{Title: "排期E", Status: storage.RoadmapStatusAccepted}) // empty note → last
	d := h.store.seed(&storage.RoadmapFeature{Title: "排期D", Status: storage.RoadmapStatusAccepted, PlannedNote: "2026.11"})
	relAt := func(month int) *time.Time {
		tm := time.Date(2026, time.Month(month), 14, 0, 0, 0, 0, time.UTC)
		return &tm
	}
	g := h.store.seed(&storage.RoadmapFeature{Title: "上线G", Status: storage.RoadmapStatusReleased, ReleasedAt: relAt(9), VotesSnapshot: 214})
	hh := h.store.seed(&storage.RoadmapFeature{Title: "上线H", Status: storage.RoadmapStatusReleased, ReleasedAt: relAt(10), VotesSnapshot: 87})
	h.store.seed(&storage.RoadmapFeature{Title: "草稿I", Status: storage.RoadmapStatusDraft, CreatedAt: now.Add(-24 * time.Hour)})

	// u1 voted A + D; other voted A + B + G → 5 votes overall.
	for _, v := range [][2]any{
		{"11111111-2222-4333-8333-333333333333", a}, {"11111111-2222-4333-8333-333333333333", d},
		{"22222222-3333-4444-8444-444444444444", a}, {"22222222-3333-4444-8444-444444444444", b},
		{"22222222-3333-4444-8444-444444444444", g},
	} {
		if err := h.store.AddRoadmapVote(ctx, v[0].(string), v[1].(uint64)); err != nil {
			t.Fatalf("seed vote: %v", err)
		}
	}

	w := h.do(t, http.MethodGet, "/api/roadmap", nil, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("user list: status = %d, body %s", w.Code, w.Body.String())
	}
	var got roadmapResponse
	decodeRoadmapJSON(t, w, &got)

	if got.Summary.MyVotes != 2 || got.Summary.TotalVotes != 5 || got.Summary.ReleasedCount != 2 {
		t.Errorf("summary = %+v, want my=2 total=5 released=2", got.Summary)
	}
	// Backlog: votes desc → A(2) B(1) C(0); is_new only on 1-day-old rows;
	// voted mirrors the caller.
	if len(got.Backlog) != 3 {
		t.Fatalf("backlog len = %d, want 3", len(got.Backlog))
	}
	if got.Backlog[0].ID != a || got.Backlog[1].ID != b || got.Backlog[2].ID != c {
		t.Errorf("backlog order = %d,%d,%d, want %d,%d,%d", got.Backlog[0].ID, got.Backlog[1].ID, got.Backlog[2].ID, a, b, c)
	}
	if !got.Backlog[0].IsNew || got.Backlog[1].IsNew || !got.Backlog[2].IsNew {
		t.Errorf("is_new = %v,%v,%v, want true,false,true", got.Backlog[0].IsNew, got.Backlog[1].IsNew, got.Backlog[2].IsNew)
	}
	if got.Backlog[0].Votes != 2 || got.Backlog[1].Votes != 1 || got.Backlog[2].Votes != 0 {
		t.Errorf("backlog votes = %d,%d,%d, want 2,1,0", got.Backlog[0].Votes, got.Backlog[1].Votes, got.Backlog[2].Votes)
	}
	if !got.Backlog[0].Voted || got.Backlog[1].Voted || got.Backlog[2].Voted {
		t.Errorf("voted flags (u1) = %v,%v,%v, want true,false,false", got.Backlog[0].Voted, got.Backlog[1].Voted, got.Backlog[2].Voted)
	}
	// Summary rides along on every section; empty stays empty (client-side
	// truncation fallback, not server-invented text).
	if got.Backlog[0].Summary != "概述A" || got.Backlog[1].Summary != "" || got.Backlog[0].Description != "## 详细描述A" {
		t.Errorf("backlog summary = %q,%q desc %q", got.Backlog[0].Summary, got.Backlog[1].Summary, got.Backlog[0].Description)
	}
	// Accepted: planned_note asc with empty sinking.
	if len(got.Accepted) != 3 ||
		got.Accepted[0].PlannedNote != "2026.03" || got.Accepted[1].ID != d || got.Accepted[2].PlannedNote != "" {
		t.Errorf("accepted order = %+v", got.Accepted)
	}
	// Released: newest launch first, frozen snapshots, +08:00 timestamps.
	if len(got.Released) != 2 || got.Released[0].ID != hh || got.Released[1].ID != g {
		t.Errorf("released order = %d,%d, want %d,%d", got.Released[0].ID, got.Released[1].ID, hh, g)
	}
	if got.Released[0].VotesSnapshot != 87 || got.Released[1].VotesSnapshot != 214 {
		t.Errorf("released snapshots = %d,%d, want 87,214", got.Released[0].VotesSnapshot, got.Released[1].VotesSnapshot)
	}
	if !strings.HasSuffix(got.Released[0].ReleasedAt, "+08:00") {
		t.Errorf("released_at = %q, want a +08:00 offset RFC3339", got.Released[0].ReleasedAt)
	}
	// Draft never appears anywhere in the payload.
	if body := w.Body.String(); strings.Contains(body, "草稿I") || strings.Contains(body, `"draft"`) {
		t.Errorf("draft leaked into user payload: %s", body)
	}

	// The second user sees their own voted flags; summary recomputes.
	var gotOther roadmapResponse
	decodeRoadmapJSON(t, h.do(t, http.MethodGet, "/api/roadmap", nil, other), &gotOther)
	if gotOther.Summary.MyVotes != 3 {
		t.Errorf("other my_votes = %d, want 3", gotOther.Summary.MyVotes)
	}
	if !gotOther.Backlog[0].Voted || !gotOther.Backlog[1].Voted || gotOther.Backlog[2].Voted {
		t.Errorf("other voted flags = %v,%v,%v, want true,true,false",
			gotOther.Backlog[0].Voted, gotOther.Backlog[1].Voted, gotOther.Backlog[2].Voted)
	}
}

func TestRoadmap_VoteEndpoints(t *testing.T) {
	h := newRoadmapHarness(t)
	hdr := h.userToken(t, "11111111-2222-4333-8333-333333333333")

	backlog := h.store.seed(&storage.RoadmapFeature{Title: "可投", Status: storage.RoadmapStatusBacklog})
	accepted := h.store.seed(&storage.RoadmapFeature{Title: "已排期", Status: storage.RoadmapStatusAccepted})
	released := h.store.seed(&storage.RoadmapFeature{Title: "已上线", Status: storage.RoadmapStatusReleased})

	// Happy path + idempotent repeat: both 200, still exactly one vote.
	for i := 0; i < 2; i++ {
		w := h.do(t, http.MethodPost, "/api/roadmap/features/"+strconv.FormatUint(backlog, 10)+"/vote", nil, hdr)
		if w.Code != http.StatusOK {
			t.Fatalf("vote #%d: status = %d, body %s", i, w.Code, w.Body.String())
		}
		var got roadmapVoteResponse
		decodeRoadmapJSON(t, w, &got)
		if !got.Voted || got.FeatureID != backlog {
			t.Errorf("vote #%d body = %+v", i, got)
		}
	}
	if n := len(h.store.votes[backlog]); n != 1 {
		t.Errorf("vote rows = %d, want 1 (idempotent)", n)
	}

	// Non-backlog → 409 not_votable; missing → 404 feature_not_found.
	for _, tt := range []struct {
		name string
		id   uint64
		want int
		code string
	}{
		{"accepted", accepted, http.StatusConflict, "not_votable"},
		{"released", released, http.StatusConflict, "not_votable"},
		{"missing", 999, http.StatusNotFound, "feature_not_found"},
	} {
		w := h.do(t, http.MethodPost, "/api/roadmap/features/"+strconv.FormatUint(tt.id, 10)+"/vote", nil, hdr)
		if w.Code != tt.want {
			t.Errorf("%s: status = %d, want %d", tt.name, w.Code, tt.want)
			continue
		}
		var got errorResponse
		decodeRoadmapJSON(t, w, &got)
		if got.Error != tt.code {
			t.Errorf("%s: error = %q, want %q", tt.name, got.Error, tt.code)
		}
	}

	// Un-vote: first delete removes, second is an idempotent 200; a missing
	// feature is also a plain 200.
	if w := h.do(t, http.MethodDelete, "/api/roadmap/features/"+strconv.FormatUint(backlog, 10)+"/vote", nil, hdr); w.Code != http.StatusOK {
		t.Fatalf("unvote: status = %d", w.Code)
	}
	if n := len(h.store.votes[backlog]); n != 0 {
		t.Errorf("vote rows after unvote = %d, want 0", n)
	}
	for _, path := range []string{
		"/api/roadmap/features/" + strconv.FormatUint(backlog, 10) + "/vote", // already removed
		"/api/roadmap/features/999/vote",                                     // feature never existed
	} {
		if w := h.do(t, http.MethodDelete, path, nil, hdr); w.Code != http.StatusOK {
			t.Errorf("idempotent unvote %s: status = %d, want 200", path, w.Code)
		}
	}
	// Non-integer id → 400.
	if w := h.do(t, http.MethodPost, "/api/roadmap/features/abc/vote", nil, hdr); w.Code != http.StatusBadRequest {
		t.Errorf("non-integer id: status = %d, want 400", w.Code)
	}
}

func TestRoadmap_UserFeatureDetail(t *testing.T) {
	h := newRoadmapHarness(t)
	hdr := h.userToken(t, "11111111-2222-4333-8333-333333333333")
	admin := h.adminToken(t)

	h.store.seed(&storage.RoadmapFeature{Title: "草稿", Status: storage.RoadmapStatusDraft})
	backlog := h.store.seed(&storage.RoadmapFeature{
		Title: "待投", Summary: "概述", Description: "## 正文\n- 要点一", Status: storage.RoadmapStatusBacklog,
	})
	accepted := h.store.seed(&storage.RoadmapFeature{
		Title: "已排期", Status: storage.RoadmapStatusAccepted, PlannedNote: "2026.11",
	})
	relAt := time.Date(2026, time.October, 14, 0, 0, 0, 0, time.UTC)
	released := h.store.seed(&storage.RoadmapFeature{
		Title: "已上线", Status: storage.RoadmapStatusReleased, ReleasedAt: &relAt, VotesSnapshot: 87,
	})

	// Backlog detail: full markdown description rides, no votes leaked.
	w := h.do(t, http.MethodGet, "/api/roadmap/features/"+strconv.FormatUint(backlog, 10), nil, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("backlog detail: status = %d, body %s", w.Code, w.Body.String())
	}
	var got roadmapFeatureDetail
	decodeRoadmapJSON(t, w, &got)
	if got.Title != "待投" || got.Summary != "概述" || got.Description != "## 正文\n- 要点一" {
		t.Errorf("backlog detail = %+v", got)
	}
	if got.Status != storage.RoadmapStatusBacklog || got.PlannedNote != "" || got.ReleasedAt != nil {
		t.Errorf("backlog detail meta = %+v", got)
	}

	// Accepted detail carries planned_note; released carries +08:00 released_at.
	decodeRoadmapJSON(t, h.do(t, http.MethodGet, "/api/roadmap/features/"+strconv.FormatUint(accepted, 10), nil, hdr), &got)
	if got.PlannedNote != "2026.11" {
		t.Errorf("accepted detail = %+v", got)
	}
	decodeRoadmapJSON(t, h.do(t, http.MethodGet, "/api/roadmap/features/"+strconv.FormatUint(released, 10), nil, hdr), &got)
	if got.ReleasedAt == nil || !strings.HasSuffix(*got.ReleasedAt, "+08:00") {
		t.Errorf("released detail released_at = %v, want +08:00 RFC3339", got.ReleasedAt)
	}

	// Drafts and missing ids are indistinguishable 404s; admin tier is refused.
	for _, id := range []string{"1", "999"} {
		if w := h.do(t, http.MethodGet, "/api/roadmap/features/"+id, nil, hdr); w.Code != http.StatusNotFound {
			t.Errorf("detail id %s: status = %d, want 404", id, w.Code)
		}
	}
	if w := h.do(t, http.MethodGet, "/api/roadmap/features/abc", nil, hdr); w.Code != http.StatusBadRequest {
		t.Errorf("non-integer id: status = %d, want 400", w.Code)
	}
	if w := h.do(t, http.MethodGet, "/api/roadmap/features/"+strconv.FormatUint(backlog, 10), nil, admin); w.Code != http.StatusForbidden {
		t.Errorf("admin on detail: status = %d, want 403", w.Code)
	}
	if w := h.do(t, http.MethodGet, "/api/roadmap/features/"+strconv.FormatUint(backlog, 10), nil, nil); w.Code != http.StatusUnauthorized {
		t.Errorf("no-token detail: status = %d, want 401", w.Code)
	}
}

func TestRoadmap_AdminLifecycle(t *testing.T) {
	h := newRoadmapHarness(t)
	admin := h.adminToken(t)
	uid := "11111111-2222-4333-8333-333333333333"
	ctx := context.Background()
	patch := func(id uint64, body map[string]any) *httptest.ResponseRecorder {
		return h.do(t, http.MethodPatch, "/api/admin/roadmap/features/"+strconv.FormatUint(id, 10), body, admin)
	}

	// Create defaults to draft.
	w := h.do(t, http.MethodPost, "/api/admin/roadmap/features",
		map[string]any{"title": "新想法", "summary": "概述文本", "description": "说明", "category": "导航"}, admin)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: status = %d, body %s", w.Code, w.Body.String())
	}
	var created roadmapAdminFeatureDTO
	decodeRoadmapJSON(t, w, &created)
	if created.Status != storage.RoadmapStatusDraft || created.ID == 0 {
		t.Fatalf("created row = %+v, want draft", created)
	}
	if created.Summary != "概述文本" {
		t.Errorf("created summary = %q, want 概述文本", created.Summary)
	}
	// A 51-rune summary busts the list-blurb cap → 400.
	if w := h.do(t, http.MethodPost, "/api/admin/roadmap/features",
		map[string]any{"title": "x", "summary": strings.Repeat("概", 51)}, admin); w.Code != http.StatusBadRequest {
		t.Errorf("create oversized summary: status = %d, want 400", w.Code)
	}

	// Missing title → 400; unknown status → 422 invalid_status.
	if w := h.do(t, http.MethodPost, "/api/admin/roadmap/features", map[string]any{}, admin); w.Code != http.StatusBadRequest {
		t.Errorf("create missing title: status = %d, want 400", w.Code)
	}
	if w := h.do(t, http.MethodPost, "/api/admin/roadmap/features", map[string]any{"title": "x", "status": "chicken"}, admin); w.Code != http.StatusUnprocessableEntity {
		t.Errorf("create bad status: status = %d, want 422", w.Code)
	}

	// Field-only PATCH keeps status; explicit empty planned_note is allowed.
	w = patch(created.ID, map[string]any{"title": "改名", "summary": "新概述", "planned_note": ""})
	if w.Code != http.StatusOK {
		t.Fatalf("field patch: status = %d, body %s", w.Code, w.Body.String())
	}
	var patched roadmapAdminFeatureDTO
	decodeRoadmapJSON(t, w, &patched)
	if patched.Title != "改名" || patched.Summary != "新概述" || patched.Status != storage.RoadmapStatusDraft {
		t.Errorf("patched row = %+v", patched)
	}

	// Forward skip-level transition draft→backlog, votes land, then
	// draft→…→released in one more hop.
	if w := patch(created.ID, map[string]any{"status": storage.RoadmapStatusBacklog}); w.Code != http.StatusOK {
		t.Fatalf("transition →backlog: status = %d, body %s", w.Code, w.Body.String())
	}
	if w := h.do(t, http.MethodPost, "/api/roadmap/features/"+strconv.FormatUint(created.ID, 10)+"/vote", nil, h.userToken(t, uid)); w.Code != http.StatusOK {
		t.Fatalf("vote: status = %d", w.Code)
	}
	if err := h.store.AddRoadmapVote(ctx, "22222222-3333-4444-8444-444444444444", created.ID); err != nil { // second voter
		t.Fatalf("seed vote: %v", err)
	}
	w = patch(created.ID, map[string]any{"status": storage.RoadmapStatusReleased}) // skip accepted
	if w.Code != http.StatusOK {
		t.Fatalf("transition →released: status = %d, body %s", w.Code, w.Body.String())
	}
	decodeRoadmapJSON(t, w, &patched)
	if patched.VotesSnapshot != 2 || patched.ReleasedAt == nil {
		t.Fatalf("after release: snapshot=%d released_at=%v, want 2 + set", patched.VotesSnapshot, patched.ReleasedAt)
	}

	// A post-release vote keeps the live count moving but never the snapshot.
	_ = h.store.AddRoadmapVote(ctx, "33333333-4444-4555-8555-555555555555", created.ID)
	w = h.do(t, http.MethodGet, "/api/admin/roadmap/features", nil, admin)
	var list roadmapAdminListResponse
	decodeRoadmapJSON(t, w, &list)
	if len(list.Features) != 1 || list.Features[0].Votes != 3 || list.Features[0].VotesSnapshot != 2 {
		t.Errorf("admin row after post-release vote = %+v, want live 3 / snapshot 2", list.Features)
	}

	// User view: released rows show the frozen snapshot, not live votes.
	var userList roadmapResponse
	decodeRoadmapJSON(t, h.do(t, http.MethodGet, "/api/roadmap", nil, h.userToken(t, uid)), &userList)
	if len(userList.Backlog) != 0 || len(userList.Released) != 1 || userList.Released[0].VotesSnapshot != 2 {
		t.Errorf("user view after release = %+v", userList)
	}
	if w := h.do(t, http.MethodPost, "/api/roadmap/features/"+strconv.FormatUint(created.ID, 10)+"/vote", nil, h.userToken(t, uid)); w.Code != http.StatusConflict {
		t.Errorf("vote on released: status = %d, want 409", w.Code)
	}

	// Backward transitions are refused 422 invalid_transition.
	for _, back := range []string{storage.RoadmapStatusAccepted, storage.RoadmapStatusBacklog, storage.RoadmapStatusDraft} {
		w := patch(created.ID, map[string]any{"status": back})
		if w.Code != http.StatusUnprocessableEntity {
			t.Errorf("backward →%s: status = %d, want 422", back, w.Code)
			continue
		}
		var got errorResponse
		decodeRoadmapJSON(t, w, &got)
		if got.Error != "invalid_transition" {
			t.Errorf("backward →%s: error = %q, want invalid_transition", back, got.Error)
		}
	}
	// Same-status PATCH is the legal no-op (snapshot untouched).
	if w := patch(created.ID, map[string]any{"status": storage.RoadmapStatusReleased}); w.Code != http.StatusOK {
		t.Errorf("same-status patch: status = %d, want 200", w.Code)
	}
	// Unknown status token → 422 invalid_status.
	if w := patch(created.ID, map[string]any{"status": "chicken"}); w.Code != http.StatusUnprocessableEntity {
		t.Errorf("unknown status: status = %d, want 422", w.Code)
	}
	// Missing id → 404.
	if w := patch(999, map[string]any{"title": "x"}); w.Code != http.StatusNotFound {
		t.Errorf("patch missing: status = %d, want 404", w.Code)
	}

	// Any status is deletable (2026-10-20 policy): the released row goes away
	// with its votes — live count and snapshot alike.
	w = h.do(t, http.MethodDelete, "/api/admin/roadmap/features/"+strconv.FormatUint(created.ID, 10), nil, admin)
	if w.Code != http.StatusNoContent {
		t.Fatalf("delete released: status = %d, want 204", w.Code)
	}
	if h.store.features[created.ID] != nil || len(h.store.votes[created.ID]) != 0 {
		t.Errorf("delete released did not cascade: feature=%v votes=%v", h.store.features[created.ID], h.store.votes[created.ID])
	}

	// draft/backlog delete works and cascades the votes.
	voted := h.store.seed(&storage.RoadmapFeature{Title: "待删", Status: storage.RoadmapStatusBacklog})
	_ = h.store.AddRoadmapVote(ctx, uid, voted)
	if w := h.do(t, http.MethodDelete, "/api/admin/roadmap/features/"+strconv.FormatUint(voted, 10), nil, admin); w.Code != http.StatusNoContent {
		t.Fatalf("delete backlog: status = %d, want 204", w.Code)
	}
	if h.store.features[voted] != nil || len(h.store.votes[voted]) != 0 {
		t.Errorf("delete did not cascade: feature=%v votes=%v", h.store.features[voted], h.store.votes[voted])
	}
	if w := h.do(t, http.MethodDelete, "/api/admin/roadmap/features/"+strconv.FormatUint(voted, 10), nil, admin); w.Code != http.StatusNotFound {
		t.Errorf("delete missing: status = %d, want 404", w.Code)
	}
	// Bad status filter → 400.
	if w := h.do(t, http.MethodGet, "/api/admin/roadmap/features?status=nope", nil, admin); w.Code != http.StatusBadRequest {
		t.Errorf("bad status filter: status = %d, want 400", w.Code)
	}
}

func TestRoadmap_AdminCreateReleased(t *testing.T) {
	h := newRoadmapHarness(t)
	admin := h.adminToken(t)

	// Creating straight into released applies the same side effects as the
	// PATCH transition: released_at set, snapshot 0 (no votes can exist yet).
	w := h.do(t, http.MethodPost, "/api/admin/roadmap/features",
		map[string]any{"title": "直发", "status": storage.RoadmapStatusReleased}, admin)
	if w.Code != http.StatusCreated {
		t.Fatalf("create released: status = %d, body %s", w.Code, w.Body.String())
	}
	var got roadmapAdminFeatureDTO
	decodeRoadmapJSON(t, w, &got)
	if got.Status != storage.RoadmapStatusReleased || got.ReleasedAt == nil || got.VotesSnapshot != 0 {
		t.Errorf("created released row = %+v", got)
	}
}

func TestRoadmap_EmptyList(t *testing.T) {
	h := newRoadmapHarness(t)
	hdr := h.userToken(t, "11111111-2222-4333-8333-333333333333")
	var got roadmapResponse
	decodeRoadmapJSON(t, h.do(t, http.MethodGet, "/api/roadmap", nil, hdr), &got)
	if got.Backlog == nil || got.Accepted == nil || got.Released == nil {
		t.Errorf("empty sections must serialize as [] not null: %+v", got)
	}
	if got.Summary != (roadmapSummaryDTO{}) {
		t.Errorf("empty summary = %+v", got.Summary)
	}
}
