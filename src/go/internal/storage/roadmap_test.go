package storage

import (
	"context"
	"testing"
)

// TestRoadmapCanTransition pins the one-way pipeline vocabulary: forward moves
// (skipping included) legal, same-status the no-op, backward refused.
func TestRoadmapCanTransition(t *testing.T) {
	all := []string{RoadmapStatusDraft, RoadmapStatusBacklog, RoadmapStatusAccepted, RoadmapStatusReleased}
	for i, from := range all {
		for j, to := range all {
			want := j > i
			if got := RoadmapCanTransition(from, to); got != want {
				t.Errorf("RoadmapCanTransition(%s, %s) = %v, want %v", from, to, got, want)
			}
		}
	}
	if IsRoadmapFeatureStatus("chicken") || IsRoadmapFeatureStatus("") {
		t.Errorf("IsRoadmapFeatureStatus accepts non-vocabulary tokens")
	}
}

// TestRoadmap_VoteUniqueAndCascade pins the vote table's guarantees against a
// real MySQL: UNIQUE(user_id, feature_id) collapses repeat votes into one row
// (idempotent re-votes), and DeleteRoadmapFeature takes the votes with it.
func TestRoadmap_VoteUniqueAndCascade(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateRoadmap(ctx); err != nil {
		t.Fatalf("automigrate roadmap: %v", err)
	}

	row := &RoadmapFeature{Title: "集成测试想法", Status: RoadmapStatusBacklog}
	if err := st.CreateRoadmapFeature(ctx, row); err != nil {
		t.Fatalf("create feature: %v", err)
	}
	t.Cleanup(func() { _ = st.db.WithContext(ctx).Exec("DELETE FROM roadmap_votes WHERE feature_id = ?", row.ID) })
	t.Cleanup(func() { _ = st.db.WithContext(ctx).Exec("DELETE FROM roadmap_features WHERE id = ?", row.ID) })

	const user = "11111111-2222-4333-8333-333333333333"
	for i := 0; i < 2; i++ { // repeat vote: UNIQUE collapses it
		if err := st.AddRoadmapVote(ctx, user, row.ID); err != nil {
			t.Fatalf("add vote #%d: %v", i, err)
		}
	}
	counts, err := st.RoadmapVoteCounts(ctx)
	if err != nil {
		t.Fatalf("vote counts: %v", err)
	}
	if counts[row.ID] != 1 {
		t.Fatalf("vote count = %d, want 1 (UNIQUE idempotency)", counts[row.ID])
	}
	ids, err := st.RoadmapVoteIDsByUser(ctx, user)
	if err != nil || len(ids) != 1 || ids[0] != row.ID {
		t.Fatalf("vote ids = %v (err %v), want [%d]", ids, err, row.ID)
	}

	if err := st.RemoveRoadmapVote(ctx, user, row.ID); err != nil {
		t.Fatalf("remove vote: %v", err)
	}
	if err := st.RemoveRoadmapVote(ctx, user, row.ID); err != nil { // idempotent
		t.Fatalf("remove vote twice: %v", err)
	}
	if counts, _ = st.RoadmapVoteCounts(ctx); counts[row.ID] != 0 {
		t.Fatalf("vote count after remove = %d, want 0", counts[row.ID])
	}

	// Deleting the feature cascades the votes; a second delete is 404.
	_ = st.AddRoadmapVote(ctx, user, row.ID)
	if err := st.DeleteRoadmapFeature(ctx, row.ID); err != nil {
		t.Fatalf("delete feature: %v", err)
	}
	if counts, _ = st.RoadmapVoteCounts(ctx); counts[row.ID] != 0 {
		t.Fatalf("orphan votes survived feature delete: %d", counts[row.ID])
	}
	if err := st.DeleteRoadmapFeature(ctx, row.ID); err != ErrRoadmapFeatureNotFound {
		t.Fatalf("second delete err = %v, want ErrRoadmapFeatureNotFound", err)
	}
}

// TestRoadmap_ReleaseSnapshotSurvivesErasure pins the release side effects and
// the erasure boundary against a real MySQL: →released freezes the live count
// into votes_snapshot in the same transaction, and DeleteUserData removes the
// erasing user's votes WITHOUT touching the frozen snapshot (roadmap_features
// is global content, votes_snapshot a historical fact).
func TestRoadmap_ReleaseSnapshotSurvivesErasure(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateRoadmap(ctx); err != nil {
		t.Fatalf("automigrate roadmap: %v", err)
	}

	row := &RoadmapFeature{Title: "发布快照", Status: RoadmapStatusBacklog}
	if err := st.CreateRoadmapFeature(ctx, row); err != nil {
		t.Fatalf("create feature: %v", err)
	}
	t.Cleanup(func() { _ = st.db.WithContext(ctx).Exec("DELETE FROM roadmap_votes WHERE feature_id = ?", row.ID) })
	t.Cleanup(func() { _ = st.db.WithContext(ctx).Exec("DELETE FROM roadmap_features WHERE id = ?", row.ID) })

	const erasing = "11111111-2222-4333-8333-333333333333"
	const staying = "22222222-3333-4444-8444-444444444444"
	for _, u := range []string{erasing, staying} {
		if err := st.AddRoadmapVote(ctx, u, row.ID); err != nil {
			t.Fatalf("seed vote %s: %v", u, err)
		}
	}

	if err := st.UpdateRoadmapFeature(ctx, &RoadmapFeature{
		ID: row.ID, Title: row.Title, Status: RoadmapStatusReleased,
	}, true); err != nil {
		t.Fatalf("release update: %v", err)
	}
	released, err := st.GetRoadmapFeature(ctx, row.ID)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if released.VotesSnapshot != 2 || released.ReleasedAt == nil {
		t.Fatalf("released row snapshot=%d released_at=%v, want 2 + set", released.VotesSnapshot, released.ReleasedAt)
	}

	if err := st.DeleteUserData(ctx, erasing); err != nil {
		t.Fatalf("delete user data: %v", err)
	}
	ids, err := st.RoadmapVoteIDsByUser(ctx, erasing)
	if err != nil || len(ids) != 0 {
		t.Fatalf("erasing user votes = %v (err %v), want none", ids, err)
	}
	after, err := st.GetRoadmapFeature(ctx, row.ID)
	if err != nil {
		t.Fatalf("feature after erasure: %v", err)
	}
	if after.VotesSnapshot != 2 || after.ReleasedAt == nil {
		t.Errorf("snapshot changed by erasure: snapshot=%d released_at=%v, want untouched", after.VotesSnapshot, after.ReleasedAt)
	}
	remaining, err := st.RoadmapVoteIDsByUser(ctx, staying)
	if err != nil || len(remaining) != 1 {
		t.Errorf("staying user votes = %v (err %v), want 1", remaining, err)
	}
}
