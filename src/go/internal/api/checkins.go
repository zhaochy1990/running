package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/zhaochy1990/stride/internal/storage"
)

// CheckInStore is the check-in/points persistence port (devops#883). Satisfied
// by *storage.Store.
type CheckInStore interface {
	CreateCheckIn(ctx context.Context, userID string, now time.Time) (*storage.CheckInResult, error)
	GetCheckInStatus(ctx context.Context, userID string, now time.Time) (*storage.CheckInStatus, error)
	ListPointTransactions(ctx context.Context, userID, cursor string, limit int) (*storage.PointPage, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

// checkInResponse is the POST /api/users/me/check-ins body. On a same-day
// duplicate the server repeats the stored snapshots with points_earned 0 and
// already_checked_in true — never an error status (#847 resolution item 8).
type checkInResponse struct {
	AlreadyCheckedIn bool `json:"already_checked_in"`
	StreakDays       int  `json:"streak_days"`
	CyclePosition    int  `json:"cycle_position"`
	PointsEarned     int  `json:"points_earned"`
	Balance          int  `json:"balance"`
	// D7Completed feeds the cycle-completion easter egg (#851).
	D7Completed bool `json:"d7_completed"`
}

type checkInTodayBlock struct {
	Date               string `json:"date"`
	CanCheckIn         bool   `json:"can_check_in"`
	RewardPreview      int    `json:"reward_preview"`
	WouldStartNewCycle bool   `json:"would_start_new_cycle"`
}

type checkInCycleCell struct {
	Position int    `json:"position"`
	Points   int    `json:"points"`
	Status   string `json:"status"` // checked | today | upcoming
}

type checkInMonthEntry struct {
	Date   string `json:"date"`
	Points int    `json:"points"`
}

type checkInMonthBlock struct {
	Label   string              `json:"label"`
	Checked []checkInMonthEntry `json:"checked"`
}

// checkInStatusResponse is the GET /api/users/me/check-ins/status body: the
// whole check-in page in one read (today + 7-slot cycle grid + month grid +
// balance).
type checkInStatusResponse struct {
	Today      checkInTodayBlock  `json:"today"`
	StreakDays int                `json:"streak_days"`
	Cycle      []checkInCycleCell `json:"cycle"`
	Balance    int                `json:"balance"`
	Month      checkInMonthBlock  `json:"month"`
}

type pointTransactionResponse struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"`
	Amount    int     `json:"amount"`
	Ref       string  `json:"ref"`
	Remark    *string `json:"remark"`
	CreatedAt string  `json:"created_at"`
}

// pointsResponse is the GET /api/users/me/points body: balance plus a
// newest-first ledger page with an opaque next_cursor.
type pointsResponse struct {
	Balance      int                        `json:"balance"`
	Transactions []pointTransactionResponse `json:"transactions"`
	NextCursor   *string                    `json:"next_cursor"`
}

const dayFormat = "2006-01-02"

func (u *userRoutes) checkInStore() CheckInStore {
	return u.checkins
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// createCheckIn godoc
//
//	@Summary		Check in for today
//	@Description	Records today's check-in and its earn_checkin points in one transaction. A same-day duplicate returns 200 with already_checked_in=true, zero side effects and zero extra points. d7_completed marks the moment a 7-day cycle completes (client easter egg).
//	@Tags			checkins
//	@Produce		json
//	@Success		200	{object}	checkInResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/check-ins [post]
func (u *userRoutes) createCheckIn(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	store := u.checkInStore()
	if store == nil {
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "check-ins unavailable"})
		return
	}
	res, err := store.CreateCheckIn(c.Request.Context(), uid, time.Now())
	if err != nil {
		u.log.Error("create check-in failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, checkInResponse{
		AlreadyCheckedIn: res.AlreadyCheckedIn,
		StreakDays:       res.StreakDays,
		CyclePosition:    res.CyclePosition,
		PointsEarned:     res.PointsEarned,
		Balance:          res.Balance,
		D7Completed:      res.D7Completed,
	})
}

// getCheckInStatus godoc
//
//	@Summary		Get the check-in page state
//	@Description	Returns today's check-in state (can_check_in, reward preview, would-start-new-cycle), the 7-slot cycle grid, the current-month checked days with earned points, the streak, and the points balance.
//	@Tags			checkins
//	@Produce		json
//	@Success		200	{object}	checkInStatusResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/check-ins/status [get]
func (u *userRoutes) getCheckInStatus(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	store := u.checkInStore()
	if store == nil {
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "check-ins unavailable"})
		return
	}
	st, err := store.GetCheckInStatus(c.Request.Context(), uid, time.Now())
	if err != nil {
		u.log.Error("get check-in status failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	cycle := make([]checkInCycleCell, len(st.Cycle))
	for i, cell := range st.Cycle {
		cycle[i] = checkInCycleCell{Position: cell.Position, Points: cell.Points, Status: cell.Status}
	}
	checked := make([]checkInMonthEntry, len(st.MonthChecked))
	for i, m := range st.MonthChecked {
		checked[i] = checkInMonthEntry{Date: m.Date.Format(dayFormat), Points: m.Points}
	}
	c.JSON(http.StatusOK, checkInStatusResponse{
		Today: checkInTodayBlock{
			Date:               st.Date.Format(dayFormat),
			CanCheckIn:         st.CanCheckIn,
			RewardPreview:      st.RewardPreview,
			WouldStartNewCycle: st.WouldStartNewCycle,
		},
		StreakDays: st.StreakDays,
		Cycle:      cycle,
		Balance:    st.Balance,
		Month:      checkInMonthBlock{Label: st.MonthLabel, Checked: checked},
	})
}

// listPoints godoc
//
//	@Summary		List the current user's points balance and ledger
//	@Description	Returns the points balance and a newest-first page of point transactions. Cursor pagination is opaque and limited to 50 entries per page.
//	@Tags			checkins
//	@Produce		json
//	@Param			limit	query	int		false	"Page size (1-50; default 50)"
//	@Param			cursor	query	string	false	"Opaque page cursor"
//	@Success		200	{object}	pointsResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		422	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/points [get]
func (u *userRoutes) listPoints(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	store := u.checkInStore()
	if store == nil {
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "check-ins unavailable"})
		return
	}
	limit := 0
	if raw := c.Query("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{Loc: []string{"query", "limit"}, Msg: "must be an integer"}}})
			return
		}
		limit = parsed
	}
	page, err := store.ListPointTransactions(c.Request.Context(), uid, c.Query("cursor"), limit)
	if err != nil {
		var cursorErr *storage.PointCursorError
		var validationErr *storage.PointValidationError
		switch {
		case errors.As(err, &cursorErr):
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid cursor"})
		case errors.As(err, &validationErr):
			c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{Loc: []string{"query", "limit"}, Msg: validationErr.Error()}}})
		default:
			u.log.Error("list point transactions failed", zapErr(err))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		}
		return
	}
	items := make([]pointTransactionResponse, len(page.Items))
	for i, row := range page.Items {
		items[i] = pointTransactionResponse{
			ID: row.ID, Type: row.Type, Amount: row.Amount, Ref: row.Ref,
			Remark: row.Remark, CreatedAt: row.CreatedAt.UTC().Format(timeFormat),
		}
	}
	var next *string
	if page.NextCursor != "" {
		next = &page.NextCursor
	}
	c.JSON(http.StatusOK, pointsResponse{Balance: page.Balance, Transactions: items, NextCursor: next})
}
