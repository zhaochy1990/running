package api

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
	"github.com/go-playground/validator/v10"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// init teaches gin's shared validator to report the json field name (not the Go
// struct field name) in validation errors, so the 422 detail array on POST
// profile names fields as the client sent them (display_name, not DisplayName).
func init() {
	if v, ok := binding.Validator.Engine().(*validator.Validate); ok {
		v.RegisterTagNameFunc(func(fld reflect.StructField) string {
			name := strings.SplitN(fld.Tag.Get("json"), ",", 2)[0]
			if name == "-" {
				return ""
			}
			return name
		})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies (ADR 0013). The user/onboarding surface is a sibling registrar
// with its own ports, so the ADR 0012 job/pipeline Service stays focused.
// ─────────────────────────────────────────────────────────────────────────────

// UserStore is the profile + onboarding persistence the handlers need. Satisfied
// by *storage.Store.
type UserStore interface {
	GetUserProfile(ctx context.Context, userID string) (*storage.UserProfile, error)
	UpsertUserProfile(ctx context.Context, p *storage.UserProfile) error
	GetUserOnboarding(ctx context.Context, userID string) (*storage.UserOnboarding, error)
	SetWatchReady(ctx context.Context, userID string) error
	SetProfileReady(ctx context.Context, userID string) error
	ProviderForUser(ctx context.Context, userID string) (string, bool, error)
}

// WatchLoginResult is the provider-agnostic outcome of a watch login.
type WatchLoginResult struct {
	Success bool
	UserID  string
	Region  string
	Message string
}

// ProviderLogin authenticates a user with a watch provider and persists their
// credentials. The concrete adapter (cmd/api) wraps the provider registry, so
// the api package stays free of provider/registry imports.
type ProviderLogin interface {
	Login(ctx context.Context, providerName, userID, email, password, region string) (WatchLoginResult, error)
}

// AuthNameSync best-effort mirrors a display name into the auth-service. May be
// nil to disable the write-back. Satisfied by *authsvc.Client.
type AuthNameSync interface {
	SyncName(ctx context.Context, bearer, name string) error
}

// FeatureConfig holds the config-driven feature flags echoed in the profile
// response. The coach-* maps are user-id allow-lists (membership = flag true).
type FeatureConfig struct {
	SyncDataAtOnboarding      bool
	CoachAgentWeeklyPlanUsers map[string]bool
	CoachChatUsers            map[string]bool
	CoachChatDebugUsers       map[string]bool
	CoachChatMaxMessageChars  int
}

func (f FeatureConfig) forUser(uid string) featureFlags {
	return featureFlags{
		SyncDataAtOnboarding:     f.SyncDataAtOnboarding,
		CoachAgentWeeklyPlan:     f.CoachAgentWeeklyPlanUsers[uid],
		CoachChat:                f.CoachChatUsers[uid],
		CoachChatDebug:           f.CoachChatDebugUsers[uid],
		CoachChatMaxMessageChars: f.CoachChatMaxMessageChars,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

// userRoutes is the profile + onboarding endpoint set. It mounts onto the shared
// authed group so it reuses the JWT user-tier auth (ADR 0013).
type userRoutes struct {
	store         UserStore
	providerLogin ProviderLogin
	authName      AuthNameSync
	features      FeatureConfig
	log           *zap.Logger
}

func newUserRoutes(store UserStore, pl ProviderLogin, an AuthNameSync, features FeatureConfig, log *zap.Logger) *userRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &userRoutes{store: store, providerLogin: pl, authName: an, features: features, log: log}
}

// register mounts the routes on the (already authenticated) group. Paths mirror
// the Python contract so a later browser cutover is just routing, except the
// unified /watch/login (ADR 0013).
func (u *userRoutes) register(rg *gin.RouterGroup) {
	rg.GET("/api/users/me/profile", u.getProfile)
	rg.POST("/api/users/me/profile", u.postProfile)
	rg.POST("/api/users/me/watch/login", u.watchLogin)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

type profileResponse struct {
	ID          string          `json:"id"`
	DisplayName string          `json:"display_name"`
	Provider    *string         `json:"provider"`
	Profile     *profileCore    `json:"profile"`
	Onboarding  onboardingState `json:"onboarding"`
	Features    featureFlags    `json:"features"`
}

type profileCore struct {
	DisplayName string  `json:"display_name"`
	DOB         string  `json:"dob"`
	Sex         string  `json:"sex"`
	HeightCm    float64 `json:"height_cm"`
	WeightKg    float64 `json:"weight_kg"`
}

type onboardingState struct {
	WatchReady   bool    `json:"watch_ready"`
	ProfileReady bool    `json:"profile_ready"`
	CompletedAt  *string `json:"completed_at"`
}

type featureFlags struct {
	SyncDataAtOnboarding     bool `json:"sync_data_at_onboarding"`
	CoachAgentWeeklyPlan     bool `json:"coach_agent_weekly_plan"`
	CoachChat                bool `json:"coach_chat"`
	CoachChatDebug           bool `json:"coach_chat_debug"`
	CoachChatMaxMessageChars int  `json:"coach_chat_max_message_chars"`
}

// profileInput is the POST profile body — the five onboarding core fields only
// (race/training-plan goals are set later, ADR 0013).
type profileInput struct {
	DisplayName string  `json:"display_name" binding:"required"`
	DOB         string  `json:"dob" binding:"required,datetime=2006-01-02"`
	Sex         string  `json:"sex" binding:"required,oneof=male female other"`
	HeightCm    float64 `json:"height_cm" binding:"required,gt=0"`
	WeightKg    float64 `json:"weight_kg" binding:"required,gt=0"`
}

// watchLoginInput is the unified watch-login body.
type watchLoginInput struct {
	Provider string `json:"provider" binding:"required,oneof=coros garmin"`
	Email    string `json:"email" binding:"required"`
	Password string `json:"password" binding:"required"`
	Region   string `json:"region" binding:"omitempty,oneof=cn global"`
}

type watchLoginResponse struct {
	OK     bool   `json:"ok"`
	Region string `json:"region,omitempty"`
	UserID string `json:"user_id,omitempty"`
}

// validationDetailItem mirrors FastAPI's 422 detail entry so the frontend's
// per-field error UX works unchanged (ADR 0013).
type validationDetailItem struct {
	Loc []string `json:"loc"`
	Msg string   `json:"msg"`
}

type validationErrorResponse struct {
	Detail []validationDetailItem `json:"detail"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// getProfile returns the user's profile, onboarding state, watch provider, and
// feature flags. display_name is read locally (stride is source of truth).
//
//	@Summary		Get the current user's profile, onboarding state and features
//	@Tags			users
//	@Produce		json
//	@Success		200	{object}	profileResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/profile [get]
func (u *userRoutes) getProfile(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()

	profile, err := u.store.GetUserProfile(ctx, uid)
	if err != nil {
		u.log.Error("get profile failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	onb, err := u.store.GetUserOnboarding(ctx, uid)
	if err != nil {
		u.log.Error("get onboarding failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	providerName, found, err := u.store.ProviderForUser(ctx, uid)
	if err != nil {
		u.log.Error("provider lookup failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	resp := profileResponse{ID: uid, Features: u.features.forUser(uid)}
	if found {
		resp.Provider = &providerName
	}
	if profile != nil {
		resp.DisplayName = profile.DisplayName
		resp.Profile = &profileCore{
			DisplayName: profile.DisplayName,
			DOB:         profile.DOB,
			Sex:         profile.Sex,
			HeightCm:    profile.HeightCm,
			WeightKg:    profile.WeightKg,
		}
	}
	if onb != nil {
		resp.Onboarding = onboardingState{
			WatchReady:   onb.WatchReady,
			ProfileReady: onb.ProfileReady,
			CompletedAt:  isoTimePtr(onb.CompletedAt),
		}
	}
	c.JSON(http.StatusOK, resp)
}

// postProfile validates and saves the five core profile fields, marks
// profile_ready, then best-effort mirrors display_name to the auth-service.
//
//	@Summary		Save the current user's basic profile
//	@Description	Persists the five onboarding core fields, marks profile_ready, and best-effort mirrors the display name to the auth-service.
//	@Tags			users
//	@Accept			json
//	@Produce		json
//	@Param			body	body		profileInput	true	"Profile core fields"
//	@Success		200		{object}	map[string]bool
//	@Failure		401		{object}	errorResponse
//	@Failure		422		{object}	validationErrorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/profile [post]
func (u *userRoutes) postProfile(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var in profileInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: bindingDetail(err)})
		return
	}
	ctx := c.Request.Context()

	if err := u.store.UpsertUserProfile(ctx, &storage.UserProfile{
		UserID:      uid,
		DisplayName: in.DisplayName,
		DOB:         in.DOB,
		Sex:         in.Sex,
		HeightCm:    in.HeightCm,
		WeightKg:    in.WeightKg,
	}); err != nil {
		u.log.Error("upsert profile failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if err := u.store.SetProfileReady(ctx, uid); err != nil {
		u.log.Error("set profile_ready failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	// Best-effort mirror to the auth-service (ADR 0013): the profile is already
	// saved; a failed push is logged, never fatal.
	if u.authName != nil {
		if err := u.authName.SyncName(ctx, bearerFrom(c), in.DisplayName); err != nil {
			u.log.Warn("auth-service name sync failed (non-fatal)", zapErr(err))
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// watchLogin authenticates a watch provider (COROS/Garmin), persists creds, and
// marks watch_ready. It triggers no sync (deferred to the sync-endpoint port).
//
//	@Summary		Connect a watch provider (COROS/Garmin)
//	@Description	Authenticates the watch account, persists credentials, and marks watch_ready. Provider is selected in the body; region applies to Garmin. Triggers no sync.
//	@Tags			users
//	@Accept			json
//	@Produce		json
//	@Param			body	body		watchLoginInput	true	"Watch provider credentials"
//	@Success		200		{object}	watchLoginResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/watch/login [post]
func (u *userRoutes) watchLogin(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var in watchLoginInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
		return
	}
	region := in.Region
	if in.Provider == "garmin" && region == "" {
		region = "cn" // deploy targets China-region Garmin users (parity with Python)
	}
	ctx := c.Request.Context()

	// Auth + network errors collapse to one generic 400 to avoid account
	// enumeration; the real cause goes to the log.
	res, err := u.providerLogin.Login(ctx, in.Provider, uid, in.Email, in.Password, region)
	if err != nil {
		u.log.Warn("watch login failed", zap.String("provider", in.Provider), zapErr(err))
		c.JSON(http.StatusBadRequest, errorResponse{Error: loginFailMessage(in.Provider)})
		return
	}
	if !res.Success {
		c.JSON(http.StatusBadRequest, errorResponse{Error: firstNonEmpty(res.Message, loginFailMessage(in.Provider))})
		return
	}
	if err := u.store.SetWatchReady(ctx, uid); err != nil {
		u.log.Error("set watch_ready failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, watchLoginResponse{OK: true, Region: res.Region, UserID: res.UserID})
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// requireUser rejects the internal tier: profile/onboarding endpoints are "me"
// endpoints and require an end-user JWT.
func requireUser(c *gin.Context) (string, bool) {
	caller := callerFrom(c)
	if caller.Tier != TierUser || caller.UserID == "" {
		c.JSON(http.StatusUnauthorized, errorResponse{Error: "user authentication required"})
		return "", false
	}
	return caller.UserID, true
}

// bearerFrom extracts the raw JWT from the Authorization header for forwarding
// to the auth-service.
func bearerFrom(c *gin.Context) string {
	const prefix = "Bearer "
	if h := c.GetHeader("Authorization"); strings.HasPrefix(h, prefix) {
		return strings.TrimPrefix(h, prefix)
	}
	return ""
}

// isoTimePtr renders an optional instant as an RFC3339 string pointer (null when
// absent) for JSON parity.
func isoTimePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}

func loginFailMessage(provider string) string {
	switch provider {
	case "garmin":
		return "Could not authenticate with Garmin"
	default:
		return "Could not authenticate with COROS"
	}
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// bindingDetail turns a gin/validator binding error into a FastAPI-shaped detail
// array. Non-validator errors (malformed JSON, wrong types) collapse to a single
// body-level item.
func bindingDetail(err error) []validationDetailItem {
	var ve validator.ValidationErrors
	if errors.As(err, &ve) {
		items := make([]validationDetailItem, 0, len(ve))
		for _, fe := range ve {
			items = append(items, validationDetailItem{
				Loc: []string{"body", fe.Field()},
				Msg: validationMessage(fe),
			})
		}
		return items
	}
	return []validationDetailItem{{Loc: []string{"body"}, Msg: "invalid request body"}}
}

func validationMessage(fe validator.FieldError) string {
	switch fe.Tag() {
	case "required":
		return "field required"
	case "oneof":
		return "must be one of: " + fe.Param()
	case "gt":
		return "must be greater than " + fe.Param()
	case "datetime":
		return "must match format " + fe.Param()
	default:
		return "invalid value"
	}
}
