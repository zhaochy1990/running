// feedback_test.go covers the feedback store semantics against a live MySQL
// (STRIDE_WORKER_TEST_MYSQL_DSN), matching the other storage integration
// tests: thread ordering, the unread read-clear cycle, the admin-reply
// open→replied side effect, the one-way adopted_feature_id, the trace→image
// callback resolution and the erasure cascade.
package storage

import (
	"context"
	"testing"
	"time"

	"encoding/json"

	"github.com/google/uuid"
)

func openFeedbackTestStore(t *testing.T) *Store {
	t.Helper()
	st := openTestStore(t)
	if err := st.AutoMigrateFeedback(context.Background()); err != nil {
		t.Fatalf("automigrate feedback: %v", err)
	}
	return st
}

func TestFeedback_ThreadLifecycle(t *testing.T) {
	st := openFeedbackTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	if err := st.CreateFeedback(ctx, &Feedback{
		UserID: uid, Type: FeedbackTypeBug, Content: "首页崩溃",
		ClientVersion: "1.2.3", Status: FeedbackStatusOpen, ModText: FeedbackModPass,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	feedback, err := st.ListFeedbacksByUser(ctx, uid)
	if err != nil || len(feedback) != 1 {
		t.Fatalf("list: %v %d", err, len(feedback))
	}
	id := feedback[0].ID

	// Foreign user cannot see the row.
	if _, err := st.GetFeedback(ctx, uuid.NewString(), id); err != ErrFeedbackNotFound {
		t.Fatalf("foreign get = %v, want ErrFeedbackNotFound", err)
	}
	row, err := st.GetFeedback(ctx, uid, id)
	if err != nil || row.Status != FeedbackStatusOpen {
		t.Fatalf("get: %v %+v", err, row)
	}

	// Admin reply flips open→replied and creates an unread badge.
	if err := st.CreateAdminFeedbackReply(ctx, &FeedbackReply{
		FeedbackID: id, Author: FeedbackAuthorAdmin, Content: "收到，排查中",
	}); err != nil {
		t.Fatalf("admin reply: %v", err)
	}
	unread, err := st.FeedbackUnreadCounts(ctx, uid)
	if err != nil || unread[id] != 1 {
		t.Fatalf("unread: %v %+v", err, unread)
	}
	got, err := st.GetFeedback(ctx, uid, id)
	if err != nil || got.Status != FeedbackStatusReplied {
		t.Fatalf("status after admin reply: %v %q", err, got.Status)
	}

	// A user follow-up never changes the status and adds no unread.
	if err := st.CreateFeedbackReply(ctx, &FeedbackReply{
		FeedbackID: id, Author: FeedbackAuthorUser, Content: "补充截图",
	}); err != nil {
		t.Fatalf("user reply: %v", err)
	}
	if unread, _ := st.FeedbackUnreadCounts(ctx, uid); unread[id] != 1 {
		t.Fatalf("user reply must not create unread: %v", unread)
	}

	// 读即清: the owner's detail read clears the admin unread rows.
	if err := st.MarkFeedbackRepliesRead(ctx, id); err != nil {
		t.Fatalf("mark read: %v", err)
	}
	if unread, _ := st.FeedbackUnreadCounts(ctx, uid); len(unread) != 0 {
		t.Fatalf("unread after read-clear: %v", unread)
	}

	lasts, err := st.LastFeedbackReplies(ctx, []uint64{id})
	if err != nil || lasts[id].Content != "补充截图" {
		t.Fatalf("last reply: %v %+v", err, lasts[id])
	}
}

func TestFeedback_PatchAdmin_OneWayAdoption(t *testing.T) {
	st := openFeedbackTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	if err := st.CreateFeedback(ctx, &Feedback{
		UserID: uid, Type: FeedbackTypeSuggestion, Content: "想要深色模式",
		Status: FeedbackStatusOpen, ModText: FeedbackModUnchecked,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	id := (func() uint64 {
		rows, _ := st.ListFeedbacksByUser(ctx, uid)
		return rows[0].ID
	})()

	adopted := uint64(42)
	row, err := st.PatchFeedbackAdmin(ctx, id, true, &adopted)
	if err != nil || row.Status != FeedbackStatusClosed || row.AdoptedFeatureID == nil || *row.AdoptedFeatureID != 42 {
		t.Fatalf("patch: %v %+v", err, row)
	}
	// One-way: moving or clearing the adopted id is refused.
	if _, err := st.PatchFeedbackAdmin(ctx, id, false, &adopted); err != ErrFeedbackAdoptedImmutable {
		t.Fatalf("re-adopt = %v, want ErrFeedbackAdoptedImmutable", err)
	}
	// Status=closed on an already-closed row is the legal no-op.
	if _, err := st.PatchFeedbackAdmin(ctx, id, true, nil); err != nil {
		t.Fatalf("re-close: %v", err)
	}
	if _, err := st.PatchFeedbackAdmin(ctx, 999999, true, nil); err != ErrFeedbackNotFound {
		t.Fatalf("missing patch = %v, want ErrFeedbackNotFound", err)
	}
}

func TestFeedback_ImageCheckCallback(t *testing.T) {
	st := openFeedbackTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	key1, key2 := "feedback/"+uid+"/a.png", "feedback/"+uid+"/b.png"
	imgs := `["` + key1 + `","` + key2 + `"]`
	if err := st.CreateFeedback(ctx, &Feedback{
		UserID: uid, Type: FeedbackTypeSuggestion, Content: "带图反馈",
		Status: FeedbackStatusOpen, ModText: FeedbackModPass, Images: &imgs,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	id := (func() uint64 {
		rows, _ := st.ListFeedbacksByUser(ctx, uid)
		return rows[0].ID
	})()

	// Dispatch: both images pending + trace correlation rows.
	if err := st.UpdateFeedbackModImages(ctx, id, map[string]string{
		key1: FeedbackModPending, key2: FeedbackModPending,
	}); err != nil {
		t.Fatalf("set pending: %v", err)
	}
	if err := st.RecordFeedbackImageChecks(ctx, id, []FeedbackImageCheck{
		{TraceID: "trace-1-" + uid, CosKey: key1, CreatedAt: time.Now().UTC()},
		{TraceID: "trace-2-" + uid, CosKey: key2, CreatedAt: time.Now().UTC()},
	}); err != nil {
		t.Fatalf("record checks: %v", err)
	}

	if err := st.ApplyFeedbackImageCheck(ctx, "trace-1-"+uid, FeedbackModRisky); err != nil {
		t.Fatalf("apply: %v", err)
	}
	row, err := st.GetFeedbackByID(ctx, id)
	if err != nil {
		t.Fatalf("get by id: %v", err)
	}
	states := decodeTestModImages(t, row.ModImages)
	if states[key1] != FeedbackModRisky || states[key2] != FeedbackModPending {
		t.Fatalf("states = %v, want key1 risky + key2 pending", states)
	}
	// The consumed trace is gone; a replayed push is a no-op.
	if err := st.ApplyFeedbackImageCheck(ctx, "trace-1-"+uid, FeedbackModPass); err != nil {
		t.Fatalf("replay: %v", err)
	}
	if states = decodeTestModImages(t, row.ModImages); states[key1] != FeedbackModRisky {
		t.Fatalf("replay must not overwrite: %v", states)
	}
	// Erasure lists every referenced key for the COS sweep.
	keys, err := st.FeedbackImageKeys(ctx, uid)
	if err != nil || len(keys) != 2 {
		t.Fatalf("image keys: %v %v", err, keys)
	}
}

func TestFeedback_AdminListFilterAndName(t *testing.T) {
	st := openFeedbackTestStore(t)
	ctx := context.Background()
	// The admin surface is global, so other tests' rows (same package run or
	// a previous one against this database) would leak into the counts.
	if err := st.db.WithContext(ctx).Exec("DELETE FROM feedbacks").Error; err != nil {
		t.Fatalf("clean feedbacks: %v", err)
	}
	uid := uuid.NewString()
	if err := st.UpsertUserProfile(ctx, &UserProfile{UserID: uid, DisplayName: "跑者小张"}); err != nil {
		t.Fatalf("profile: %v", err)
	}
	risky := `[{"suggest":"` + FeedbackModRisky + `"}]`
	if err := st.CreateFeedback(ctx, &Feedback{
		UserID: uid, Type: FeedbackTypeBug, Content: "bug 单",
		Status: FeedbackStatusOpen, ModText: FeedbackModRisky, ModImages: &risky,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := st.CreateFeedback(ctx, &Feedback{
		UserID: uid, Type: FeedbackTypeSuggestion, Content: "建议单",
		Status: FeedbackStatusClosed, ModText: FeedbackModUnchecked,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	rows, err := st.ListFeedbacksAdmin(ctx, FeedbackFilter{Type: FeedbackTypeBug})
	if err != nil || len(rows) != 1 || rows[0].UserName != "跑者小张" {
		t.Fatalf("type filter: %v %+v", err, rows)
	}
	if rows, _ := st.ListFeedbacksAdmin(ctx, FeedbackFilter{Status: FeedbackStatusClosed}); len(rows) != 1 || rows[0].Type != FeedbackTypeSuggestion {
		t.Fatalf("status filter: %+v", rows)
	}
	if rows, _ := st.ListFeedbacksAdmin(ctx, FeedbackFilter{Moderation: FeedbackModRisky}); len(rows) != 1 {
		t.Fatalf("moderation filter (text): %+v", rows)
	}
	yes := true
	if rows, _ = st.ListFeedbacksAdmin(ctx, FeedbackFilter{Adopted: &yes}); len(rows) != 0 {
		t.Fatalf("adopted filter before adoption: %+v", rows)
	}
	id := func() uint64 {
		r, _ := st.ListFeedbacksAdmin(ctx, FeedbackFilter{Type: FeedbackTypeBug})
		return r[0].ID
	}()
	if _, err := st.PatchFeedbackAdmin(ctx, id, false, &id); err != nil { // any existing uint64 works as a stand-in feature id
		t.Fatalf("adopt: %v", err)
	}
	if rows, _ = st.ListFeedbacksAdmin(ctx, FeedbackFilter{Adopted: &yes}); len(rows) != 1 {
		t.Fatalf("adopted filter after adoption: %+v", rows)
	}
}

func TestFeedback_DeleteUserDataCascades(t *testing.T) {
	st := openFeedbackTestStore(t)
	ctx := context.Background()
	// DeleteUserData sweeps every user-owned table, so the schema must be
	// complete (same list as the coverage guard test).
	for _, migrate := range []func(context.Context) error{
		st.AutoMigrateWatch, st.AutoMigrateUsers, st.AutoMigrateGoals,
		st.AutoMigrateMasterPlan, st.AutoMigrateWeeklyPlan, st.AutoMigrateWeeklyFeedback,
		st.AutoMigrateBodyComposition, st.AutoMigrateTeamLikes, st.AutoMigrateScheduledWorkout,
		st.AutoMigrateUserDeletionAudit, st.AutoMigrateRaceFavorites, st.AutoMigrateRacePlans,
		st.AutoMigrateRaceStrategies, st.AutoMigrateUserCustomRaces, st.AutoMigrateRoadmap,
		st.AutoMigrateFeedback, st.AutoMigrateHomeCity, st.AutoMigrateProviderEvents,
	} {
		if err := migrate(ctx); err != nil {
			t.Fatalf("migrate: %v", err)
		}
	}
	uid := uuid.NewString()
	imgs := `["feedback/` + uid + `/a.png"]`
	if err := st.CreateFeedback(ctx, &Feedback{
		UserID: uid, Type: FeedbackTypeBug, Content: "待级联删除",
		Status: FeedbackStatusOpen, ModText: FeedbackModUnchecked, Images: &imgs,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	id := (func() uint64 {
		rows, _ := st.ListFeedbacksByUser(ctx, uid)
		return rows[0].ID
	})()
	if err := st.CreateAdminFeedbackReply(ctx, &FeedbackReply{
		FeedbackID: id, Author: FeedbackAuthorAdmin, Content: "回复",
	}); err != nil {
		t.Fatalf("reply: %v", err)
	}
	if err := st.RecordFeedbackImageChecks(ctx, id, []FeedbackImageCheck{
		{TraceID: "trace-del-" + uid, CosKey: "feedback/" + uid + "/a.png", CreatedAt: time.Now().UTC()},
	}); err != nil {
		t.Fatalf("record: %v", err)
	}

	if err := st.DeleteUserData(ctx, uid); err != nil {
		t.Fatalf("delete user data: %v", err)
	}
	if rows, _ := st.ListFeedbacksByUser(ctx, uid); len(rows) != 0 {
		t.Fatal("feedbacks must be erased")
	}
	var replies, checks int64
	if err := st.db.Model(&FeedbackReply{}).Where("feedback_id = ?", id).Count(&replies).Error; err != nil || replies != 0 {
		t.Fatalf("replies must cascade: %v %d", err, replies)
	}
	if err := st.db.Model(&FeedbackImageCheck{}).Where("feedback_id = ?", id).Count(&checks).Error; err != nil || checks != 0 {
		t.Fatalf("image checks must cascade: %v %d", err, checks)
	}
}

// decodeTestModImages parses the mod_images JSON column.
func decodeTestModImages(t *testing.T, encoded *string) map[string]string {
	t.Helper()
	out := map[string]string{}
	if encoded == nil {
		return out
	}
	if err := json.Unmarshal([]byte(*encoded), &out); err != nil {
		t.Fatalf("decode mod_images: %v", err)
	}
	return out
}
