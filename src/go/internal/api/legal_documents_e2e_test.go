package api

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/storage"
)

// End-to-end: a real HTTP server (httptest) over the REAL MySQL store, driven
// with real HTTP requests. Gated on STRIDE_WORKER_TEST_MYSQL_DSN (the same local
// MySQL the storage tests use) and skipped otherwise. CI runs it explicitly —
// see the "Compliance-declaration end-to-end tests" step in .github/workflows/ci.yml.
//
// The single seam under test is the HTTP boundary: these tests assert status
// codes and response semantics (version increment, draft uniqueness, publish
// visibility, auth tier) and never reach into the store or the SQL behind it.
//
// State handling: the five declaration types are a fixed key space, so this test
// cannot isolate itself the way the master-plan E2E isolates itself per user. It
// therefore touches no SQL of its own and instead observes the starting state
// through the API, asserts relative to it, and cleans up its draft through the
// API — so it is re-runnable against a database that already holds versions.

const (
	e2eDeclarationType = "user_agreement"
	e2eAdminSubject    = "11111111-1111-4111-8111-111111111111"
	// e2eMissingID is a syntactically valid version id that is never created.
	e2eMissingID = "00000000-0000-4000-8000-000000000000"
)

// wantDocTypes is the public contract: all five declaration types, in order.
var wantDocTypes = []string{
	"user_agreement",
	"privacy_policy",
	"child_protection",
	"personal_info_collection",
	"third_party_sharing",
}

type legalE2EServer struct {
	base string
	key  *rsa.PrivateKey
}

func newLegalE2EServer(t *testing.T) *legalE2EServer {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run the declaration E2E")
	}
	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.AutoMigrateLegalDocuments(t.Context()); err != nil {
		t.Fatalf("automigrate: %v", err)
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	svc := NewService(Config{
		Auth:               NewAuthenticator(testToken, verifier),
		LegalDocumentStore: store,
	})
	srv := httptest.NewServer(svc.Router())
	t.Cleanup(srv.Close)
	return &legalE2EServer{base: srv.URL, key: key}
}

// adminToken mints a JWT for the separate admin audience. TierAdmin requires
// both the dedicated audience and role=admin (see JWTVerifier.Verify).
func (e *legalE2EServer) adminToken(t *testing.T) string {
	t.Helper()
	return e.token(t, e2eAdminSubject, testAdminAudience, "admin")
}

// userToken mints an ordinary user JWT.
func (e *legalE2EServer) userToken(t *testing.T) string {
	t.Helper()
	return e.token(t, e2eAdminSubject, testAudience, "")
}

func (e *legalE2EServer) token(t *testing.T, sub, aud, role string) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": aud,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	if role != "" {
		claims["role"] = role
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(e.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

// send performs a real HTTP request. token=="" means no Authorization header.
func (e *legalE2EServer) send(t *testing.T, method, path, token string, body any) (int, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, e.base+path, reader)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, raw
}

func decodeJSON(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}
	return out
}

// declarationEntry pulls one doc_type's entry out of a list response.
func declarationEntry(t *testing.T, raw []byte, docType string) map[string]any {
	t.Helper()
	envelope := decodeJSON(t, raw)
	entries, ok := envelope["declarations"].([]any)
	if !ok {
		t.Fatalf("declarations is not a list: %s", raw)
	}
	for _, item := range entries {
		entry, _ := item.(map[string]any)
		if entry["doc_type"] == docType {
			return entry
		}
	}
	t.Fatalf("doc_type %q missing from %s", docType, raw)
	return nil
}

// versionsOf returns a doc_type's version history, newest first.
func (e *legalE2EServer) versionsOf(t *testing.T, path, admin string) []map[string]any {
	t.Helper()
	code, body := e.send(t, http.MethodGet, path, admin, nil)
	if code != http.StatusOK {
		t.Fatalf("versions: code=%d body=%s", code, body)
	}
	raw, _ := decodeJSON(t, body)["versions"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		entry, _ := item.(map[string]any)
		out = append(out, entry)
	}
	return out
}

// publicVersion returns the version the public endpoint currently serves, and
// whether the type is published at all.
func (e *legalE2EServer) publicVersion(t *testing.T, docType string) (int, bool) {
	t.Helper()
	code, body := e.send(t, http.MethodGet, "/api/declarations/"+docType, "", nil)
	if code == http.StatusNotFound {
		return 0, false
	}
	if code != http.StatusOK {
		t.Fatalf("public get %s: code=%d body=%s", docType, code, body)
	}
	version, _ := decodeJSON(t, body)["version"].(float64)
	return int(version), true
}

// clearDraft removes any draft left behind by an earlier (possibly aborted) run,
// through the admin API rather than by touching the table.
func (e *legalE2EServer) clearDraft(t *testing.T, path, admin string) {
	t.Helper()
	for _, entry := range e.versionsOf(t, path, admin) {
		if entry["status"] != "draft" {
			continue
		}
		id, _ := entry["id"].(string)
		if code, body := e.send(t, http.MethodDelete, "/api/admin/declarations/versions/"+id, admin, nil); code != http.StatusNoContent {
			t.Fatalf("clear leftover draft: code=%d body=%s", code, body)
		}
	}
}

func TestE2E_LegalDeclarations(t *testing.T) {
	e := newLegalE2EServer(t)
	admin := e.adminToken(t)
	user := e.userToken(t)
	base := "/api/admin/declarations/" + e2eDeclarationType
	versionsPath := base + "/versions"

	// --- Both lists always carry the full five-type contract.
	code, body := e.send(t, http.MethodGet, "/api/declarations", "", nil)
	if code != http.StatusOK {
		t.Fatalf("public list: code=%d body=%s", code, body)
	}
	if entries, _ := decodeJSON(t, body)["declarations"].([]any); len(entries) != len(wantDocTypes) {
		t.Fatalf("public list: got %d entries, want %d", len(entries), len(wantDocTypes))
	}
	for _, docType := range wantDocTypes {
		if entry := declarationEntry(t, body, docType); entry == nil {
			t.Fatalf("public list missing %q", docType)
		}
	}

	code, body = e.send(t, http.MethodGet, "/api/admin/declarations", admin, nil)
	if code != http.StatusOK {
		t.Fatalf("admin list: code=%d body=%s", code, body)
	}
	for _, docType := range wantDocTypes {
		declarationEntry(t, body, docType)
	}

	// --- Unknown doc_type is rejected on both surfaces.
	if code, _ := e.send(t, http.MethodGet, "/api/declarations/not_a_type", "", nil); code != http.StatusBadRequest {
		t.Errorf("unknown public doc_type: code=%d, want 400", code)
	}
	if code, _ := e.send(t, http.MethodGet, "/api/admin/declarations/not_a_type/versions", admin, nil); code != http.StatusBadRequest {
		t.Errorf("unknown admin doc_type: code=%d, want 400", code)
	}
	if code, _ := e.send(t, http.MethodPost, "/api/admin/declarations/not_a_type/draft", admin, map[string]string{
		"title": "x", "content_markdown": "y",
	}); code != http.StatusBadRequest {
		t.Errorf("unknown doc_type draft: code=%d, want 400", code)
	}

	// --- Auth tiers, on read AND on every mutation.
	if code, _ := e.send(t, http.MethodGet, "/api/admin/declarations", "", nil); code != http.StatusUnauthorized {
		t.Errorf("admin list without token: code=%d, want 401", code)
	}
	if code, _ := e.send(t, http.MethodGet, "/api/admin/declarations", user, nil); code != http.StatusForbidden {
		t.Errorf("admin list as user: code=%d, want 403", code)
	}
	draftBody := map[string]string{"title": "无权限", "content_markdown": "x"}
	for _, tc := range []struct {
		name, method, path string
		body               any
	}{
		{"create draft", http.MethodPost, base + "/draft", draftBody},
		{"edit version", http.MethodPatch, "/api/admin/declarations/versions/" + e2eMissingID, draftBody},
		{"publish version", http.MethodPost, "/api/admin/declarations/versions/" + e2eMissingID + "/publish", nil},
		{"delete version", http.MethodDelete, "/api/admin/declarations/versions/" + e2eMissingID, nil},
		{"version detail", http.MethodGet, "/api/admin/declarations/versions/" + e2eMissingID, nil},
	} {
		if code, _ := e.send(t, tc.method, tc.path, "", tc.body); code != http.StatusUnauthorized {
			t.Errorf("%s without token: code=%d, want 401", tc.name, code)
		}
		// A user token must be refused by the tier check, before any lookup —
		// otherwise a 404 would leak whether the id exists.
		if code, _ := e.send(t, tc.method, tc.path, user, tc.body); code != http.StatusForbidden {
			t.Errorf("%s as user: code=%d, want 403", tc.name, code)
		}
	}

	// --- Unknown version id is 404 for an administrator.
	if code, _ := e.send(t, http.MethodGet, "/api/admin/declarations/versions/"+e2eMissingID, admin, nil); code != http.StatusNotFound {
		t.Errorf("unknown version detail: code=%d, want 404", code)
	}
	if code, _ := e.send(t, http.MethodPatch, "/api/admin/declarations/versions/"+e2eMissingID, admin, draftBody); code != http.StatusNotFound {
		t.Errorf("edit unknown version: code=%d, want 404", code)
	}
	if code, _ := e.send(t, http.MethodDelete, "/api/admin/declarations/versions/"+e2eMissingID, admin, nil); code != http.StatusNotFound {
		t.Errorf("delete unknown version: code=%d, want 404", code)
	}
	if code, _ := e.send(t, http.MethodPost, "/api/admin/declarations/versions/"+e2eMissingID+"/publish", admin, nil); code != http.StatusNotFound {
		t.Errorf("publish unknown version: code=%d, want 404", code)
	}

	// --- Observe the starting state, then assert everything relative to it.
	e.clearDraft(t, versionsPath, admin)
	existing := e.versionsOf(t, versionsPath, admin)
	priorMax := 0
	for _, entry := range existing {
		if version, _ := entry["version"].(float64); int(version) > priorMax {
			priorMax = int(version)
		}
	}
	priorPublic, wasPublished := e.publicVersion(t, e2eDeclarationType)

	// --- First draft is next-version and invisible to the public surface.
	code, body = e.send(t, http.MethodPost, base+"/draft", admin, map[string]string{
		"title": "用户协议", "content_markdown": "# 用户协议\n\n第一稿正文。",
	})
	if code != http.StatusCreated {
		t.Fatalf("create draft: code=%d body=%s", code, body)
	}
	first := decodeJSON(t, body)
	if first["version"] != float64(priorMax+1) || first["status"] != "draft" {
		t.Fatalf("first draft: %v (priorMax=%d)", first, priorMax)
	}
	firstID, _ := first["id"].(string)
	if firstID == "" {
		t.Fatal("first draft has no id")
	}
	if first["created_by"] != e2eAdminSubject {
		t.Errorf("created_by=%v, want the admin subject", first["created_by"])
	}

	// The draft must not move the public pointer, whatever it was before.
	if version, published := e.publicVersion(t, e2eDeclarationType); published != wasPublished || version != priorPublic {
		t.Errorf("public state changed after creating a draft: (%d,%t), want (%d,%t)",
			version, published, priorPublic, wasPublished)
	}
	_, body = e.send(t, http.MethodGet, "/api/admin/declarations", admin, nil)
	entry := declarationEntry(t, body, e2eDeclarationType)
	draftMeta, ok := entry["draft"].(map[string]any)
	if !ok || draftMeta["id"] != firstID {
		t.Errorf("admin list should surface the draft: %s", body)
	}

	// --- A second draft for the same type is refused.
	if code, body := e.send(t, http.MethodPost, base+"/draft", admin, map[string]string{
		"title": "重复草稿", "content_markdown": "x",
	}); code != http.StatusConflict {
		t.Errorf("second draft: code=%d body=%s, want 409", code, body)
	}

	// --- Editing the draft keeps the version number and rewrites the body.
	code, body = e.send(t, http.MethodPatch, "/api/admin/declarations/versions/"+firstID, admin, map[string]string{
		"title": "用户协议（修订）", "content_markdown": "# 用户协议\n\n第二稿正文。",
	})
	if code != http.StatusOK {
		t.Fatalf("edit draft: code=%d body=%s", code, body)
	}
	edited := decodeJSON(t, body)
	if edited["version"] != float64(priorMax+1) {
		t.Errorf("edit must not bump version, got %v", edited["version"])
	}
	if edited["content_markdown"] != "# 用户协议\n\n第二稿正文。" {
		t.Errorf("edit did not persist body: %v", edited["content_markdown"])
	}
	// Blank fields are rejected before the store is touched.
	for name, invalid := range map[string]map[string]string{
		"blank title": {"title": "   ", "content_markdown": "y"},
		"blank body":  {"title": "x", "content_markdown": "   "},
	} {
		if code, _ := e.send(t, http.MethodPatch, "/api/admin/declarations/versions/"+firstID, admin, invalid); code != http.StatusBadRequest {
			t.Errorf("edit draft with %s: code=%d, want 400", name, code)
		}
	}

	// --- Publish: effective_at is stamped and the body goes public.
	code, body = e.send(t, http.MethodPost, "/api/admin/declarations/versions/"+firstID+"/publish", admin, nil)
	if code != http.StatusOK {
		t.Fatalf("publish: code=%d body=%s", code, body)
	}
	published := decodeJSON(t, body)
	if published["status"] != "published" || published["effective_at"] == nil {
		t.Fatalf("published row: %v", published)
	}
	effectiveAt, _ := published["effective_at"].(string)

	code, body = e.send(t, http.MethodGet, "/api/declarations/"+e2eDeclarationType, "", nil)
	if code != http.StatusOK {
		t.Fatalf("public get after publish: code=%d body=%s", code, body)
	}
	publicBody := decodeJSON(t, body)
	if publicBody["content_markdown"] != "# 用户协议\n\n第二稿正文。" {
		t.Errorf("public body: %v", publicBody["content_markdown"])
	}
	if publicBody["version"] != float64(priorMax+1) {
		t.Errorf("public version: %v, want %d", publicBody["version"], priorMax+1)
	}
	// The public projection is title/version/effective_at/updated_at + body only.
	// In particular it must not carry the row id or created_by (an administrator
	// identity), which are admin-surface columns.
	for _, leaked := range []string{"id", "created_by", "created_at", "status", "published_at"} {
		if _, present := publicBody[leaked]; present {
			t.Errorf("public body must not expose %q: %s", leaked, body)
		}
	}

	_, body = e.send(t, http.MethodGet, "/api/declarations", "", nil)
	current, ok := declarationEntry(t, body, e2eDeclarationType)["current"].(map[string]any)
	if !ok {
		t.Fatalf("published type should have current meta: %s", body)
	}
	if current["version"] != float64(priorMax+1) || current["title"] != "用户协议（修订）" {
		t.Errorf("public current meta: %v", current)
	}
	if current["effective_at"] != effectiveAt {
		t.Errorf("public effective_at=%v, want %v", current["effective_at"], effectiveAt)
	}
	for _, leaked := range []string{"content_markdown", "id", "created_by", "created_at", "status", "published_at"} {
		if _, present := current[leaked]; present {
			t.Errorf("the public list must not expose %q: %v", leaked, current)
		}
	}

	// --- Published versions are frozen: edit, delete and re-publish are refused.
	if code, _ := e.send(t, http.MethodPatch, "/api/admin/declarations/versions/"+firstID, admin, draftBody); code != http.StatusConflict {
		t.Errorf("edit published: code=%d, want 409", code)
	}
	if code, _ := e.send(t, http.MethodDelete, "/api/admin/declarations/versions/"+firstID, admin, nil); code != http.StatusConflict {
		t.Errorf("delete published: code=%d, want 409", code)
	}
	if code, _ := e.send(t, http.MethodPost, "/api/admin/declarations/versions/"+firstID+"/publish", admin, nil); code != http.StatusConflict {
		t.Errorf("re-publish: code=%d, want 409", code)
	}

	// --- The next draft continues the sequence, and a deleted draft frees its
	// number rather than burning it.
	code, body = e.send(t, http.MethodPost, base+"/draft", admin, map[string]string{
		"title": "用户协议 V2", "content_markdown": "# 用户协议\n\n第二版正文。",
	})
	if code != http.StatusCreated {
		t.Fatalf("create next draft: code=%d body=%s", code, body)
	}
	second := decodeJSON(t, body)
	if second["version"] != float64(priorMax+2) {
		t.Fatalf("next draft version=%v, want %d", second["version"], priorMax+2)
	}
	secondID, _ := second["id"].(string)

	if code, _ := e.send(t, http.MethodDelete, "/api/admin/declarations/versions/"+secondID, admin, nil); code != http.StatusNoContent {
		t.Fatalf("delete draft: code=%d, want 204", code)
	}
	code, body = e.send(t, http.MethodPost, base+"/draft", admin, map[string]string{
		"title": "用户协议 V2", "content_markdown": "# 用户协议\n\n第二版正文。",
	})
	if code != http.StatusCreated {
		t.Fatalf("recreate draft: code=%d body=%s", code, body)
	}
	if version := decodeJSON(t, body)["version"]; version != float64(priorMax+2) {
		t.Fatalf("recreated version=%v, want %d", version, priorMax+2)
	}
	// --- Version history is complete, newest first, and carries no bodies.
	// Checked before the cleanup below so both new versions are still present.
	history := e.versionsOf(t, versionsPath, admin)
	if len(history) < 2 {
		t.Fatalf("version history: got %d entries, want at least 2", len(history))
	}
	if history[0]["version"] != float64(priorMax+2) || history[0]["status"] != "draft" {
		t.Errorf("history should be newest first with the draft on top, got %v/%v",
			history[0]["version"], history[0]["status"])
	}
	sawPublished := false
	for _, row := range history {
		if row["version"] == float64(priorMax+1) && row["status"] == "published" {
			sawPublished = true
		}
		if _, hasBody := row["content_markdown"]; hasBody {
			t.Error("version history must not ship bodies")
		}
	}
	if !sawPublished {
		t.Errorf("history is missing the published V%d: %v", priorMax+1, history)
	}

	// Leave no draft behind so the suite is re-runnable against this database.
	e.clearDraft(t, versionsPath, admin)

	// --- Version detail carries the body; an unknown id is 404 (checked above).
	code, body = e.send(t, http.MethodGet, "/api/admin/declarations/versions/"+firstID, admin, nil)
	if code != http.StatusOK {
		t.Fatalf("version detail: code=%d body=%s", code, body)
	}
	if got := decodeJSON(t, body)["content_markdown"]; got != "# 用户协议\n\n第二稿正文。" {
		t.Errorf("earlier published version changed: %v", got)
	}

	// --- Missing required fields are rejected before touching the store.
	if code, _ := e.send(t, http.MethodPost, base+"/draft", admin, map[string]string{
		"title": "只有标题",
	}); code != http.StatusBadRequest {
		t.Errorf("draft without body: code=%d, want 400", code)
	}

	// A body over the authenticated group's cap is 413 (as elsewhere in the Go
	// API), not a 400 that would misreport "too big" as "malformed".
	if code, _ := e.send(t, http.MethodPost, base+"/draft", admin, map[string]string{
		"title": "过大", "content_markdown": strings.Repeat("x", maxRequestBytes),
	}); code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized draft: code=%d, want 413", code)
	}

	// A title longer than the varchar(255) column is a 400, not a MySQL 1406
	// that would surface as a 500.
	if code, _ := e.send(t, http.MethodPost, base+"/draft", admin, map[string]string{
		"title": strings.Repeat("标", 256), "content_markdown": "y",
	}); code != http.StatusBadRequest {
		t.Errorf("over-long title: code=%d, want 400", code)
	}
}
