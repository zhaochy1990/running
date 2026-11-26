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
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/storage"
)

func TestE2E_ManualStrengthActivity(t *testing.T) {
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run the manual strength E2E")
	}
	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.AutoMigrateWatch(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := store.AutoMigrateUserDeletionAudit(t.Context()); err != nil {
		t.Fatal(err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewService(Config{
		Auth:                NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
		ActivityStore:       store,
		ManualStrengthStore: store,
	})
	server := httptest.NewServer(svc.Router())
	t.Cleanup(server.Close)
	harness := activityHarness{key: key}
	owner, other, recordID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	ownerAuth, otherAuth := harness.bearer(t, owner), harness.bearer(t, other)
	ownerList := "/api/" + owner + "/activities"
	ownerRecord := ownerList + "/manual-strength/" + recordID
	otherRecord := "/api/" + other + "/activities/manual-strength/" + recordID

	send := func(method, path string, headers map[string]string, payload any, want int) []byte {
		t.Helper()
		var body io.Reader
		if payload != nil {
			content, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			body = bytes.NewReader(content)
		}
		request, err := http.NewRequestWithContext(t.Context(), method, server.URL+path, body)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		data, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != want {
			t.Fatalf("%s %s: status %d, want %d: %s", method, path, response.StatusCode, want, data)
		}
		return data
	}
	decodeRecord := func(body []byte) manualStrengthDTO {
		t.Helper()
		var record manualStrengthDTO
		if err := json.Unmarshal(body, &record); err != nil {
			t.Fatal(err)
		}
		return record
	}

	start := time.Date(2026, 3, 31, 15, 58, 0, 0, time.UTC)
	write := manualStrengthPayload{
		MutationID: uuid.NewString(), StartedAt: &start, Name: "跨午夜训练", Note: "两种动作",
		Actions: []storage.ManualStrengthAction{
			{Name: "深蹲", Sets: []storage.ManualStrengthSet{
				{Load: "25 + 杠", LoadUnit: "kg", Quantity: 8, QuantityUnit: "reps"},
				{LoadUnit: "lb", Quantity: 9, QuantityUnit: "reps"},
			}},
			{Name: "平板支撑", Sets: []storage.ManualStrengthSet{
				{LoadUnit: "bodyweight", Quantity: 40, QuantityUnit: "seconds"},
			}},
		},
	}
	deletedID := uuid.NewString()
	now := time.Now().UTC()
	if err := store.StartUserDeletionAudit(t.Context(), &storage.UserDeletionAudit{
		ID: uuid.NewString(), UserID: deletedID, ActorID: deletedID,
		Status: storage.DeletionStatusCompleted, StrideDeletedAt: &now, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	deletedRecord := "/api/" + deletedID + "/activities/manual-strength/" + uuid.NewString()
	send(http.MethodPut, deletedRecord, harness.bearer(t, deletedID), write, http.StatusNotFound)
	send(http.MethodGet, ownerRecord, nil, nil, http.StatusUnauthorized)
	send(http.MethodPut, ownerRecord, otherAuth, write, http.StatusForbidden)
	first := decodeRecord(send(http.MethodPut, ownerRecord, ownerAuth, write, http.StatusOK))
	if first.ID != recordID || first.Revision != 1 || first.Source != "manual_strength" ||
		!first.StartedAt.Equal(start) || !reflect.DeepEqual(first.Actions, write.Actions) {
		t.Fatalf("first save: %+v", first)
	}
	send(http.MethodGet, ownerRecord, otherAuth, nil, http.StatusForbidden)
	send(http.MethodGet, otherRecord, otherAuth, nil, http.StatusNotFound)
	send(http.MethodPut, otherRecord, otherAuth, write, http.StatusNotFound)
	replayed := decodeRecord(send(http.MethodPut, ownerRecord, ownerAuth, write, http.StatusOK))
	if !reflect.DeepEqual(first, replayed) {
		t.Fatalf("retry changed saved version: first=%+v retry=%+v", first, replayed)
	}
	var initialList activitiesListResponse
	if err := json.Unmarshal(send(http.MethodGet, ownerList+"?include=manual_strength", ownerAuth, nil, http.StatusOK), &initialList); err != nil {
		t.Fatal(err)
	}
	if len(initialList.Activities) != 1 || !reflect.DeepEqual(initialList.Activities[0].ManualStrengthSummary, &manualStrengthSummaryDTO{ActionCount: 2, SetCount: 3}) {
		t.Fatalf("initial list counts: %+v", initialList.Activities)
	}

	edit := write
	edit.MutationID = uuid.NewString()
	edit.StartedAt = nil
	edit.Revision = first.Revision
	edit.Note = "更正训练备注"
	edit.Actions = []storage.ManualStrengthAction{
		{Name: "坐姿划船", Sets: []storage.ManualStrengthSet{{LoadUnit: "kg", QuantityUnit: "reps"}}},
	}
	send(http.MethodPut, ownerRecord, ownerAuth, edit, http.StatusBadRequest)
	got := decodeRecord(send(http.MethodGet, ownerRecord, ownerAuth, nil, http.StatusOK))
	if !reflect.DeepEqual(first, got) {
		t.Fatalf("invalid write changed the stored record: %+v", got)
	}
	edit.Actions[0].Sets[0].Quantity = 12
	saved := decodeRecord(send(http.MethodPut, ownerRecord, ownerAuth, edit, http.StatusOK))
	if saved.Revision != 2 || saved.Note != edit.Note || !saved.StartedAt.Equal(first.StartedAt) ||
		!saved.EndedAt.Equal(first.EndedAt) || !reflect.DeepEqual(saved.Actions, edit.Actions) {
		t.Fatalf("history edit: %+v", saved)
	}
	send(http.MethodPut, ownerRecord, ownerAuth, write, http.StatusConflict)

	var list activitiesListResponse
	data := send(http.MethodGet, ownerList+"?include=manual_strength&date_from=2026-03-31&date_to=2026-03-31", ownerAuth, nil, http.StatusOK)
	if err := json.Unmarshal(data, &list); err != nil {
		t.Fatal(err)
	}
	if list.Total != 1 || len(list.Activities) != 1 || list.Activities[0].LabelID != recordID ||
		list.Activities[0].Date[:10] != "2026-03-31" || list.Activities[0].Source != "manual_strength" ||
		!reflect.DeepEqual(list.Activities[0].ManualStrengthSummary, &manualStrengthSummaryDTO{ActionCount: 1, SetCount: 1}) ||
		list.MonthlySummaries["2026-03"].ActivityCount != 1 {
		t.Fatalf("activity list after history edit: %+v", list)
	}
}
