package storage

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm/schema"
)

func openTeamTestStore(t *testing.T) *Store {
	t.Helper()
	st := openWatchTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateUsers(ctx); err != nil {
		t.Fatalf("automigrate users: %v", err)
	}
	if err := st.AutoMigrateTeamLikes(ctx); err != nil {
		t.Fatalf("automigrate team likes: %v", err)
	}
	return st
}

func TestTeamLikeSchema_DeclaresActivityLookupIndex(t *testing.T) {
	parsed, err := schema.Parse(&TeamLike{}, &sync.Map{}, schema.NamingStrategy{})
	if err != nil {
		t.Fatalf("parse team like schema: %v", err)
	}
	idx := parsed.LookIndex("idx_team_likes_activity")
	if idx == nil {
		t.Fatal("team_likes activity lookup index is not declared")
	}
	got := make([]string, 0, len(idx.Fields))
	for _, field := range idx.Fields {
		got = append(got, field.DBName)
	}
	if strings.Join(got, ",") != "team_id,owner_user_id,label_id" {
		t.Fatalf("activity lookup index columns = %v", got)
	}
}

func TestAutoMigrateTeamLikes_IsIndependent(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateTeamLikes(ctx); err != nil {
		t.Fatalf("automigrate team likes: %v", err)
	}
	m := st.db.WithContext(ctx).Migrator()
	if !m.HasTable(&TeamLike{}) {
		t.Fatal("team_likes table was not created")
	}
	if !m.HasIndex(&TeamLike{}, "idx_team_likes_activity") {
		t.Fatal("team_likes activity lookup index was not created")
	}
	if m.HasTable("teams") || m.HasTable("team_members") {
		t.Fatal("team likes migration must not create teams or team_members")
	}
}

func TestTeamFeedQuery_UsesMySQLWindowForPerUserLimit(t *testing.T) {
	for _, fragment := range []string{
		"ROW_NUMBER() OVER",
		"PARTITION BY user_id",
		"ORDER BY date DESC, label_id DESC",
		"WHERE ranked.team_row_num <= ?",
	} {
		if !strings.Contains(teamFeedQuery, fragment) {
			t.Fatalf("team feed SQL missing %q: %s", fragment, teamFeedQuery)
		}
	}
}

func TestTeamFeed_MembersCutoffOrderAndPerUserLimit(t *testing.T) {
	st := openTeamTestStore(t)
	ctx := context.Background()
	memberA := uuid.NewString()
	memberB := uuid.NewString()
	outsider := uuid.NewString()
	now := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC) // 20:00 Shanghai

	seedActivity(t, st, memberA, &Activity{
		LabelID: "a-old", SportType: 100, SportName: sptr("Run"),
		// 2026-08-03 23:59 Shanghai: outside an inclusive two-day cutoff of Aug 4.
		Date: time.Date(2026, 8, 3, 15, 59, 0, 0, time.UTC), DistanceM: f(1000),
	}, nil, nil, nil)
	seedActivity(t, st, memberA, &Activity{
		LabelID: "a-1", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 8, 5, 1, 0, 0, 0, time.UTC), DistanceM: f(3000),
	}, nil, nil, nil)
	seedActivity(t, st, memberA, &Activity{
		LabelID: "a-2", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 8, 6, 1, 0, 0, 0, time.UTC), DistanceM: f(4000),
	}, nil, nil, nil)
	seedActivity(t, st, memberB, &Activity{
		LabelID: "b-1", SportType: 402, SportName: sptr("Strength"),
		Date: time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC),
	}, nil, nil, nil)
	seedActivity(t, st, outsider, &Activity{
		LabelID: "outside", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 8, 6, 2, 0, 0, 0, time.UTC),
	}, nil, nil, nil)

	rows, err := st.TeamFeed(ctx, []string{memberA, memberB}, 2, 1, now)
	if err != nil {
		t.Fatalf("team feed: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("feed length = %d, want 2: %+v", len(rows), labelIDs(rows))
	}
	if rows[0].LabelID != "a-2" || rows[1].LabelID != "b-1" {
		t.Fatalf("feed order/limit = %v, want [a-2 b-1]", labelIDs(rows))
	}
	for _, row := range rows {
		if row.UserID == outsider || row.LabelID == "a-old" || row.LabelID == "a-1" {
			t.Fatalf("feed leaked excluded row: %+v", row)
		}
	}
}

func TestTeamMileage_MonthAndWeekShanghaiBounds(t *testing.T) {
	st := openTeamTestStore(t)
	ctx := context.Background()
	memberA := uuid.NewString()
	memberB := uuid.NewString()
	now := time.Date(2026, 8, 6, 4, 0, 0, 0, time.UTC) // Thu 12:00 Shanghai

	// Shanghai Aug 1 00:00, before the current week but inside the month.
	seedActivity(t, st, memberA, &Activity{
		LabelID: "month-boundary", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 7, 31, 16, 0, 0, 0, time.UTC), DistanceM: f(5000),
	}, nil, nil, nil)
	// Shanghai Monday Aug 3 00:00: included in both month and week.
	seedActivity(t, st, memberA, &Activity{
		LabelID: "week-boundary", SportType: 104,
		Date: time.Date(2026, 8, 2, 16, 0, 0, 0, time.UTC), DistanceM: f(7000),
	}, nil, nil, nil)
	// A run-looking fallback without a canonical sport_type never contributes.
	seedActivity(t, st, memberA, &Activity{
		LabelID: "run-name-only", SportType: 0, Sport: sptr("run_outdoor"), SportName: sptr("Run"),
		Date: time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC), DistanceM: f(13000),
	}, nil, nil, nil)
	// Non-running activity never contributes.
	seedActivity(t, st, memberA, &Activity{
		LabelID: "strength", SportType: 402, SportName: sptr("Strength"),
		Date: time.Date(2026, 8, 4, 1, 0, 0, 0, time.UTC), DistanceM: f(9000),
	}, nil, nil, nil)
	// A future activity after period_end must not contribute.
	seedActivity(t, st, memberA, &Activity{
		LabelID: "future", SportType: 100, SportName: sptr("Run"),
		Date: now.Add(time.Hour), DistanceM: f(11000),
	}, nil, nil, nil)

	month, err := st.TeamMileage(ctx, []string{memberA, memberB}, TeamMileageMonth, now)
	if err != nil {
		t.Fatalf("month mileage: %v", err)
	}
	assertMileageRows(t, month.Rows, memberA, 12, 2, memberB)
	if got := month.PeriodStart.Format(time.RFC3339); got != "2026-08-01T00:00:00+08:00" {
		t.Fatalf("month start = %s", got)
	}

	week, err := st.TeamMileage(ctx, []string{memberA, memberB}, TeamMileageWeek, now)
	if err != nil {
		t.Fatalf("week mileage: %v", err)
	}
	assertMileageRows(t, week.Rows, memberA, 7, 1, memberB)
	if got := week.PeriodStart.Format(time.RFC3339); got != "2026-08-03T00:00:00+08:00" {
		t.Fatalf("week start = %s", got)
	}
}

func TestUserProfilesByIDs_OmitsMissingAndOutsiders(t *testing.T) {
	st := openTeamTestStore(t)
	ctx := context.Background()
	memberA := uuid.NewString()
	memberB := uuid.NewString()
	outsider := uuid.NewString()
	if err := st.UpsertUserProfile(ctx, &UserProfile{UserID: memberA, DisplayName: "Alice"}); err != nil {
		t.Fatalf("seed member profile: %v", err)
	}
	if err := st.UpsertUserProfile(ctx, &UserProfile{UserID: outsider, DisplayName: "Outsider"}); err != nil {
		t.Fatalf("seed outsider profile: %v", err)
	}

	profiles, err := st.UserProfilesByIDs(ctx, []string{memberA, memberB, memberA})
	if err != nil {
		t.Fatalf("profiles by ids: %v", err)
	}
	if len(profiles) != 1 || profiles[memberA].DisplayName != "Alice" {
		t.Fatalf("profiles = %+v, want Alice only", profiles)
	}
	if _, ok := profiles[outsider]; ok {
		t.Fatal("outsider profile leaked")
	}
}

func TestTeamLikes_IdempotentScopedOrderedAndDelete(t *testing.T) {
	st := openTeamTestStore(t)
	ctx := context.Background()
	owner := uuid.NewString()
	likerA := uuid.NewString()
	likerB := uuid.NewString()
	base := time.Date(2026, 8, 6, 1, 0, 0, 0, time.UTC)

	likeA := &TeamLike{TeamID: "team-a", OwnerUserID: owner, LabelID: "run-1", LikerUserID: likerA, LikerDisplayName: "Old A", CreatedAt: base.Add(time.Minute)}
	if err := st.PutTeamLike(ctx, likeA); err != nil {
		t.Fatalf("put A: %v", err)
	}
	// The second put updates the display-name snapshot but preserves CreatedAt.
	likeA.LikerDisplayName = "New A"
	likeA.CreatedAt = base.Add(10 * time.Minute)
	if err := st.PutTeamLike(ctx, likeA); err != nil {
		t.Fatalf("repeat A: %v", err)
	}
	if err := st.PutTeamLike(ctx, &TeamLike{TeamID: "team-a", OwnerUserID: owner, LabelID: "run-1", LikerUserID: likerB, LikerDisplayName: "B", CreatedAt: base}); err != nil {
		t.Fatalf("put B: %v", err)
	}
	if err := st.PutTeamLike(ctx, &TeamLike{TeamID: "team-b", OwnerUserID: owner, LabelID: "run-1", LikerUserID: likerA, LikerDisplayName: "Other Team", CreatedAt: base}); err != nil {
		t.Fatalf("put other team: %v", err)
	}

	rows, err := st.TeamLikesForActivity(ctx, "team-a", owner, "run-1")
	if err != nil {
		t.Fatalf("list likes: %v", err)
	}
	if len(rows) != 2 || rows[0].LikerUserID != likerB || rows[1].LikerUserID != likerA {
		t.Fatalf("likes order/count = %+v", rows)
	}
	if rows[1].LikerDisplayName != "New A" || !rows[1].CreatedAt.Equal(base.Add(time.Minute)) {
		t.Fatalf("idempotent upsert changed wrong fields: %+v", rows[1])
	}

	deleted, err := st.DeleteTeamLike(ctx, "team-a", owner, "run-1", likerA)
	if err != nil || !deleted {
		t.Fatalf("first delete = %v, %v", deleted, err)
	}
	deleted, err = st.DeleteTeamLike(ctx, "team-a", owner, "run-1", likerA)
	if err != nil || deleted {
		t.Fatalf("second delete = %v, %v", deleted, err)
	}
	other, err := st.TeamLikesForActivity(ctx, "team-b", owner, "run-1")
	if err != nil || len(other) != 1 {
		t.Fatalf("other-team like changed: len=%d err=%v", len(other), err)
	}
}

func TestPutTeamLike_NormalizesDisplayName(t *testing.T) {
	st := openTeamTestStore(t)
	ctx := context.Background()
	like := &TeamLike{
		TeamID:           "display-name",
		OwnerUserID:      uuid.NewString(),
		LabelID:          "run-1",
		LikerUserID:      uuid.NewString(),
		LikerDisplayName: "  " + strings.Repeat("跑", 201) + "  ",
	}
	if err := st.PutTeamLike(ctx, like); err != nil {
		t.Fatalf("put long display name: %v", err)
	}
	rows, err := st.TeamLikesForActivity(ctx, like.TeamID, like.OwnerUserID, like.LabelID)
	if err != nil {
		t.Fatalf("read long display name: %v", err)
	}
	if len(rows) != 1 || len([]rune(rows[0].LikerDisplayName)) != 200 || strings.HasPrefix(rows[0].LikerDisplayName, " ") {
		t.Fatalf("display name was not trimmed/capped: %q", rows[0].LikerDisplayName)
	}
}

func TestTeamLikesForActivities_BulkScopedAndEmptyTargets(t *testing.T) {
	st := openTeamTestStore(t)
	ctx := context.Background()
	ownerA := uuid.NewString()
	ownerB := uuid.NewString()
	liker := uuid.NewString()
	at := time.Date(2026, 8, 6, 1, 0, 0, 0, time.UTC)
	for _, like := range []*TeamLike{
		{TeamID: "bulk-a", OwnerUserID: ownerA, LabelID: "run-a", LikerUserID: liker, CreatedAt: at},
		{TeamID: "bulk-a", OwnerUserID: ownerB, LabelID: "run-b", LikerUserID: liker, CreatedAt: at},
		{TeamID: "bulk-b", OwnerUserID: ownerA, LabelID: "run-a", LikerUserID: liker, CreatedAt: at},
	} {
		if err := st.PutTeamLike(ctx, like); err != nil {
			t.Fatalf("put bulk like: %v", err)
		}
	}

	missing := TeamActivityKey{OwnerUserID: ownerA, LabelID: "missing"}
	got, err := st.TeamLikesForActivities(ctx, "bulk-a", []TeamActivityKey{
		{OwnerUserID: ownerA, LabelID: "run-a"},
		{OwnerUserID: ownerB, LabelID: "run-b"},
		missing,
	})
	if err != nil {
		t.Fatalf("bulk likes: %v", err)
	}
	if len(got) != 3 || len(got[TeamActivityKey{OwnerUserID: ownerA, LabelID: "run-a"}]) != 1 || len(got[missing]) != 0 {
		t.Fatalf("bulk result = %+v", got)
	}
	for _, rows := range got {
		for _, row := range rows {
			if row.TeamID != "bulk-a" {
				t.Fatalf("cross-team like leaked: %+v", row)
			}
		}
	}

	empty, err := st.TeamLikesForActivities(ctx, "bulk-a", nil)
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty bulk = %+v, %v", empty, err)
	}
}

func TestTeamMileageWindow(t *testing.T) {
	now := time.Date(2026, 8, 2, 17, 30, 0, 0, time.UTC) // Monday 01:30 Shanghai
	start, end, err := teamMileageWindow(TeamMileageWeek, now)
	if err != nil {
		t.Fatalf("week window: %v", err)
	}
	if got := start.Format(time.RFC3339); got != "2026-08-03T00:00:00+08:00" {
		t.Fatalf("week start = %s", got)
	}
	if got := end.Format(time.RFC3339); got != "2026-08-03T01:30:00+08:00" {
		t.Fatalf("week end = %s", got)
	}
	if _, _, err := teamMileageWindow("quarter", now); err == nil {
		t.Fatal("invalid period must fail")
	}
}

func assertMileageRows(t *testing.T, rows []TeamMileage, activeID string, wantKM float64, wantCount int, zeroID string) {
	t.Helper()
	if len(rows) != 2 {
		t.Fatalf("mileage rows = %d, want 2: %+v", len(rows), rows)
	}
	byID := make(map[string]TeamMileage, len(rows))
	for _, row := range rows {
		byID[row.UserID] = row
	}
	active := byID[activeID]
	if active.TotalKM < wantKM-0.0001 || active.TotalKM > wantKM+0.0001 || active.ActivityCount != wantCount {
		t.Fatalf("active mileage = %+v, want %.1f km/%d", active, wantKM, wantCount)
	}
	zero := byID[zeroID]
	if zero.TotalKM != 0 || zero.ActivityCount != 0 {
		t.Fatalf("zero member mileage = %+v", zero)
	}
}
