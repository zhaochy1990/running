package api

import (
	"context"
	"errors"
	"math"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/storage"
)

// #858 PR-D 伤病模式同意流（票面 Q11/Q14 定稿）：用户在追问菜单选「受伤了」
// 后自判四选一（continue=照旧不调仅记录 / reduced=维持课 / rest=完全停 /
// undecided=看医生待定），恢复跟踪每天一答（better/same/worse/recovered），
// 待定每天问医生直到三选一。用户端点 self-scoped by JWT；内部端点供夜检扫描
// （读 active 态）与 maintenance worker（回写重估后的维持周量单值锚）。
//
// 注意：race_closing_in_weeks（完全停+比赛临近的「按现状重排」提示）不在本
// 端点——比赛周从 skeleton/计划推算，Go 侧拿不到，由 mp 拿 current 计划响应
// 自己组合（夜检 scan 判定也会输出 replan_suggest 标记）。

// PlanInjuryStore is the storage surface the injury routes need.
type PlanInjuryStore interface {
	EnterInjuryState(ctx context.Context, userID, masterPlanID, detail, verdict string) (*storage.PlanInjuryState, error)
	AnswerDailyCheckin(ctx context.Context, userID, answer string) (*storage.PlanInjuryState, error)
	AnswerPendingDoctor(ctx context.Context, userID, verdict string) (*storage.PlanInjuryState, error)
	GetInjuryState(ctx context.Context, userID string) (*storage.PlanInjuryState, error)
	CloseInjuryState(ctx context.Context, userID string) error
	UpdateInjuryMaintenanceKm(ctx context.Context, userID string, km float64) (*storage.PlanInjuryState, error)
}

type planInjuryRoutes struct {
	store PlanInjuryStore
	log   *zap.Logger
}

func newPlanInjuryRoutes(store PlanInjuryStore, log *zap.Logger) *planInjuryRoutes {
	return &planInjuryRoutes{store: store, log: log}
}

func (p *planInjuryRoutes) registerInternal(rg *gin.RouterGroup) {
	if p.store == nil {
		return
	}
	rg.GET("/api/internal/users/:user_id/plan-injury", p.stateInternal)
	rg.POST("/api/internal/users/:user_id/plan-injury/maintenance", p.maintenance)
}

func (p *planInjuryRoutes) registerUser(rg *gin.RouterGroup) {
	if p.store == nil {
		return
	}
	rg.POST("/api/users/:user_id/plan-injury/enter", p.enter)
	rg.GET("/api/users/:user_id/plan-injury", p.state)
	rg.POST("/api/users/:user_id/plan-injury/checkin", p.checkin)
	rg.POST("/api/users/:user_id/plan-injury/doctor", p.doctor)
}

// ── 用户（self JWT）通道 ─────────────────────────────────────────────────────

type injuryDTO struct {
	UserID            string   `json:"user_id"`
	MasterPlanID      string   `json:"master_plan_id"`
	Mode              string   `json:"mode"`
	Detail            string   `json:"detail"`
	MaintenanceKm     *float64 `json:"maintenance_km"`
	NeedsVerdict      bool     `json:"needs_verdict"`
	LastCheckinDay    *string  `json:"last_checkin_day"`
	LastCheckinAnswer *string  `json:"last_checkin_answer"`
}

func injuryOf(row *storage.PlanInjuryState) injuryDTO {
	return injuryDTO{
		UserID: row.UserID, MasterPlanID: row.MasterPlanID, Mode: row.Mode,
		Detail: row.Detail, MaintenanceKm: row.MaintenanceKm, NeedsVerdict: row.NeedsVerdict,
		LastCheckinDay: row.LastCheckinDay, LastCheckinAnswer: row.LastCheckinAnswer,
	}
}

// enterInjuryRequest: 追问细节（哪里伤/一句话，给教练看）+ 四选一自判。
type enterInjuryRequest struct {
	Detail  string `json:"detail" binding:"required,max=512"`
	Verdict string `json:"verdict" binding:"required"`
	// MasterPlanID 是进入时点所在计划 id（教练上下文/审计用；维持 job 会以 active
	// 计划自行重推导——不传则落零值 UUID 占位）。
	MasterPlanID string `json:"master_plan_id"`
}

// enter records the four-way verdict. continue → 201 {"closed":true}（无 active
// 行）；其余 → 201 {"injury": …}（active 态）。
//
//	@Summary		Enter injury mode (four-way self verdict)
//	@Description	#858 PR-D: continue=照旧不调（仅记录，立刻关闭）；reduced=减量维持课；rest=完全停；undecided=看医生进入待定。
//	@Tags			plan-injury
//	@Accept			json
//	@Produce		json
//	@Param			user_id	path	string				true	"User UUID (JWT sub; self only)"
//	@Param			body	body	enterInjuryRequest	true	"Injury detail + verdict (continue|reduced|rest|undecided)"
//	@Success		201		{object}	injuryStateResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/{user_id}/plan-injury/enter [post]
func (p *planInjuryRoutes) enter(c *gin.Context) {
	userID := c.Param("user_id")
	if !p.selfOnly(c, userID) {
		return
	}
	var body enterInjuryRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}
	if !isInjuryVerdict(body.Verdict) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_verdict"})
		return
	}
	masterPlanID := "00000000-0000-0000-0000-000000000000"
	if body.MasterPlanID != "" {
		if _, err := uuid.Parse(body.MasterPlanID); err != nil {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_master_plan"})
			return
		}
		masterPlanID = body.MasterPlanID
	}
	row, err := p.store.EnterInjuryState(c.Request.Context(), userID, masterPlanID, body.Detail, body.Verdict)
	if errors.Is(err, storage.ErrInjuryVerdict) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_verdict"})
		return
	}
	if err != nil {
		p.log.Error("enter injury state failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row == nil {
		c.JSON(http.StatusCreated, injuryClosedResponse{Closed: true})
		return
	}
	c.JSON(http.StatusCreated, injuryStateResponse{Injury: injuryOf(row)})
}

type injuryStateResponse struct {
	Injury injuryDTO `json:"injury"`
}

type injuryClosedResponse struct {
	Closed bool `json:"closed"`
}

// state returns the active injury mode or 404（恢复/从未进入）。
//
//	@Summary		Get the active injury state
//	@Description	#858 PR-D: active 态（mode/detail/maintenance_km/needs_verdict/最近一答）；404=不在伤病模式。
//	@Tags			plan-injury
//	@Produce		json
//	@Param			user_id	path	string	true	"User UUID (JWT sub; self only)"
//	@Success		200		{object}	injuryStateResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/{user_id}/plan-injury [get]
func (p *planInjuryRoutes) state(c *gin.Context) {
	userID := c.Param("user_id")
	if !p.selfOnly(c, userID) {
		return
	}
	row, err := p.store.GetInjuryState(c.Request.Context(), userID)
	if err != nil {
		p.log.Error("load injury state failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "当前不在伤病模式"})
		return
	}
	c.JSON(http.StatusOK, injuryStateResponse{Injury: injuryOf(row)})
}

type checkinInjuryRequest struct {
	Answer string `json:"answer" binding:"required"`
}

// checkin answers the daily recovery question（伤怎么样：better/same/worse/
// recovered——不设静默期，每天一答幂等）。recovered → 200 {"closed":true}；
// worse → needs_verdict=true（mp 重新出四选一）；better/same 只记履历
// （维持量回抬由夜检 maintenance job 单一真源驱动）。
//
//	@Summary		Answer the daily recovery check-in
//	@Description	#858 PR-D: better/same 记履历；worse 要求重新四选一（needs_verdict）；recovered 退出模式。当天重复答幂等返回当前态。
//	@Tags			plan-injury
//	@Accept			json
//	@Produce		json
//	@Param			user_id	path	string					true	"User UUID (JWT sub; self only)"
//	@Param			body	body	checkinInjuryRequest	true	"Answer (better|same|worse|recovered)"
//	@Success		200		{object}	injuryStateResponse
//	@Success		200		{object}	injuryClosedResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/{user_id}/plan-injury/checkin [post]
func (p *planInjuryRoutes) checkin(c *gin.Context) {
	userID := c.Param("user_id")
	if !p.selfOnly(c, userID) {
		return
	}
	var body checkinInjuryRequest
	if err := c.ShouldBindJSON(&body); err != nil || !isInjuryCheckin(body.Answer) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_answer"})
		return
	}
	row, err := p.store.AnswerDailyCheckin(c.Request.Context(), userID, body.Answer)
	if errors.Is(err, storage.ErrInjuryNotFound) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "injury_not_found"})
		return
	}
	if errors.Is(err, storage.ErrInjuryCheckin) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_answer"})
		return
	}
	if err != nil {
		p.log.Error("injury checkin failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row == nil {
		c.JSON(http.StatusOK, injuryClosedResponse{Closed: true})
		return
	}
	c.JSON(http.StatusOK, injuryStateResponse{Injury: injuryOf(row)})
}

type doctorInjuryRequest struct {
	Verdict string `json:"verdict" binding:"required"`
}

// doctor resolves the pending_doctor mode（医生怎么说，三选一）。continue →
// 200 {"closed":true}；reduced/rest → 转模式。非待定行 409。
//
//	@Summary		Answer the doctor's verdict (pending mode resolution)
//	@Description	#858 PR-D: pending_doctor → continue（关闭）/ reduced（维持课）/ rest（完全停）。
//	@Tags			plan-injury
//	@Accept			json
//	@Produce		json
//	@Param			user_id	path	string					true	"User UUID (JWT sub; self only)"
//	@Param			body	body	doctorInjuryRequest	true	"Verdict (continue|reduced|rest)"
//	@Success		200		{object}	injuryStateResponse
//	@Success		200		{object}	injuryClosedResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/{user_id}/plan-injury/doctor [post]
func (p *planInjuryRoutes) doctor(c *gin.Context) {
	userID := c.Param("user_id")
	if !p.selfOnly(c, userID) {
		return
	}
	var body doctorInjuryRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}
	if body.Verdict != storage.PlanInjuryVerdictContinue && body.Verdict != storage.PlanInjuryVerdictReduced && body.Verdict != storage.PlanInjuryVerdictRest {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_verdict"})
		return
	}
	row, err := p.store.AnswerPendingDoctor(c.Request.Context(), userID, body.Verdict)
	if errors.Is(err, storage.ErrInjuryNotFound) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "injury_not_found"})
		return
	}
	if errors.Is(err, storage.ErrInjuryVerdict) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_verdict"})
		return
	}
	if errors.Is(err, storage.ErrInjuryState) {
		c.JSON(http.StatusConflict, errorResponse{Error: "injury_state_conflict"})
		return
	}
	if err != nil {
		p.log.Error("injury doctor verdict failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row == nil {
		c.JSON(http.StatusOK, injuryClosedResponse{Closed: true})
		return
	}
	c.JSON(http.StatusOK, injuryStateResponse{Injury: injuryOf(row)})
}

// ── 内部（worker / 夜检）通道 ───────────────────────────────────────────────

// stateInternal mirrors the user GET for the nightly scan (active 态判定) and
// the maintenance worker (mode gate + 锚读)。
//
//	@Summary		Get the active injury state (internal)
//	@Description	Internal-only (#858 PR-D). Returns the athlete's active injury row for the nightly scan / maintenance worker; 404 when none.
//	@Tags			plan-injury
//	@Produce		json
//	@Param			user_id	path	string	true	"Target user UUID"
//	@Success		200		{object}	injuryStateResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Security		InternalToken
//	@Router		/api/internal/users/{user_id}/plan-injury [get]
func (p *planInjuryRoutes) stateInternal(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	userID := c.Param("user_id")
	if _, err := uuid.Parse(userID); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return
	}
	row, err := p.store.GetInjuryState(c.Request.Context(), userID)
	if err != nil {
		p.log.Error("load injury state (internal) failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "该用户不在伤病模式"})
		return
	}
	c.JSON(http.StatusOK, injuryStateResponse{Injury: injuryOf(row)})
}

type maintenanceKmRequest struct {
	Km float64 `json:"km" binding:"required"`
}

// maintenance writes the re-estimated weekly volume anchor（TS maintenance
// job 是重估单一真源，Go 只存值）。仅 reduced 行接受（rest/pending 409）。
//
//	@Summary		Write the maintenance weekly km anchor (internal)
//	@Description	Internal-only (#858 PR-D). The generate_maintenance worker posts the re-estimated weekly volume; Go only stores it (single source of truth stays in TS).
//	@Tags			plan-injury
//	@Accept			json
//	@Produce		json
//	@Param			user_id	path	string					true	"Target user UUID"
//	@Param			body	body	maintenanceKmRequest	true	"Re-estimated weekly km (0 < km ≤ 999)"
//	@Success		200		{object}	injuryStateResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Security		InternalToken
//	@Router		/api/internal/users/{user_id}/plan-injury/maintenance [post]
func (p *planInjuryRoutes) maintenance(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	userID := c.Param("user_id")
	if _, err := uuid.Parse(userID); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return
	}
	var body maintenanceKmRequest
	if err := c.ShouldBindJSON(&body); err != nil || math.IsNaN(body.Km) || body.Km <= 0 || body.Km > 999 {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_km"})
		return
	}
	row, err := p.store.UpdateInjuryMaintenanceKm(c.Request.Context(), userID, body.Km)
	if errors.Is(err, storage.ErrInjuryNotFound) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "injury_not_found"})
		return
	}
	if errors.Is(err, storage.ErrInjuryState) {
		c.JSON(http.StatusConflict, errorResponse{Error: "injury_state_conflict"})
		return
	}
	if err != nil {
		p.log.Error("injury maintenance write failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, injuryStateResponse{Injury: injuryOf(row)})
}

// selfOnly enforces the user tier's self-scope（与 plan_adjustment 同款）。
func (p *planInjuryRoutes) selfOnly(c *gin.Context, userID string) bool {
	caller := callerFrom(c)
	if caller.Tier != TierUser {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return false
	}
	if _, err := uuid.Parse(userID); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return false
	}
	if caller.UserID != userID {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return false
	}
	return true
}

func isInjuryVerdict(verdict string) bool {
	switch verdict {
	case storage.PlanInjuryVerdictContinue, storage.PlanInjuryVerdictReduced,
		storage.PlanInjuryVerdictRest, storage.PlanInjuryVerdictUndecided:
		return true
	}
	return false
}

func isInjuryCheckin(answer string) bool {
	switch answer {
	case storage.PlanInjuryCheckinBetter, storage.PlanInjuryCheckinSame,
		storage.PlanInjuryCheckinWorse, storage.PlanInjuryCheckinRecovered:
		return true
	}
	return false
}
