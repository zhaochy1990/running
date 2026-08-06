package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/apifmt"
	"github.com/zhaochy1990/stride/internal/authsvc"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// TeamAuthService is the auth-service team and membership boundary. Team data
// never lives in STRIDE MySQL; the original Authorization header is forwarded.
type TeamAuthService interface {
	ListTeams(context.Context, string) ([]authsvc.Team, error)
	CreateTeam(context.Context, string, string, *string) (*authsvc.Team, error)
	GetTeam(context.Context, string, string) (*authsvc.Team, error)
	JoinTeam(context.Context, string, string) (*authsvc.Membership, error)
	LeaveTeam(context.Context, string, string) (*authsvc.StatusResponse, error)
	TransferTeamOwner(context.Context, string, string, string) (*authsvc.Team, error)
	DeleteTeam(context.Context, string, string) error
	ListMembers(context.Context, string, string) ([]authsvc.Member, error)
	ListMyTeams(context.Context, string) ([]authsvc.MyTeam, error)
}

// TeamStore is the MySQL read/social boundary. It deliberately has no team or
// membership persistence and no activity-existence method for likes.
type TeamStore interface {
	TeamFeed(context.Context, []string, int, int, time.Time) ([]storage.Activity, error)
	TeamMileage(context.Context, []string, storage.TeamMileagePeriod, time.Time) (*storage.TeamMileageResult, error)
	UserProfilesByIDs(context.Context, []string) (map[string]storage.UserProfile, error)
	PutTeamLike(context.Context, *storage.TeamLike) error
	DeleteTeamLike(context.Context, string, string, string, string) (bool, error)
	TeamLikesForActivity(context.Context, string, string, string) ([]storage.TeamLike, error)
	TeamLikesForActivities(context.Context, string, []storage.TeamActivityKey) (map[storage.TeamActivityKey][]storage.TeamLike, error)
}

type teamRoutes struct {
	auth       TeamAuthService
	store      TeamStore
	activities ActivityStore
	now        func() time.Time
	log        *zap.Logger
}

func newTeamRoutes(auth TeamAuthService, store TeamStore, activities ActivityStore, log *zap.Logger) *teamRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &teamRoutes{auth: auth, store: store, activities: activities, now: time.Now, log: log}
}

func (t *teamRoutes) register(rg *gin.RouterGroup) {
	if t.auth == nil || t.store == nil {
		return
	}
	rg.GET("/api/teams", t.listTeams)
	rg.POST("/api/teams", t.createTeam)
	rg.GET("/api/teams/:teamId", t.getTeam)
	rg.DELETE("/api/teams/:teamId", t.deleteTeam)
	rg.POST("/api/teams/:teamId/join", t.joinTeam)
	rg.POST("/api/teams/:teamId/leave", t.leaveTeam)
	rg.POST("/api/teams/:teamId/transfer-owner", t.transferOwner)
	rg.GET("/api/teams/:teamId/members", t.listMembers)
	rg.GET("/api/teams/:teamId/feed", t.feed)
	rg.GET("/api/teams/:teamId/mileage", t.mileage)
	if t.activities != nil {
		rg.GET("/api/teams/:teamId/activities/:userId/:labelId", t.activityDetail)
	}
	rg.POST("/api/teams/:teamId/activities/:userId/:labelId/likes", t.likeActivity)
	rg.DELETE("/api/teams/:teamId/activities/:userId/:labelId/likes", t.unlikeActivity)
	rg.GET("/api/teams/:teamId/activities/:userId/:labelId/likes", t.activityLikes)
	rg.GET("/api/users/me/teams", t.myTeams)
}

type detailResponse struct {
	Detail any `json:"detail"`
}

type createTeamInput struct {
	Name        any `json:"name"`
	Description any `json:"description"`
}

type transferOwnerInput struct {
	NewOwnerUserID any `json:"new_owner_user_id"`
}

type teamsResponse struct {
	Teams []authsvc.Team `json:"teams"`
}

type myTeamsResponse struct {
	Teams []authsvc.MyTeam `json:"teams"`
}

type membersResponse struct {
	Members []authsvc.Member `json:"members"`
}

type teamFeedActivity struct {
	LabelID      string   `json:"label_id"`
	Name         *string  `json:"name"`
	SportType    int      `json:"sport_type"`
	SportName    *string  `json:"sport_name"`
	Date         string   `json:"date"`
	DistanceM    *float64 `json:"distance_m"`
	DurationS    *float64 `json:"duration_s"`
	AvgPaceSKm   *float64 `json:"avg_pace_s_km"`
	AvgHR        *int     `json:"avg_hr"`
	MaxHR        *int     `json:"max_hr"`
	TrainingLoad *float64 `json:"training_load"`
	VO2Max       *float64 `json:"vo2max"`
	TrainType    *string  `json:"train_type"`
	RouteThumb   any      `json:"route_thumb"`
	DistanceKM   float64  `json:"distance_km"`
	DurationFmt  string   `json:"duration_fmt"`
	PaceFmt      string   `json:"pace_fmt"`
	UserID       string   `json:"user_id"`
	DisplayName  string   `json:"display_name"`
	LikeCount    int      `json:"like_count"`
	YouLiked     bool     `json:"you_liked"`
	TopLikers    []string `json:"top_likers"`
}

type teamFeedResponse struct {
	TeamID      string             `json:"team_id"`
	MemberCount int                `json:"member_count"`
	Activities  []teamFeedActivity `json:"activities"`
}

type teamMileageRanking struct {
	UserID        string  `json:"user_id"`
	DisplayName   string  `json:"display_name"`
	TotalKM       float64 `json:"total_km"`
	ActivityCount int     `json:"activity_count"`
}

type teamMileageResponse struct {
	TeamID      string               `json:"team_id"`
	Period      string               `json:"period"`
	PeriodStart string               `json:"period_start"`
	PeriodEnd   string               `json:"period_end"`
	Rankings    []teamMileageRanking `json:"rankings"`
}

type likeMutationResponse struct {
	Liked    bool `json:"liked"`
	Count    int  `json:"count"`
	YouLiked bool `json:"you_liked"`
}

type likerResponse struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	CreatedAt   string `json:"created_at"`
}

type likesResponse struct {
	Count    int             `json:"count"`
	YouLiked bool            `json:"you_liked"`
	Likers   []likerResponse `json:"likers"`
}

func (t *teamRoutes) requireUser(c *gin.Context) (string, bool) {
	return requireUser(c)
}

func originalAuthorization(c *gin.Context) string { return c.GetHeader("Authorization") }

func bindTeamJSON(c *gin.Context, dst any) bool {
	if err := c.ShouldBindJSON(dst); err != nil {
		c.JSON(http.StatusUnprocessableEntity, detailResponse{Detail: "Invalid request body"})
		return false
	}
	return true
}

func (t *teamRoutes) writeAuthError(c *gin.Context, err error) {
	var upstream *authsvc.AuthServiceError
	if errors.As(err, &upstream) {
		c.JSON(upstream.StatusCode, detailResponse{Detail: upstream.Detail})
		return
	}
	var unavailable *authsvc.AuthServiceUnavailable
	if errors.As(err, &unavailable) {
		detail := unavailable.Detail
		if unavailable.StatusCode != 0 {
			detail = "auth-service " + strconv.Itoa(unavailable.StatusCode) + ": " + detail
		} else if detail == "" && unavailable.Err != nil {
			detail = unavailable.Err.Error()
		}
		if detail == "" {
			detail = "unavailable"
		}
		c.JSON(http.StatusServiceUnavailable, detailResponse{Detail: "auth-service unavailable: " + detail})
		return
	}
	t.log.Error("auth-service team request failed", zapErr(err))
	c.JSON(http.StatusServiceUnavailable, detailResponse{Detail: "auth-service unavailable"})
}

func (t *teamRoutes) listTeams(c *gin.Context) {
	if _, ok := t.requireUser(c); !ok {
		return
	}
	teams, err := t.auth.ListTeams(c.Request.Context(), originalAuthorization(c))
	if err != nil {
		var unavailable *authsvc.AuthServiceUnavailable
		if errors.As(err, &unavailable) {
			c.JSON(http.StatusOK, teamsResponse{Teams: []authsvc.Team{}})
			return
		}
		t.writeAuthError(c, err)
		return
	}
	if teams == nil {
		teams = []authsvc.Team{}
	}
	c.JSON(http.StatusOK, teamsResponse{Teams: teams})
}

func (t *teamRoutes) createTeam(c *gin.Context) {
	if _, ok := t.requireUser(c); !ok {
		return
	}
	var in createTeamInput
	if !bindTeamJSON(c, &in) {
		return
	}
	name, ok := in.Name.(string)
	if !ok || strings.TrimSpace(name) == "" {
		c.JSON(http.StatusUnprocessableEntity, detailResponse{Detail: "name is required"})
		return
	}
	var description *string
	if in.Description != nil {
		value, ok := in.Description.(string)
		if !ok {
			c.JSON(http.StatusUnprocessableEntity, detailResponse{Detail: "description must be a string"})
			return
		}
		description = &value
	}
	team, err := t.auth.CreateTeam(c.Request.Context(), originalAuthorization(c), strings.TrimSpace(name), description)
	if err != nil {
		t.writeAuthError(c, err)
		return
	}
	c.JSON(http.StatusOK, team)
}

func (t *teamRoutes) getTeam(c *gin.Context) {
	if _, ok := t.requireUser(c); !ok {
		return
	}
	team, err := t.auth.GetTeam(c.Request.Context(), originalAuthorization(c), c.Param("teamId"))
	if err != nil {
		t.writeAuthError(c, err)
		return
	}
	if team == nil {
		c.JSON(http.StatusNotFound, detailResponse{Detail: "Team not found"})
		return
	}
	c.JSON(http.StatusOK, team)
}

func (t *teamRoutes) deleteTeam(c *gin.Context) {
	if _, ok := t.requireUser(c); !ok {
		return
	}
	if err := t.auth.DeleteTeam(c.Request.Context(), originalAuthorization(c), c.Param("teamId")); err != nil {
		t.writeAuthError(c, err)
		return
	}
	c.JSON(http.StatusOK, authsvc.StatusResponse{Status: "deleted"})
}

func (t *teamRoutes) joinTeam(c *gin.Context) {
	if _, ok := t.requireUser(c); !ok {
		return
	}
	value, err := t.auth.JoinTeam(c.Request.Context(), originalAuthorization(c), c.Param("teamId"))
	if err != nil {
		t.writeAuthError(c, err)
		return
	}
	c.JSON(http.StatusOK, value)
}

func (t *teamRoutes) leaveTeam(c *gin.Context) {
	if _, ok := t.requireUser(c); !ok {
		return
	}
	value, err := t.auth.LeaveTeam(c.Request.Context(), originalAuthorization(c), c.Param("teamId"))
	if err != nil {
		t.writeAuthError(c, err)
		return
	}
	c.JSON(http.StatusOK, value)
}

func (t *teamRoutes) transferOwner(c *gin.Context) {
	if _, ok := t.requireUser(c); !ok {
		return
	}
	var in transferOwnerInput
	if !bindTeamJSON(c, &in) {
		return
	}
	owner, ok := in.NewOwnerUserID.(string)
	if !ok || !uuid4Pattern.MatchString(owner) {
		c.JSON(http.StatusUnprocessableEntity, detailResponse{Detail: "new_owner_user_id must be a user UUID"})
		return
	}
	value, err := t.auth.TransferTeamOwner(c.Request.Context(), originalAuthorization(c), c.Param("teamId"), owner)
	if err != nil {
		t.writeAuthError(c, err)
		return
	}
	c.JSON(http.StatusOK, value)
}

func (t *teamRoutes) listMembers(c *gin.Context) {
	if _, ok := t.requireUser(c); !ok {
		return
	}
	members, err := t.auth.ListMembers(c.Request.Context(), originalAuthorization(c), c.Param("teamId"))
	if err != nil {
		var unavailable *authsvc.AuthServiceUnavailable
		if errors.As(err, &unavailable) {
			c.JSON(http.StatusOK, membersResponse{Members: []authsvc.Member{}})
			return
		}
		t.writeAuthError(c, err)
		return
	}
	profiles := t.profiles(c.Request.Context(), memberIDs(members))
	for i := range members {
		name := resolvedMemberName(members[i], profiles)
		members[i].DisplayName = &name
	}
	if members == nil {
		members = []authsvc.Member{}
	}
	c.JSON(http.StatusOK, membersResponse{Members: members})
}

func (t *teamRoutes) myTeams(c *gin.Context) {
	if _, ok := t.requireUser(c); !ok {
		return
	}
	teams, err := t.auth.ListMyTeams(c.Request.Context(), originalAuthorization(c))
	if err != nil {
		var unavailable *authsvc.AuthServiceUnavailable
		if errors.As(err, &unavailable) {
			c.JSON(http.StatusOK, myTeamsResponse{Teams: []authsvc.MyTeam{}})
			return
		}
		t.writeAuthError(c, err)
		return
	}
	if teams == nil {
		teams = []authsvc.MyTeam{}
	}
	c.JSON(http.StatusOK, myTeamsResponse{Teams: teams})
}

func (t *teamRoutes) feed(c *gin.Context) {
	callerID, ok := t.requireUser(c)
	if !ok {
		return
	}
	days, ok := boundedQueryInt(c, "days", 30, 1, 180)
	if !ok {
		return
	}
	limit, ok := boundedQueryInt(c, "limit_per_user", 20, 1, 100)
	if !ok {
		return
	}

	members, err := t.auth.ListMembers(c.Request.Context(), originalAuthorization(c), c.Param("teamId"))
	if err != nil {
		var unavailable *authsvc.AuthServiceUnavailable
		if errors.As(err, &unavailable) {
			members = []authsvc.Member{}
		} else {
			t.writeAuthError(c, err)
			return
		}
	}
	ids := memberIDs(members)
	profiles := t.profiles(c.Request.Context(), ids)
	rows, err := t.store.TeamFeed(c.Request.Context(), ids, days, limit, t.now())
	if err != nil {
		t.log.Error("team feed query failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	byID := membersByID(members)
	activities := make([]teamFeedActivity, len(rows))
	targets := make([]storage.TeamActivityKey, len(rows))
	for i := range rows {
		row := &rows[i]
		activities[i] = toTeamFeedActivity(row, resolvedMemberName(byID[row.UserID], profiles))
		targets[i] = storage.TeamActivityKey{OwnerUserID: row.UserID, LabelID: row.LabelID}
	}
	likes, err := t.store.TeamLikesForActivities(c.Request.Context(), c.Param("teamId"), targets)
	if err != nil {
		t.log.Warn("team feed like enrichment failed", zapErr(err))
		likes = map[storage.TeamActivityKey][]storage.TeamLike{}
	}
	for i := range activities {
		key := storage.TeamActivityKey{OwnerUserID: activities[i].UserID, LabelID: activities[i].LabelID}
		activityLikes := likes[key]
		activities[i].LikeCount = len(activityLikes)
		activities[i].TopLikers = []string{}
		for j, like := range activityLikes {
			if like.LikerUserID == callerID {
				activities[i].YouLiked = true
			}
			if j < 3 {
				activities[i].TopLikers = append(activities[i].TopLikers, snapshotName(like))
			}
		}
	}
	c.JSON(http.StatusOK, teamFeedResponse{TeamID: c.Param("teamId"), MemberCount: len(members), Activities: activities})
}

func (t *teamRoutes) activityDetail(c *gin.Context) {
	callerID, ok := t.requireUser(c)
	if !ok {
		return
	}
	members, ok := t.authorizeMembership(c, callerID, c.Param("userId"))
	if !ok {
		return
	}
	_ = members
	resp, found, err := assembleActivityDetail(c.Request.Context(), t.activities, c.Param("userId"), c.Param("labelId"), true)
	if err != nil {
		t.log.Error("assemble team activity detail failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, detailResponse{Detail: "Activity not found"})
		return
	}
	c.JSON(http.StatusOK, resp)
}

func (t *teamRoutes) mileage(c *gin.Context) {
	callerID, ok := t.requireUser(c)
	if !ok {
		return
	}
	period := c.DefaultQuery("period", string(storage.TeamMileageMonth))
	if period != string(storage.TeamMileageMonth) && period != string(storage.TeamMileageWeek) {
		c.JSON(http.StatusUnprocessableEntity, detailResponse{Detail: "period must be 'month' or 'week'"})
		return
	}
	members, ok := t.authorizeMembership(c, callerID, "")
	if !ok {
		return
	}
	ids := memberIDs(members)
	profiles := t.profiles(c.Request.Context(), ids)
	result, err := t.store.TeamMileage(c.Request.Context(), ids, storage.TeamMileagePeriod(period), t.now())
	if err != nil {
		t.log.Error("team mileage query failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	byID := membersByID(members)
	rankings := make([]teamMileageRanking, len(result.Rows))
	for i, row := range result.Rows {
		rankings[i] = teamMileageRanking{UserID: row.UserID, DisplayName: resolvedMemberName(byID[row.UserID], profiles), TotalKM: apifmt.RoundTo(row.TotalKM, 2), ActivityCount: row.ActivityCount}
	}
	sort.SliceStable(rankings, func(i, j int) bool {
		if rankings[i].TotalKM != rankings[j].TotalKM {
			return rankings[i].TotalKM > rankings[j].TotalKM
		}
		if rankings[i].ActivityCount != rankings[j].ActivityCount {
			return rankings[i].ActivityCount > rankings[j].ActivityCount
		}
		return rankings[i].DisplayName < rankings[j].DisplayName
	})
	c.JSON(http.StatusOK, teamMileageResponse{TeamID: c.Param("teamId"), Period: period, PeriodStart: result.PeriodStart.Format(time.RFC3339), PeriodEnd: result.PeriodEnd.Format(time.RFC3339), Rankings: rankings})
}

func (t *teamRoutes) likeActivity(c *gin.Context) {
	callerID, members, ok := t.validateAndAuthorizeLike(c)
	if !ok {
		return
	}
	profiles := t.profiles(c.Request.Context(), memberIDs(members))
	name := resolvedMemberName(membersByID(members)[callerID], profiles)
	if err := t.store.PutTeamLike(c.Request.Context(), &storage.TeamLike{TeamID: c.Param("teamId"), OwnerUserID: c.Param("userId"), LabelID: c.Param("labelId"), LikerUserID: callerID, LikerDisplayName: name}); err != nil {
		t.log.Error("put team like failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	t.writeLikeMutation(c, callerID, true)
}

func (t *teamRoutes) unlikeActivity(c *gin.Context) {
	callerID, _, ok := t.validateAndAuthorizeLike(c)
	if !ok {
		return
	}
	if _, err := t.store.DeleteTeamLike(c.Request.Context(), c.Param("teamId"), c.Param("userId"), c.Param("labelId"), callerID); err != nil {
		t.log.Error("delete team like failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	t.writeLikeMutation(c, callerID, false)
}

func (t *teamRoutes) activityLikes(c *gin.Context) {
	callerID, members, ok := t.validateAndAuthorizeLike(c)
	if !ok {
		return
	}
	likes, err := t.store.TeamLikesForActivity(c.Request.Context(), c.Param("teamId"), c.Param("userId"), c.Param("labelId"))
	if err != nil {
		t.log.Error("list team likes failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	ids := memberIDs(members)
	for _, like := range likes {
		ids = append(ids, like.LikerUserID)
	}
	profiles := t.profiles(c.Request.Context(), ids)
	byID := membersByID(members)
	out := likesResponse{Count: len(likes), Likers: make([]likerResponse, len(likes))}
	for i, like := range likes {
		member, currentMember := byID[like.LikerUserID]
		if !currentMember {
			member.UserID = like.LikerUserID
		}
		name := resolvedMemberName(member, profiles)
		if name == like.LikerUserID && strings.TrimSpace(like.LikerDisplayName) != "" {
			name = strings.TrimSpace(like.LikerDisplayName)
		}
		if name == like.LikerUserID {
			name = shortID(like.LikerUserID)
		}
		out.Likers[i] = likerResponse{UserID: like.LikerUserID, DisplayName: name, CreatedAt: like.CreatedAt.UTC().Format(time.RFC3339Nano)}
		if like.LikerUserID == callerID {
			out.YouLiked = true
		}
	}
	c.JSON(http.StatusOK, out)
}

func (t *teamRoutes) writeLikeMutation(c *gin.Context, callerID string, liked bool) {
	likes, err := t.store.TeamLikesForActivity(c.Request.Context(), c.Param("teamId"), c.Param("userId"), c.Param("labelId"))
	if err != nil {
		t.log.Error("read team likes after mutation failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	youLiked := false
	for _, like := range likes {
		if like.LikerUserID == callerID {
			youLiked = true
			break
		}
	}
	c.JSON(http.StatusOK, likeMutationResponse{Liked: liked, Count: len(likes), YouLiked: youLiked})
}

func (t *teamRoutes) validateAndAuthorizeLike(c *gin.Context) (string, []authsvc.Member, bool) {
	if !teamIDPattern.MatchString(c.Param("teamId")) {
		c.JSON(http.StatusUnprocessableEntity, detailResponse{Detail: "invalid team_id"})
		return "", nil, false
	}
	if !uuid4Pattern.MatchString(c.Param("userId")) {
		c.JSON(http.StatusUnprocessableEntity, detailResponse{Detail: "invalid user_id"})
		return "", nil, false
	}
	if !labelIDPattern.MatchString(c.Param("labelId")) {
		c.JSON(http.StatusUnprocessableEntity, detailResponse{Detail: "invalid label_id"})
		return "", nil, false
	}
	callerID, ok := t.requireUser(c)
	if !ok {
		return "", nil, false
	}
	if !uuid4Pattern.MatchString(callerID) {
		c.JSON(http.StatusUnauthorized, detailResponse{Detail: "invalid token sub"})
		return "", nil, false
	}
	members, ok := t.authorizeMembership(c, callerID, c.Param("userId"))
	return callerID, members, ok
}

func (t *teamRoutes) authorizeMembership(c *gin.Context, callerID, targetID string) ([]authsvc.Member, bool) {
	members, err := t.auth.ListMembers(c.Request.Context(), originalAuthorization(c), c.Param("teamId"))
	if err != nil {
		var unavailable *authsvc.AuthServiceUnavailable
		if errors.As(err, &unavailable) {
			members = []authsvc.Member{}
		} else {
			t.writeAuthError(c, err)
			return nil, false
		}
	}
	byID := membersByID(members)
	if _, ok := byID[callerID]; !ok {
		c.JSON(http.StatusForbidden, detailResponse{Detail: "Caller is not a member of this team"})
		return nil, false
	}
	if targetID != "" {
		if _, ok := byID[targetID]; !ok {
			c.JSON(http.StatusNotFound, detailResponse{Detail: "User is not in this team"})
			return nil, false
		}
	}
	return members, true
}

func (t *teamRoutes) profiles(ctx context.Context, ids []string) map[string]storage.UserProfile {
	profiles, err := t.store.UserProfilesByIDs(ctx, ids)
	if err != nil {
		t.log.Warn("team profile enrichment failed", zapErr(err))
		return map[string]storage.UserProfile{}
	}
	return profiles
}

func boundedQueryInt(c *gin.Context, name string, defaultValue, min, max int) (int, bool) {
	raw := c.Query(name)
	if raw == "" {
		return defaultValue, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < min || value > max {
		c.JSON(http.StatusUnprocessableEntity, detailResponse{Detail: name + " must be between " + strconv.Itoa(min) + " and " + strconv.Itoa(max)})
		return 0, false
	}
	return value, true
}

func memberIDs(members []authsvc.Member) []string {
	out := make([]string, 0, len(members))
	seen := make(map[string]struct{}, len(members))
	for _, member := range members {
		if !uuid4Pattern.MatchString(member.UserID) {
			continue
		}
		if _, ok := seen[member.UserID]; ok {
			continue
		}
		seen[member.UserID] = struct{}{}
		out = append(out, member.UserID)
	}
	return out
}

func membersByID(members []authsvc.Member) map[string]authsvc.Member {
	out := make(map[string]authsvc.Member, len(members))
	for _, member := range members {
		if member.UserID != "" {
			out[member.UserID] = member
		}
	}
	return out
}

func resolvedMemberName(member authsvc.Member, profiles map[string]storage.UserProfile) string {
	if profile, ok := profiles[member.UserID]; ok && strings.TrimSpace(profile.DisplayName) != "" {
		return strings.TrimSpace(profile.DisplayName)
	}
	if member.DisplayName != nil && strings.TrimSpace(*member.DisplayName) != "" {
		return strings.TrimSpace(*member.DisplayName)
	}
	if member.Name != nil && strings.TrimSpace(*member.Name) != "" {
		return strings.TrimSpace(*member.Name)
	}
	return member.UserID
}

func toTeamFeedActivity(row *storage.Activity, displayName string) teamFeedActivity {
	var routeThumb any
	if raw := routeThumbRaw(row.RouteThumbJSON); raw != nil {
		_ = json.Unmarshal(raw, &routeThumb)
	}
	return teamFeedActivity{
		LabelID: row.LabelID, Name: row.Name, SportType: row.SportType, SportName: row.SportName,
		Date: apifmt.ShanghaiISO(row.Date), DistanceM: row.DistanceM, DurationS: row.DurationS,
		AvgPaceSKm: row.AvgPaceSKm, AvgHR: row.AvgHR, MaxHR: row.MaxHR, TrainingLoad: row.TrainingLoad,
		VO2Max: row.VO2Max, TrainType: row.TrainType, RouteThumb: routeThumb,
		DistanceKM: apifmt.DistanceKm(row.DistanceM), DurationFmt: apifmt.DurationFmt(row.DurationS), PaceFmt: apifmt.PaceFmt(row.AvgPaceSKm),
		UserID: row.UserID, DisplayName: displayName, TopLikers: []string{},
	}
}

func snapshotName(like storage.TeamLike) string {
	if name := strings.TrimSpace(like.LikerDisplayName); name != "" {
		return name
	}
	return shortID(like.LikerUserID)
}

func shortID(value string) string {
	if len(value) <= 8 {
		return value
	}
	return value[:8]
}

var (
	uuid4Pattern   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	teamIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	labelIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
)
