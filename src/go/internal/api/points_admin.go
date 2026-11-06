// points_admin.go is the admin user-balances surface (devops#914): the
// paginated balance list (names resolved through the auth service, fail-soft
// to raw ids), the operations adjustment (delta in, mandatory reason, the
// one write path allowed to push a balance negative), and the per-user
// ledger view for the audit trail.
package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"

	"github.com/zhaochy1990/stride/internal/authsvc"
	"github.com/zhaochy1990/stride/internal/storage"
)

// authUserLookup is the auth-service slice the balances surface needs:
// per-user name resolution and the phone search. Satisfied by
// *authsvc.Client; a nil lookup degrades names to raw ids and answers phone
// search with 503.
type authUserLookup interface {
	AdminGetUser(ctx context.Context, adminBearer, userID string) (*authsvc.AdminUser, error)
	AdminListUsers(ctx context.Context, adminBearer, search string) ([]authsvc.AdminUser, error)
}

// Name-resolution budget: a page resolve runs bounded and fail-soft, so a
// hanging auth service stretches the page by at most this much before the
// unresolved rows fall back to raw ids.
const (
	adminNameResolveBudget      = 5 * time.Second
	adminNameResolveConcurrency = 5
)

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

// adminBalanceResponse is one balances row: the stored balance plus the
// resolved name (nil = lookup failed or user gone — the console renders the
// raw id) and every bound watch provider (empty = 未绑定手表).
type adminBalanceResponse struct {
	UserID    string   `json:"user_id"`
	Name      *string  `json:"name"`
	Providers []string `json:"providers"`
	Balance   int      `json:"balance"`
	UpdatedAt string   `json:"updated_at"`
}

type adminBalancesResponse struct {
	Balances   []adminBalanceResponse `json:"balances"`
	NextCursor *string                `json:"next_cursor"`
}

// adminPointAdjustRequest is the POST adjustments body. amount is the signed
// delta (increase > 0, deduct < 0), reason the mandatory operations note that
// lands verbatim in the ledger remark. Validated by hand (not binding tags)
// so every rejection is the 422 validation shape the ticket pins.
type adminPointAdjustRequest struct {
	Amount int    `json:"amount"`
	Reason string `json:"reason"`
}

// adminPointAdjustResponse is the POST adjustments body: the authoritative
// post-adjustment balance (a concurrent check-in may have moved it past the
// admin's UI preview) plus the created ledger row.
type adminPointAdjustResponse struct {
	UserID      string                   `json:"user_id"`
	Balance     int                      `json:"balance"`
	Transaction pointTransactionResponse `json:"transaction"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// adminListBalances serves GET /api/admin/points/balances — every user with a
// user_points row (zero-balance included; users who never earned or redeemed
// have no row and never appear), keyset-paginated under one of three sort
// modes. user_id filters exact; phone resolves through the auth service to an
// exact-match id set before the query runs.
//
//	@Summary		List user point balances (admin)
//	@Description	Returns every user with a points row (zero-balance included), one of three sort modes (updated_at_desc default, balance_desc, balance_asc) with an opaque next_cursor. user_id filters exact; phone resolves via the auth service to an exact phone match and answers an empty page when nobody carries it.
//	@Tags			points-admin
//	@Produce		json
//	@Param			sort		query	string	false	"Sort mode (updated_at_desc|balance_desc|balance_asc)"
//	@Param			user_id		query	string	false	"Exact user UUID filter"
//	@Param			phone		query	string	false	"Exact phone filter (resolved via auth service)"
//	@Param			limit		query	int		false	"Page size (1-50; default 20)"
//	@Param			cursor		query	string	false	"Opaque page cursor (minted for the same sort mode)"
//	@Success		200			{object}	adminBalancesResponse
//	@Failure		400			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		422			{object}	errorResponse
//	@Failure		503			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/points/balances [get]
func (p *pointsRoutes) adminListBalances(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	sortMode := c.Query("sort")
	if sortMode == "" {
		sortMode = storage.PointBalanceSortUpdatedAtDesc
	}
	if !storage.IsPointBalanceSort(sortMode) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_sort"})
		return
	}
	limit, ok := parseLimitQuery(c)
	if !ok {
		return
	}
	userID := c.Query("user_id")
	phone := c.Query("phone")
	if userID != "" && phone != "" {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_filter"})
		return
	}
	if userID != "" {
		if !isCanonicalUserUUID(userID) {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
			return
		}
	}
	var phoneIDs []string
	if phone != "" {
		if p.auth == nil {
			c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "auth_unavailable"})
			return
		}
		users, err := p.auth.AdminListUsers(c.Request.Context(), bearerFrom(c), phone)
		if err != nil {
			p.log.Error("admin balances: auth phone search failed", zapErr(err))
			c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "auth_unavailable"})
			return
		}
		for i := range users {
			if users[i].Phone != nil && *users[i].Phone == phone {
				phoneIDs = append(phoneIDs, users[i].ID)
			}
		}
		if len(phoneIDs) == 0 {
			// The phone belongs to no auth user (or to users without a points
			// row): an empty page, not an error.
			c.JSON(http.StatusOK, adminBalancesResponse{Balances: []adminBalanceResponse{}})
			return
		}
	}

	page, err := p.store.AdminListPointBalances(c.Request.Context(), sortMode, c.Query("cursor"), limit, userID, phoneIDs)
	if err != nil {
		writePointPageError(c, p.log, err, "admin list balances failed")
		return
	}

	names := resolveAdminNames(c.Request.Context(), p.auth, bearerFrom(c), page.Items, p.log)
	resp := adminBalancesResponse{Balances: make([]adminBalanceResponse, 0, len(page.Items))}
	for i := range page.Items {
		providers := page.Items[i].Providers
		if providers == nil {
			providers = []string{}
		}
		resp.Balances = append(resp.Balances, adminBalanceResponse{
			UserID: page.Items[i].UserID, Name: names[page.Items[i].UserID],
			Providers: providers, Balance: page.Items[i].Balance,
			UpdatedAt: page.Items[i].UpdatedAt.UTC().Format(timeFormat),
		})
	}
	if page.NextCursor != "" {
		resp.NextCursor = &page.NextCursor
	}
	c.JSON(http.StatusOK, resp)
}

// adminAdjustBalance serves POST /api/admin/points/balances/:user_id/adjustments
// — the operations adjustment. amount is a signed delta, reason is mandatory
// and lands verbatim in the ledger remark; the balance is allowed to go
// negative by design (欠账 semantics, ADR), and the response carries the
// authoritative post-commit balance.
//
//	@Summary		Adjust a user's point balance (admin)
//	@Description	Applies a signed points delta in one transaction with an append-only adjust ledger row whose remark carries the mandatory reason. The balance may go negative (operations deduction). Returns the authoritative post-commit balance and the ledger row.
//	@Tags			points-admin
//	@Accept			json
//	@Produce		json
//	@Param			user_id	path	string						true	"Target user UUID"
//	@Param			body	body	adminPointAdjustRequest		true	"Adjustment"
//	@Success		200		{object}	adminPointAdjustResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/points/balances/{user_id}/adjustments [post]
func (p *pointsRoutes) adminAdjustBalance(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	uid, ok := parseCanonicalUserParam(c)
	if !ok {
		return
	}
	var body adminPointAdjustRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	if !validatePointAdjustBody(c, body) {
		return
	}
	res, err := p.store.AdminAdjustPointBalance(c.Request.Context(), uid, body.Amount, body.Reason, time.Now().UTC())
	if err != nil {
		var validationErr *storage.PointValidationError
		switch {
		case errors.As(err, &validationErr):
			c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{Loc: []string{"body", "amount"}, Msg: validationErr.Error()}}})
		default:
			p.log.Error("admin adjust balance failed", zapErr(err))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		}
		return
	}
	row := res.Transaction
	c.JSON(http.StatusOK, adminPointAdjustResponse{
		UserID: uid, Balance: res.Balance,
		Transaction: pointTransactionResponseFrom(row),
	})
}

// adminListUserTransactions serves GET /api/admin/points/balances/:user_id/transactions
// — the per-user ledger for the admin console's audit trail, the same
// projection the user-facing points page gets.
//
//	@Summary		List one user's point ledger (admin)
//	@Description	Returns the target user's balance and one keyset-cursor ledger page (same shape and cursor order as the user-facing points endpoint).
//	@Tags			points-admin
//	@Produce		json
//	@Param			user_id	path	string	true	"Target user UUID"
//	@Param			limit	query	int		false	"Page size (1-50; default 50)"
//	@Param			cursor	query	string	false	"Opaque page cursor"
//	@Success		200		{object}	pointsResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/points/balances/{user_id}/transactions [get]
func (p *pointsRoutes) adminListUserTransactions(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	uid, ok := parseCanonicalUserParam(c)
	if !ok {
		return
	}
	limit, ok := parseLimitQuery(c)
	if !ok {
		return
	}
	page, err := p.store.ListPointTransactions(c.Request.Context(), uid, c.Query("cursor"), limit)
	if err != nil {
		writePointPageError(c, p.log, err, "admin list user transactions failed")
		return
	}
	items := make([]pointTransactionResponse, len(page.Items))
	for i, row := range page.Items {
		items[i] = pointTransactionResponseFrom(row)
	}
	var next *string
	if page.NextCursor != "" {
		next = &page.NextCursor
	}
	c.JSON(http.StatusOK, pointsResponse{Balance: page.Balance, Transactions: items, NextCursor: next})
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// pointTransactionResponseFrom projects one ledger row; the single mapping
// source for the adjust response and the per-user ledger page.
func pointTransactionResponseFrom(row *storage.PointTransaction) pointTransactionResponse {
	return pointTransactionResponse{
		ID: row.ID, Type: row.Type, Amount: row.Amount, Ref: row.Ref,
		Remark: row.Remark, CreatedAt: row.CreatedAt.UTC().Format(timeFormat),
	}
}

// writePointPageError maps the read-side points vocabulary (malformed cursor,
// out-of-range page size, everything else) onto status codes for the admin
// balances surface. logMsg only names the caller in the error log.
func writePointPageError(c *gin.Context, log *zap.Logger, err error, logMsg string) {
	var cursorErr *storage.PointCursorError
	var validationErr *storage.PointValidationError
	switch {
	case errors.As(err, &cursorErr):
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid cursor"})
	case errors.As(err, &validationErr):
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{Loc: []string{"query", "limit"}, Msg: validationErr.Error()}}})
	default:
		log.Error(logMsg, zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
	}
}

// isCanonicalUserUUID reports whether s is a canonical lowercase hyphenated
// UUID (same strictness as the account-erasure route's target check).
func isCanonicalUserUUID(s string) bool {
	parsed, err := uuid.Parse(s)
	return err == nil && parsed.String() == s
}

// parseCanonicalUserParam validates a :user_id path parameter into its
// canonical form, answering 400 invalid_user otherwise.
func parseCanonicalUserParam(c *gin.Context) (string, bool) {
	raw := c.Param("user_id")
	if !isCanonicalUserUUID(raw) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return "", false
	}
	return raw, true
}

// validatePointAdjustBody applies the ticket-pinned 422 contract: non-zero
// amount within ±1,000,000 and a non-blank reason. The reason cap is counted
// in characters (utf8 runes), matching the remark column's varchar(255)
// semantics under utf8mb4. Returns false after writing the validation response.
func validatePointAdjustBody(c *gin.Context, body adminPointAdjustRequest) bool {
	detail := make([]validationDetailItem, 0, 2)
	if body.Amount == 0 {
		detail = append(detail, validationDetailItem{Loc: []string{"body", "amount"}, Msg: "amount must be a non-zero integer"})
	} else if body.Amount > storage.MaxPointAdjustAmount || body.Amount < -storage.MaxPointAdjustAmount {
		detail = append(detail, validationDetailItem{Loc: []string{"body", "amount"}, Msg: "amount must be within ±1000000"})
	}
	if strings.TrimSpace(body.Reason) == "" {
		detail = append(detail, validationDetailItem{Loc: []string{"body", "reason"}, Msg: "reason is required"})
	} else if utf8.RuneCountInString(body.Reason) > 255 {
		detail = append(detail, validationDetailItem{Loc: []string{"body", "reason"}, Msg: "reason must be at most 255 characters"})
	}
	if len(detail) > 0 {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: detail})
		return false
	}
	return true
}

// resolveAdminNames fills the name for each balances row through the auth
// service, bounded in concurrency and total time. Every per-row failure
// (unknown or deleted user, auth hiccup, budget spent) degrades to a missing
// entry — the console renders the raw id — because a naming outage must never
// take the balances list down with it.
func resolveAdminNames(ctx context.Context, auth authUserLookup, bearer string, items []storage.AdminPointBalance, log *zap.Logger) map[string]*string {
	names := make(map[string]*string, len(items))
	if auth == nil || len(items) == 0 {
		return names
	}
	ctx, cancel := context.WithTimeout(ctx, adminNameResolveBudget)
	defer cancel()
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(adminNameResolveConcurrency)
	var mu sync.Mutex
	for i := range items {
		uid := items[i].UserID
		g.Go(func() error {
			u, err := auth.AdminGetUser(gctx, bearer, uid)
			if err != nil {
				log.Warn("admin balances: name resolve failed", zap.String("user_id", uid), zapErr(err))
				return nil
			}
			if u.Name != nil {
				mu.Lock()
				names[uid] = u.Name
				mu.Unlock()
			}
			return nil
		})
	}
	_ = g.Wait()
	return names
}
