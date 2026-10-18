// feedback_test.go pins the feedback surface behaviour with in-memory fakes:
// tier guards, the upload contract, the unread read-clear cycle, the admin
// filters, the one-way adoption and the erasure fail-open sweep. (The UGC
// moderation surface was removed by devops#608; git history keeps its tests.)
package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
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

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

type fakeFeedbackStore struct {
	feedbacks map[uint64]*storage.Feedback
	replies   map[uint64][]storage.FeedbackReply
	names     map[string]string
	nextID    uint64
	nextReply uint64
}

func newFakeFeedbackStore() *fakeFeedbackStore {
	return &fakeFeedbackStore{
		feedbacks: map[uint64]*storage.Feedback{},
		replies:   map[uint64][]storage.FeedbackReply{},
		names:     map[string]string{},
	}
}

func (f *fakeFeedbackStore) CreateFeedback(_ context.Context, row *storage.Feedback) error {
	f.nextID++
	row.ID = f.nextID
	now := time.Now().UTC()
	row.CreatedAt, row.UpdatedAt = now, now
	cp := *row
	f.feedbacks[row.ID] = &cp
	return nil
}

func (f *fakeFeedbackStore) ListFeedbacksByUser(_ context.Context, userID string) ([]storage.Feedback, error) {
	out := []storage.Feedback{}
	for _, row := range f.feedbacks {
		if row.UserID == userID {
			out = append(out, *row)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out, nil
}

func (f *fakeFeedbackStore) GetFeedback(_ context.Context, userID string, id uint64) (*storage.Feedback, error) {
	row := f.feedbacks[id]
	if row == nil || row.UserID != userID {
		return nil, storage.ErrFeedbackNotFound
	}
	cp := *row
	return &cp, nil
}

func (f *fakeFeedbackStore) GetFeedbackByID(_ context.Context, id uint64) (*storage.Feedback, error) {
	row := f.feedbacks[id]
	if row == nil {
		return nil, storage.ErrFeedbackNotFound
	}
	cp := *row
	return &cp, nil
}

func (f *fakeFeedbackStore) FeedbackUnreadCounts(_ context.Context, userID string) (map[uint64]int64, error) {
	out := map[uint64]int64{}
	for fid, replies := range f.replies {
		owner := f.feedbacks[fid]
		if owner == nil || owner.UserID != userID {
			continue
		}
		for _, r := range replies {
			if r.Author == storage.FeedbackAuthorAdmin && !r.IsRead {
				out[fid]++
			}
		}
	}
	return out, nil
}

func (f *fakeFeedbackStore) LastFeedbackReplies(_ context.Context, ids []uint64) (map[uint64]storage.FeedbackReply, error) {
	out := map[uint64]storage.FeedbackReply{}
	for _, id := range ids {
		if replies := f.replies[id]; len(replies) > 0 {
			out[id] = replies[len(replies)-1]
		}
	}
	return out, nil
}

func (f *fakeFeedbackStore) ListFeedbackReplies(_ context.Context, feedbackID uint64) ([]storage.FeedbackReply, error) {
	return append([]storage.FeedbackReply{}, f.replies[feedbackID]...), nil
}

func (f *fakeFeedbackStore) CreateFeedbackReply(_ context.Context, row *storage.FeedbackReply) error {
	f.nextReply++
	row.ID = f.nextReply
	row.CreatedAt = time.Now().UTC()
	f.replies[row.FeedbackID] = append(f.replies[row.FeedbackID], *row)
	return nil
}

func (f *fakeFeedbackStore) CreateAdminFeedbackReply(_ context.Context, row *storage.FeedbackReply) error {
	if err := f.CreateFeedbackReply(context.Background(), row); err != nil {
		return err
	}
	if fb := f.feedbacks[row.FeedbackID]; fb != nil && fb.Status == storage.FeedbackStatusOpen {
		fb.Status = storage.FeedbackStatusReplied
	}
	return nil
}

func (f *fakeFeedbackStore) MarkFeedbackRepliesRead(_ context.Context, feedbackID uint64) error {
	for i := range f.replies[feedbackID] {
		if f.replies[feedbackID][i].Author == storage.FeedbackAuthorAdmin {
			f.replies[feedbackID][i].IsRead = true
		}
	}
	return nil
}

func (f *fakeFeedbackStore) PatchFeedbackAdmin(_ context.Context, id uint64, close bool, adopted *uint64) (*storage.Feedback, error) {
	row := f.feedbacks[id]
	if row == nil {
		return nil, storage.ErrFeedbackNotFound
	}
	if adopted != nil && row.AdoptedFeatureID != nil {
		return nil, storage.ErrFeedbackAdoptedImmutable
	}
	if close {
		row.Status = storage.FeedbackStatusClosed
	}
	if adopted != nil {
		v := *adopted
		row.AdoptedFeatureID = &v
	}
	cp := *row
	return &cp, nil
}

func (f *fakeFeedbackStore) ListFeedbacksAdmin(_ context.Context, filter storage.FeedbackFilter) ([]storage.FeedbackWithUser, error) {
	out := []storage.FeedbackWithUser{}
	for _, row := range f.feedbacks {
		if filter.Type != "" && row.Type != filter.Type {
			continue
		}
		if filter.Status != "" && row.Status != filter.Status {
			continue
		}
		if filter.Adopted != nil && (*filter.Adopted != (row.AdoptedFeatureID != nil)) {
			continue
		}
		out = append(out, storage.FeedbackWithUser{Feedback: *row, UserName: f.names[row.UserID]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out, nil
}

func (f *fakeFeedbackStore) UserDisplayName(_ context.Context, userID string) (string, error) {
	return f.names[userID], nil
}

type fakeFeedbackImages struct {
	configured bool
	uploaded   map[string][]byte
	deleted    []string
	attempted  []string
	deleteErr  map[string]error
}

func newFakeFeedbackImages() *fakeFeedbackImages {
	return &fakeFeedbackImages{
		configured: true,
		uploaded:   map[string][]byte{},
		deleteErr:  map[string]error{},
	}
}

func (m *fakeFeedbackImages) Upload(_ context.Context, key string, r io.Reader, _ string) error {
	raw, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	m.uploaded[key] = raw
	return nil
}

func (m *fakeFeedbackImages) PublicURL(key string) string { return "https://cos.example.com/" + key }

// Delete is the COSObjectDeleter half: the erasure flow takes it via a type
// assertion, the FeedbackImages port above deliberately excludes it.
func (m *fakeFeedbackImages) Delete(_ context.Context, key string) error {
	m.attempted = append(m.attempted, key)
	if err := m.deleteErr[key]; err != nil {
		return err
	}
	m.deleted = append(m.deleted, key)
	return nil
}

func (m *fakeFeedbackImages) Configured() bool { return m.configured }

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

type feedbackHarness struct {
	svc     *Service
	store   *fakeFeedbackStore
	images  *fakeFeedbackImages
	roadmap *fakeRoadmapStore
	key     *rsa.PrivateKey
	user    string
}

// newFeedbackAuth builds a fresh RSA-2048 verifier for one harness; the key
// stays on the harness so test tokens can be signed against it.
func newFeedbackAuth(t *testing.T) (*Authenticator, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	return NewAuthenticator(testToken, verifier), key
}

func newFeedbackHarness(t *testing.T) *feedbackHarness {
	t.Helper()
	auth, key := newFeedbackAuth(t)
	h := &feedbackHarness{
		store:   newFakeFeedbackStore(),
		images:  newFakeFeedbackImages(),
		roadmap: newFakeRoadmapStore(),
		key:     key,
		user:    "11111111-2222-4333-8333-333333333333",
	}
	h.svc = NewService(Config{
		Auth:           auth,
		FeedbackStore:  h.store,
		FeedbackImages: h.images,
		RoadmapStore:   h.roadmap,
	})
	return h
}

func (h *feedbackHarness) userToken(t *testing.T) map[string]string {
	return feedbackSign(t, h.key, testAudience, h.user)
}

func (h *feedbackHarness) adminToken(t *testing.T) map[string]string {
	return feedbackSign(t, h.key, testAdminAudience, "00000000-0000-4000-8000-000000000001")
}

func feedbackSign(t *testing.T, key *rsa.PrivateKey, audience, sub string) map[string]string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": audience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	if audience == testAdminAudience {
		claims["role"] = "admin"
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + signed}
}

func (h *feedbackHarness) do(t *testing.T, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	reader := strings.NewReader("")
	contentType := "application/json"
	if body != nil {
		if raw, ok := body.([]byte); ok {
			reader = strings.NewReader(string(raw))
		} else {
			encoded, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			reader = strings.NewReader(string(encoded))
		}
	}
	r := httptest.NewRequest(method, path, reader)
	r.Header.Set("Content-Type", contentType)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, r)
	return w
}

// seedFeedback inserts one row straight into the fake store.
func (h *feedbackHarness) seedFeedback(images *string, adopted *uint64) uint64 {
	h.store.nextID++
	id := h.store.nextID
	now := time.Now().UTC()
	cp := &storage.Feedback{
		ID: id, UserID: h.user, Type: storage.FeedbackTypeBug, Content: "内容" + strconv.FormatUint(id, 10),
		Images: images, Status: storage.FeedbackStatusOpen, AdoptedFeatureID: adopted, CreatedAt: now, UpdatedAt: now,
	}
	h.store.feedbacks[id] = cp
	return id
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

func TestFeedback_TierGuards(t *testing.T) {
	h := newFeedbackHarness(t)
	user, admin := h.userToken(t), h.adminToken(t)

	if w := h.do(t, http.MethodGet, "/api/users/me/feedbacks", nil, nil); w.Code != http.StatusUnauthorized {
		t.Errorf("no-token list: %d, want 401", w.Code)
	}
	if w := h.do(t, http.MethodPost, "/api/users/me/feedbacks", map[string]any{"type": "bug", "content": "x"}, admin); w.Code != http.StatusForbidden {
		t.Errorf("admin on user submit: %d, want 403", w.Code)
	}
	if w := h.do(t, http.MethodGet, "/api/admin/feedbacks", nil, user); w.Code != http.StatusForbidden {
		t.Errorf("user on admin list: %d, want 403", w.Code)
	}
	if w := h.do(t, http.MethodPatch, "/api/admin/feedbacks/1", map[string]any{"status": "closed"}, user); w.Code != http.StatusForbidden {
		t.Errorf("user on admin patch: %d, want 403", w.Code)
	}
}

func TestFeedback_SubmitValidation(t *testing.T) {
	h := newFeedbackHarness(t)
	hdr := h.userToken(t)

	if w := h.do(t, http.MethodPost, "/api/users/me/feedbacks", map[string]any{"type": "idea", "content": "x"}, hdr); w.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad type: %d, want 422", w.Code)
	}
	// A foreign key is refused before anything is written.
	if w := h.do(t, http.MethodPost, "/api/users/me/feedbacks", map[string]any{
		"type": "bug", "content": "x", "images": []string{"feedback/other-uid/evil.png"},
	}, hdr); w.Code != http.StatusForbidden {
		t.Errorf("foreign image key: %d, want 403", w.Code)
	}
	if rows, _ := h.store.ListFeedbacksByUser(context.Background(), h.user); len(rows) != 0 {
		t.Fatal("rejected submits must not persist")
	}
}

func TestFeedback_ListUnreadAndReadClear(t *testing.T) {
	h := newFeedbackHarness(t)
	hdr := h.userToken(t)
	id := h.seedFeedback(nil, nil)

	if w := h.do(t, http.MethodPost, "/api/admin/feedbacks/"+strconv.FormatUint(id, 10)+"/replies", map[string]any{"content": "官方回复"}, h.adminToken(t)); w.Code != http.StatusCreated {
		t.Fatalf("admin reply: %d", w.Code)
	}

	// The admin reply (official surface) flipped open→replied and shows as
	// unread with preview.
	var list feedbackListResponse
	w := h.do(t, http.MethodGet, "/api/users/me/feedbacks", nil, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d", w.Code)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if list.TotalUnread != 1 || len(list.Items) != 1 || !list.Items[0].Unread {
		t.Fatalf("list = %+v", list)
	}
	if list.Items[0].Status != storage.FeedbackStatusReplied || list.Items[0].LastReply == nil || list.Items[0].LastReply.Author != storage.FeedbackAuthorAdmin {
		t.Fatalf("item = %+v", list.Items[0])
	}

	// Detail read clears the unread; a second list is clean.
	if w := h.do(t, http.MethodGet, "/api/users/me/feedbacks/"+strconv.FormatUint(id, 10), nil, hdr); w.Code != http.StatusOK {
		t.Fatalf("detail: %d", w.Code)
	}
	w = h.do(t, http.MethodGet, "/api/users/me/feedbacks", nil, hdr)
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if list.TotalUnread != 0 || list.Items[0].Unread {
		t.Fatalf("read-clear failed: %+v", list)
	}
}

func TestFeedback_UserReplyOnClosedIs409(t *testing.T) {
	h := newFeedbackHarness(t)
	hdr := h.userToken(t)
	adopted := uint64(7)
	id := h.seedFeedback(nil, &adopted)
	if _, err := h.store.PatchFeedbackAdmin(context.Background(), id, true, nil); err != nil {
		t.Fatalf("close: %v", err)
	}
	w := h.do(t, http.MethodPost, "/api/users/me/feedbacks/"+strconv.FormatUint(id, 10)+"/replies", map[string]any{"content": "还想说"}, hdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("closed reply: %d, want 409", w.Code)
	}
	if body := w.Body.String(); !strings.Contains(body, "feedback_closed") {
		t.Fatalf("body = %s", body)
	}
}

func TestFeedback_UploadContract(t *testing.T) {
	h := newFeedbackHarness(t)
	hdr := h.userToken(t)
	png := append([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}, make([]byte, 64)...)

	multipartBody := func(name string, payload []byte, contentType string) ([]byte, string) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		fw, _ := mw.CreateFormFile("file", name)
		_, _ = fw.Write(payload)
		_ = mw.Close()
		if contentType == "" {
			contentType = mw.FormDataContentType()
		}
		return buf.Bytes(), contentType
	}
	doUpload := func(t *testing.T, payload []byte) *httptest.ResponseRecorder {
		t.Helper()
		raw, ct := multipartBody("shot.png", payload, "")
		r := httptest.NewRequest(http.MethodPost, "/api/users/me/feedback-images", bytes.NewReader(raw))
		r.Header.Set("Content-Type", ct)
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.svc.Router().ServeHTTP(w, r)
		return w
	}

	// Bucket not configured → 503.
	h.images.configured = false
	if w := doUpload(t, png); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured upload: %d, want 503", w.Code)
	}
	h.images.configured = true

	// Oversize → 413 (10MB boundary).
	if w := doUpload(t, append(png, make([]byte, feedbackImageMaxBytes-len(png)+1)...)); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize upload: %d, want 413", w.Code)
	}
	// Non-image → 415.
	if w := doUpload(t, []byte("just text, definitely not an image")); w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("text upload: %d, want 415", w.Code)
	}
	// Happy path: key belongs to the caller's namespace.
	w := doUpload(t, png)
	if w.Code != http.StatusOK {
		t.Fatalf("upload: %d (body=%s)", w.Code, w.Body.String())
	}
	var resp feedbackImageUploadResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.HasPrefix(resp.CosKey, "feedback/"+h.user+"/") || !strings.HasSuffix(resp.CosKey, ".png") {
		t.Fatalf("key = %q", resp.CosKey)
	}
	if len(h.images.uploaded[resp.CosKey]) != len(png) {
		t.Fatal("uploaded bytes must round-trip")
	}
}

func TestFeedback_AdminListFilters(t *testing.T) {
	h := newFeedbackHarness(t)
	admin := h.adminToken(t)
	h.store.names[h.user] = "跑者小张"
	images := `["feedback/` + h.user + `/a.png"]`
	h.seedFeedback(&images, nil)

	w := h.do(t, http.MethodGet, "/api/admin/feedbacks?type=bug", nil, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("admin list: %d", w.Code)
	}
	var list feedbackAdminListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(list.Items) != 1 || list.Items[0].User.Name != "跑者小张" {
		t.Fatalf("items = %+v", list.Items)
	}
	if len(list.Items[0].ImageURLs) != 1 || list.Items[0].Images[0] != "feedback/"+h.user+"/a.png" {
		t.Fatalf("image must render: %+v", list.Items[0])
	}
	// Filters that match nothing are fine; invalid ones are 422.
	if w := h.do(t, http.MethodGet, "/api/admin/feedbacks?type=suggestion", nil, admin); w.Code != http.StatusOK {
		t.Fatalf("type filter: %d", w.Code)
	}
	if w := h.do(t, http.MethodGet, "/api/admin/feedbacks?type=nope", nil, admin); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad type filter: %d, want 422", w.Code)
	}
	if w := h.do(t, http.MethodGet, "/api/admin/feedbacks?adopted=maybe", nil, admin); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad adopted filter: %d, want 422", w.Code)
	}
}

func TestFeedback_AdminPatchRules(t *testing.T) {
	h := newFeedbackHarness(t)
	admin := h.adminToken(t)
	id := h.seedFeedback(nil, nil)
	feature := h.roadmap.seed(&storage.RoadmapFeature{Title: "深色模式", Status: storage.RoadmapStatusBacklog})
	path := "/api/admin/feedbacks/" + strconv.FormatUint(id, 10)

	// Only status=closed is a legal status write.
	if w := h.do(t, http.MethodPatch, path, map[string]any{"status": "replied"}, admin); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=replied: %d, want 422", w.Code)
	}
	// An unknown roadmap feature is refused.
	if w := h.do(t, http.MethodPatch, path, map[string]any{"adopted_feature_id": 999999}, admin); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown feature: %d, want 422", w.Code)
	}
	// Explicit null is a clear attempt and must fail.
	if w := h.do(t, http.MethodPatch, path, []byte(`{"adopted_feature_id":null}`), admin); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("clear attempt: %d, want 422", w.Code)
	}
	// A valid feature id + close goes through; the adoption is one-way.
	if w := h.do(t, http.MethodPatch, path, map[string]any{"status": "closed", "adopted_feature_id": feature}, admin); w.Code != http.StatusOK {
		t.Fatalf("valid patch: %d (body=%s)", w.Code, w.Body.String())
	}
	if row := h.store.feedbacks[id]; row.Status != storage.FeedbackStatusClosed || row.AdoptedFeatureID == nil || *row.AdoptedFeatureID != feature {
		t.Fatalf("row = %+v", row)
	}
	if w := h.do(t, http.MethodPatch, path, map[string]any{"adopted_feature_id": 1}, admin); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("re-adopt: %d, want 422", w.Code)
	}
}

func TestFeedback_AdminDetailThread(t *testing.T) {
	h := newFeedbackHarness(t)
	admin := h.adminToken(t)
	id := h.seedFeedback(nil, nil)
	if err := h.store.CreateAdminFeedbackReply(context.Background(), &storage.FeedbackReply{
		FeedbackID: id, Author: storage.FeedbackAuthorAdmin, Content: "官方",
	}); err != nil {
		t.Fatalf("reply: %v", err)
	}
	w := h.do(t, http.MethodGet, "/api/admin/feedbacks/"+strconv.FormatUint(id, 10), nil, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("detail: %d", w.Code)
	}
	var detail feedbackAdminDetailResponse
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(detail.Replies) != 1 || detail.Replies[0].Author != storage.FeedbackAuthorAdmin {
		t.Fatalf("thread = %+v", detail)
	}
	if w := h.do(t, http.MethodGet, "/api/admin/feedbacks/424242", nil, admin); w.Code != http.StatusNotFound {
		t.Fatalf("missing detail: %d, want 404", w.Code)
	}
}

// TestAccountErase_FeedbackImagesFailOpen pins the erasure sweep: listed keys
// are deleted after the DB sweep, and a broken bucket never fails the erase.
func TestAccountErase_FeedbackImagesFailOpen(t *testing.T) {
	h := newFeedbackHarness(t)
	admin := h.adminToken(t)
	h.seedFeedback(&[]string{"feedback/" + h.user + "/a.png"}[0], nil)

	// The eraser derives the lister/deleter from the service config; rebuild
	// with a store that also implements FeedbackImageKeys.
	lister := &fakeFeedbackImageLister{fakeUserStore: newFakeUserStore(), keys: []string{"feedback/" + h.user + "/a.png", "feedback/" + h.user + "/b.png"}}
	h.images.deleteErr["feedback/"+h.user+"/a.png"] = errors.New("cos down")
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&h.key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	h.svc = NewService(Config{
		Auth:                NewAuthenticator(testToken, verifier),
		UserStore:           lister,
		AccountDeleter:      &fakeAccountDeleter{},
		AdminAccountDeleter: &fakeAdminDeleter{},
		CoachDataDeleter:    &fakeCoachDeleter{counts: map[string]int64{}},
		UserDataDirRemover:  &fakeDirRemover{removed: true},
		DeletionAuditStore:  &fakeAuditStore{},
		FeedbackImages:      h.images,
	})

	w := h.do(t, http.MethodDelete, "/api/admin/users/"+h.user, nil, admin)
	if w.Code != http.StatusNoContent {
		t.Fatalf("erase with broken cos: %d, want 204 (body=%s)", w.Code, w.Body.String())
	}
	if len(h.images.attempted) != 2 {
		t.Fatalf("attempted = %v, want both keys attempted (fail-open)", h.images.attempted)
	}
	if len(h.images.deleted) != 1 {
		t.Fatalf("deleted = %v, want only the healthy key", h.images.deleted)
	}
	if lister.deletedUser != h.user {
		t.Fatalf("db sweep missing: %q", lister.deletedUser)
	}
}

// fakeFeedbackImageLister layers FeedbackImageKeys over the erasure fake so
// the optional port assertion in newAccountEraser succeeds.
type fakeFeedbackImageLister struct {
	*fakeUserStore
	keys []string
}

func (f *fakeFeedbackImageLister) FeedbackImageKeys(context.Context, string) ([]string, error) {
	return f.keys, nil
}
