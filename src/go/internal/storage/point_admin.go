// point_admin.go is the admin-side points surface (devops#914): the balance
// list (keyset cursor pagination over user_points with three sort modes), the
// per-user watch-provider map for the balances list, and the operations
// adjustment transaction — the second production writer of the adjust ledger
// type (the first is the devops#904 timeout sweep). The adjustment is
// deliberately unguarded below zero: the balance may go negative on an
// operations deduction (欠账 semantics, decided 2026-11-06, ADR in
// docs/adr/), unlike the redemption deduction which guards balance >= cost.
package storage

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Balance-list sort modes (devops#914). The cursor embeds the mode, and a
// cursor minted for another mode is rejected rather than silently re-sorted —
// the keyset tuple only compares correctly against its own ordering.
const (
	PointBalanceSortUpdatedAtDesc = "updated_at_desc"
	PointBalanceSortBalanceDesc   = "balance_desc"
	PointBalanceSortBalanceAsc    = "balance_asc"
)

// IsPointBalanceSort reports whether s is a storable balance-list sort mode.
func IsPointBalanceSort(s string) bool {
	return s == PointBalanceSortUpdatedAtDesc ||
		s == PointBalanceSortBalanceDesc ||
		s == PointBalanceSortBalanceAsc
}

const (
	// DefaultAdminBalanceLimit is the admin balances page size.
	DefaultAdminBalanceLimit = 20
	MaxAdminBalanceLimit     = 50
	// MaxPointAdjustAmount bounds one adjustment in either direction. It
	// guards against fat-fingered zeros, not against policy.
	MaxPointAdjustAmount = 1_000_000
)

// AdminPointBalance is one user_points row enriched with the user's bound
// watch providers. Every bound provider is listed: the one-watch invariant is
// a product rule, and a double-bind is exactly what the admin console should
// surface, not hide.
type AdminPointBalance struct {
	UserID    string
	Balance   int
	UpdatedAt time.Time
	Providers []string
}

// AdminPointBalancePage is one bounded page of the balances list.
type AdminPointBalancePage struct {
	Items      []AdminPointBalance
	NextCursor string
}

// PointAdjustmentResult is the POST adjustments response payload: the new
// ledger row plus the post-adjustment balance (authoritative — a concurrent
// check-in may have moved the balance after the admin's UI preview).
type PointAdjustmentResult struct {
	Transaction *PointTransaction
	Balance     int
}

type adminBalanceCursor struct {
	Sort string `json:"k"`
	// Key is the sort value of the page's last row: RFC3339Nano UTC for the
	// updated_at sorts, the decimal balance for the balance sorts.
	Key    string `json:"s"`
	UserID string `json:"u"`
}

func encodeAdminBalanceCursor(c adminBalanceCursor) (string, error) {
	body, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(body), nil
}

func decodeAdminBalanceCursor(raw string) (adminBalanceCursor, error) {
	var c adminBalanceCursor
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || json.Unmarshal(body, &c) != nil ||
		!IsPointBalanceSort(c.Sort) || c.Key == "" || c.UserID == "" {
		return c, &PointCursorError{Message: "invalid balances cursor"}
	}
	if _, err := uuid.Parse(c.UserID); err != nil {
		return c, &PointCursorError{Message: "invalid balances cursor"}
	}
	return c, nil
}

// AdminListPointBalances pages user_points newest-first (or by balance) with
// an injuries-style keyset cursor; userID (exact) and phoneIDs (a resolved
// user-id set) are optional AND-ed filters. A phoneIDs slice that is non-nil
// but empty matches nothing and yields an empty page — the API layer resolves
// the phone through the auth service before it ever reaches this query.
func (s *Store) AdminListPointBalances(ctx context.Context, sort, cursor string, limit int, userID string, phoneIDs []string) (*AdminPointBalancePage, error) {
	if sort == "" {
		sort = PointBalanceSortUpdatedAtDesc
	}
	if !IsPointBalanceSort(sort) {
		return nil, &PointValidationError{Message: "sort must be updated_at_desc, balance_desc or balance_asc"}
	}
	if limit == 0 {
		limit = DefaultAdminBalanceLimit
	}
	if limit < 1 || limit > MaxAdminBalanceLimit {
		return nil, &PointValidationError{Message: fmt.Sprintf("limit must be between 1 and %d", MaxAdminBalanceLimit)}
	}

	query := s.db.WithContext(ctx).Model(&UserPoint{})
	if userID != "" {
		uid, err := canonicalUserID(userID)
		if err != nil {
			return nil, err
		}
		query = query.Where("user_id = ?", uid)
	}
	if phoneIDs != nil {
		if len(phoneIDs) == 0 {
			return &AdminPointBalancePage{Items: []AdminPointBalance{}}, nil
		}
		ids, err := canonicalUserIDs(phoneIDs)
		if err != nil {
			return nil, err
		}
		query = query.Where("user_id IN ?", ids)
	}
	if cursor != "" {
		c, err := decodeAdminBalanceCursor(cursor)
		if err != nil {
			return nil, err
		}
		if c.Sort != sort {
			return nil, &PointCursorError{Message: "cursor sort mismatch"}
		}
		switch sort {
		case PointBalanceSortUpdatedAtDesc:
			t, err := time.Parse(time.RFC3339Nano, c.Key)
			if err != nil {
				return nil, &PointCursorError{Message: "invalid balances cursor"}
			}
			query = query.Where(
				"(updated_at < ? OR (updated_at = ? AND user_id < ?))", t, t, c.UserID,
			)
		case PointBalanceSortBalanceDesc:
			bal, err := strconv.Atoi(c.Key)
			if err != nil {
				return nil, &PointCursorError{Message: "invalid balances cursor"}
			}
			query = query.Where(
				"(balance < ? OR (balance = ? AND user_id < ?))", bal, bal, c.UserID,
			)
		case PointBalanceSortBalanceAsc:
			bal, err := strconv.Atoi(c.Key)
			if err != nil {
				return nil, &PointCursorError{Message: "invalid balances cursor"}
			}
			query = query.Where(
				"(balance > ? OR (balance = ? AND user_id > ?))", bal, bal, c.UserID,
			)
		}
	}

	var rows []UserPoint
	if err := query.Order(balanceSortOrder(sort)).Limit(limit + 1).Find(&rows).Error; err != nil {
		return nil, err
	}
	page := &AdminPointBalancePage{Items: make([]AdminPointBalance, 0, len(rows))}
	for i := range rows {
		page.Items = append(page.Items, AdminPointBalance{
			UserID: rows[i].UserID, Balance: rows[i].Balance, UpdatedAt: rows[i].UpdatedAt,
		})
	}
	if len(rows) > limit {
		last := rows[limit-1]
		key := strconv.Itoa(last.Balance)
		if sort == PointBalanceSortUpdatedAtDesc {
			key = last.UpdatedAt.UTC().Format(time.RFC3339Nano)
		}
		encoded, err := encodeAdminBalanceCursor(adminBalanceCursor{
			Sort: sort, Key: key, UserID: last.UserID,
		})
		if err != nil {
			return nil, err
		}
		page.Items = page.Items[:limit]
		page.NextCursor = encoded
	}

	providers, err := s.providersByUser(ctx, pageUserIDs(page.Items))
	if err != nil {
		return nil, err
	}
	for i := range page.Items {
		page.Items[i].Providers = providers[page.Items[i].UserID]
	}
	return page, nil
}

func balanceSortOrder(sort string) string {
	switch sort {
	case PointBalanceSortBalanceDesc:
		return "balance DESC, user_id DESC"
	case PointBalanceSortBalanceAsc:
		return "balance ASC, user_id ASC"
	default:
		return "updated_at DESC, user_id DESC"
	}
}

func pageUserIDs(items []AdminPointBalance) []string {
	ids := make([]string, len(items))
	for i := range items {
		ids[i] = items[i].UserID
	}
	return ids
}

// providersByUser maps each user id to its bound watch providers, newest
// binding first. Rows are hard-deleted on unbind, so an absent key simply
// means "no watch bound" — the caller renders 未绑定 from the empty slice.
func (s *Store) providersByUser(ctx context.Context, userIDs []string) (map[string][]string, error) {
	out := make(map[string][]string, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	var rows []struct {
		UserID   string
		Provider string
	}
	if err := s.db.WithContext(ctx).Model(&ProviderCredential{}).
		Select("user_id, provider").
		Where("user_id IN ?", userIDs).
		Order("updated_at DESC").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.UserID] = append(out[r.UserID], r.Provider)
	}
	return out, nil
}

// AdminAdjustPointBalance applies one operations adjustment in a single
// transaction: zero-balance row bootstrap (mirroring the deduction's), the
// unguarded balance UPDATE — the one write path allowed to push a balance
// negative — and the append-only adjust ledger row whose remark carries the
// mandatory operations reason. The returned balance is read back inside the
// transaction, so it is the authoritative post-commit value.
func (s *Store) AdminAdjustPointBalance(ctx context.Context, userID string, amount int, reason string, now time.Time) (*PointAdjustmentResult, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if amount == 0 || amount > MaxPointAdjustAmount || amount < -MaxPointAdjustAmount {
		return nil, &PointValidationError{Message: fmt.Sprintf("amount must be a non-zero integer between -%d and %d", MaxPointAdjustAmount, MaxPointAdjustAmount)}
	}
	nowUTC := now.UTC()
	var result *PointAdjustmentResult
	txErr := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// The check-in earn path's atomic upsert, with the delta possibly
		// negative: no explicit lock, concurrency-safe by MySQL's
		// ON DUPLICATE KEY UPDATE, and it bootstraps the row for a user who
		// never earned (first insert lands at balance=amount). No balance
		// guard by design — this is the欠账 write (see package doc).
		if err := tx.Exec(
			"INSERT INTO user_points (user_id, balance, updated_at) VALUES (?, ?, ?) "+
				"ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance), updated_at = VALUES(updated_at)",
			uid, amount, nowUTC,
		).Error; err != nil {
			return err
		}
		ledger := &PointTransaction{
			ID: uuid.NewString(), UserID: uid,
			Type: PointTypeAdjust, Amount: amount, Ref: "", Remark: &reason,
			CreatedAt: nowUTC,
		}
		if err := tx.Create(ledger).Error; err != nil {
			return err
		}
		balance, err := readBalance(tx, uid)
		if err != nil {
			return err
		}
		result = &PointAdjustmentResult{Transaction: ledger, Balance: balance}
		return nil
	})
	if txErr != nil {
		return nil, txErr
	}
	return result, nil
}
