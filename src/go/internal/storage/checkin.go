package storage

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// ─────────────────────────────────────────────────────────────────────────────
// Calendar + reward primitives (devops#847 resolution is authoritative)
// ─────────────────────────────────────────────────────────────────────────────

// shanghaiLoc is a fixed UTC+8 zone. Asia/Shanghai has had no DST since 1991,
// so the fixed offset is exact and avoids a tzdata dependency in scratch
// containers. The day boundary that flips "today can check in" is Shanghai
// midnight (#847 resolution item 2).
var shanghaiLoc = time.FixedZone("Asia/Shanghai", 8*3600)

// shanghaiDay returns the Asia/Shanghai calendar day containing t, normalized
// to UTC midnight so DATE columns round-trip exactly under the loc=UTC DSN.
func shanghaiDay(t time.Time) time.Time {
	y, m, d := t.In(shanghaiLoc).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// cycleRewards is the #847 reward table: D1-D4 earn 1 point each, D5/D6 earn 2
// each, D7 earns 3 — a full cycle pays 11 points.
var cycleRewards = [7]int{1, 1, 1, 1, 2, 2, 3}

// rewardForPosition returns the payout for cycle position pos (1-7).
func rewardForPosition(pos int) int {
	if pos < 1 || pos > 7 {
		return cycleRewards[0]
	}
	return cycleRewards[pos-1]
}

// ─────────────────────────────────────────────────────────────────────────────
// Migrations (API only — the worker never touches these three tables)
// ─────────────────────────────────────────────────────────────────────────────

// AutoMigrateCheckIn creates or reconciles the check_in_records table.
func (s *Store) AutoMigrateCheckIn(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&CheckInRecord{}); err != nil {
		return fmt.Errorf("storage: automigrate check-in: %w", err)
	}
	return nil
}

// AutoMigratePoints creates or reconciles the point_transactions + user_points
// tables plus the redemption-side point_products + point_redemptions tables
// (devops#850 resolution extends this migration over the #883 ledger pair;
// devops#909 adds point_product_skus and the products.spec_mode column).
func (s *Store) AutoMigratePoints(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&PointTransaction{}, &UserPoint{},
		&PointProduct{}, &PointRedemption{}, &PointProductSku{}); err != nil {
		return fmt.Errorf("storage: automigrate points: %w", err)
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/me/check-ins — single-transaction three-write check-in
// ─────────────────────────────────────────────────────────────────────────────

// CheckInResult is the POST /api/users/me/check-ins response payload. On a
// same-day duplicate it repeats the morning's snapshots with points_earned 0
// and zero side effects (#847 resolution item 8).
type CheckInResult struct {
	AlreadyCheckedIn bool
	StreakDays       int
	CyclePosition    int
	PointsEarned     int
	Balance          int
	// D7Completed marks the cycle-completion moment for the client's easter
	// egg (#851). On a duplicate it reflects the stored row.
	D7Completed bool
}

// errCheckInLostRace marks a check-in transaction that lost the same-day
// unique-key race: the tx made no writes and was rolled back, and the
// committed row is read on a fresh connection to build the idempotent answer.
var errCheckInLostRace = errors.New("storage: check-in lost the same-day race")

// CreateCheckIn records the caller's check-in for the current Shanghai day in
// one transaction: INSERT check-in row (uk_user_date is the idempotency
// anchor) → INSERT earn_checkin ledger row → atomic balance upsert. A
// same-day concurrent double submit loses the uk_user_date race and turns
// idempotent: the losing transaction aborts with zero side effects and the
// committed row is re-read to answer AlreadyCheckedIn with zero points
// (#847 resolution item 8).
func (s *Store) CreateCheckIn(ctx context.Context, userID string, now time.Time) (*CheckInResult, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	day := shanghaiDay(now)
	yesterday := day.AddDate(0, 0, -1)
	nowUTC := now.UTC()

	var result *CheckInResult
	txErr := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// The streak/cycle truth is the date sequence; yesterday's immutable
		// snapshot chains it one day forward without unbounded history scans
		// (#848 resolution: snapshots are never rewritten, so they are exact).
		var prev CheckInRecord
		position := 1
		err := tx.Where("user_id = ? AND check_in_date = ?", uid, yesterday).First(&prev).Error
		switch {
		case err == nil:
			if prev.CyclePosition < 7 {
				position = prev.CyclePosition + 1
			}
		case errors.Is(err, gorm.ErrRecordNotFound):
			// Broken streak (or first ever): today is a new cycle's D1.
		default:
			return err
		}
		points := rewardForPosition(position)

		row := &CheckInRecord{
			ID: uuid.NewString(), UserID: uid, CheckInDate: day,
			StreakDays: position, CyclePosition: position, PointsEarned: points,
			Source: CheckInSourceDaily, CreatedAt: nowUTC,
		}
		if err := tx.Create(row).Error; err != nil {
			// Lost the race. 1213 rides along when several losers holding
			// shared dup-key locks try to upgrade at once — same treatment.
			if n, ok := mysqlErrNo(err); ok && (n == 1062 || n == 1213) {
				return errCheckInLostRace
			}
			return err
		}

		ledger := &PointTransaction{
			ID: uuid.NewString(), UserID: uid,
			Type: PointTypeEarnCheckin, Amount: points, Ref: row.ID,
			CreatedAt: nowUTC,
		}
		if err := tx.Create(ledger).Error; err != nil {
			return err
		}
		// Atomic balance upsert: no explicit lock, concurrency-safe by MySQL's
		// ON DUPLICATE KEY UPDATE (#848 resolution).
		if err := tx.Exec(
			"INSERT INTO user_points (user_id, balance, updated_at) VALUES (?, ?, ?) "+
				"ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance), updated_at = VALUES(updated_at)",
			uid, points, nowUTC,
		).Error; err != nil {
			return err
		}
		balance, err := readBalance(tx, uid)
		if err != nil {
			return err
		}
		result = &CheckInResult{
			StreakDays: position, CyclePosition: position, PointsEarned: points,
			Balance: balance, D7Completed: position == 7,
		}
		return nil
	})
	if errors.Is(txErr, errCheckInLostRace) {
		// The winning transaction committed before the loser's INSERT reported
		// the duplicate, so an auto-commit read sees the final row.
		return s.idempotentCheckInResult(ctx, uid, day)
	}
	if txErr != nil {
		return nil, txErr
	}
	return result, nil
}

// idempotentCheckInResult reads the committed same-day row plus balance with
// zero writes — the shape of a same-day duplicate response.
func (s *Store) idempotentCheckInResult(ctx context.Context, uid string, day time.Time) (*CheckInResult, error) {
	var existing CheckInRecord
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND check_in_date = ?", uid, day).First(&existing).Error; err != nil {
		return nil, err
	}
	balance, err := readBalance(s.db.WithContext(ctx), uid)
	if err != nil {
		return nil, err
	}
	return &CheckInResult{
		AlreadyCheckedIn: true,
		StreakDays:       existing.StreakDays, CyclePosition: existing.CyclePosition,
		PointsEarned: 0, Balance: balance,
		D7Completed: existing.CyclePosition == 7,
	}, nil
}

// readBalance reads one user's materialized balance; an absent row means 0.
func readBalance(tx *gorm.DB, uid string) (int, error) {
	var row UserPoint
	err := tx.Where("user_id = ?", uid).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return row.Balance, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/me/check-ins/status — today + cycle grid + month + balance
// ─────────────────────────────────────────────────────────────────────────────

// CheckInCycleCell is one slot of the 7-position cycle grid.
type CheckInCycleCell struct {
	Position int
	// Points is the earned snapshot on a checked cell, otherwise the reward
	// preview for that position.
	Points int
	Status string // "checked" | "today" | "upcoming"
}

// CheckInMonthEntry is one checked day inside the current natural month,
// carrying the earned-points snapshot for the month grid (#848 revision ②).
type CheckInMonthEntry struct {
	Date   time.Time
	Points int
}

// CheckInStatus is the GET /api/users/me/check-ins/status payload: everything
// the check-in page renders in one read.
type CheckInStatus struct {
	Date       time.Time // today's Shanghai calendar day (UTC-normalized)
	CanCheckIn bool

	// RewardPreview is the payout the next check-in (today's, or tomorrow's
	// when today is already checked) will earn.
	RewardPreview int
	// WouldStartNewCycle reports that the next check-in begins a fresh cycle
	// (yesterday completed D7, or the streak is broken).
	WouldStartNewCycle bool

	StreakDays int
	Cycle      []CheckInCycleCell // always exactly 7 entries

	Balance int

	MonthLabel   string // "2006-01" of today's Shanghai month
	MonthChecked []CheckInMonthEntry
}

// GetCheckInStatus derives the full check-in-page state from the trailing
// 8-day row window (the longest grid window that can reach back) plus the
// current-month rows and the materialized balance.
func (s *Store) GetCheckInStatus(ctx context.Context, userID string, now time.Time) (*CheckInStatus, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	today := shanghaiDay(now)
	yesterday := today.AddDate(0, 0, -1)
	windowStart := today.AddDate(0, 0, -7)

	monthStart := shanghaiDay(time.Date(today.Year(), today.Month(), 1, 12, 0, 0, 0, shanghaiLoc))
	from := windowStart
	if monthStart.Before(from) {
		from = monthStart
	}

	var rows []*CheckInRecord
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND check_in_date >= ? AND check_in_date <= ?", uid, from, today).
		Order("check_in_date ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	byDate := make(map[time.Time]*CheckInRecord, len(rows))
	for _, r := range rows {
		byDate[r.CheckInDate] = r
	}

	balance, err := readBalance(s.db.WithContext(ctx), uid)
	if err != nil {
		return nil, err
	}

	st := &CheckInStatus{
		Date:         today,
		CanCheckIn:   true,
		Cycle:        make([]CheckInCycleCell, 0, 7),
		Balance:      balance,
		MonthLabel:   today.In(shanghaiLoc).Format("2006-01"),
		MonthChecked: make([]CheckInMonthEntry, 0),
	}

	// Month block: every earned-points snapshot in the current natural month.
	for _, r := range rows {
		if !r.CheckInDate.Before(monthStart) {
			st.MonthChecked = append(st.MonthChecked, CheckInMonthEntry{Date: r.CheckInDate, Points: r.PointsEarned})
		}
	}

	switch {
	case byDate[today] != nil:
		// Already checked today: the cycle window ends today.
		cur := byDate[today]
		st.CanCheckIn = false
		st.StreakDays = cur.CyclePosition
		st.RewardPreview = rewardForPosition(nextPosition(cur.CyclePosition))
		st.WouldStartNewCycle = cur.CyclePosition == 7
		fillCycle(st, today.AddDate(0, 0, -(cur.CyclePosition-1)), byDate, today)
	case byDate[yesterday] != nil:
		// Live streak ending yesterday: today extends it (or opens the next
		// cycle when yesterday completed D7).
		prev := byDate[yesterday]
		st.StreakDays = prev.CyclePosition
		if prev.CyclePosition == 7 {
			st.RewardPreview = rewardForPosition(1)
			st.WouldStartNewCycle = true
			fillCycle(st, today, byDate, today)
		} else {
			st.RewardPreview = rewardForPosition(prev.CyclePosition + 1)
			fillCycle(st, yesterday.AddDate(0, 0, -(prev.CyclePosition-1)), byDate, today)
		}
	default:
		// Broken streak (or first ever): streak 0, all upcoming, D1 = today
		// (#848 resolution's contract shape).
		st.StreakDays = 0
		st.RewardPreview = rewardForPosition(1)
		st.WouldStartNewCycle = true
		fillCycle(st, today, byDate, today)
	}
	return st, nil
}

// nextPosition maps the current cycle position to the next check-in's
// position: D7 rolls back to a new cycle's D1 (#847 state machine).
func nextPosition(pos int) int {
	if pos >= 7 {
		return 1
	}
	return pos + 1
}

// fillCycle renders the 7-cell grid whose position 1 falls on cycleStart.
// A cell is checked when its day carries a row, "today" when it is today's
// still-open slot, and upcoming for future days.
func fillCycle(st *CheckInStatus, cycleStart time.Time, byDate map[time.Time]*CheckInRecord, today time.Time) {
	for p := 1; p <= 7; p++ {
		day := cycleStart.AddDate(0, 0, p-1)
		cell := CheckInCycleCell{Position: p, Points: rewardForPosition(p), Status: "upcoming"}
		if row := byDate[day]; row != nil {
			cell.Points = row.PointsEarned
			cell.Status = "checked"
		} else if day.Equal(today) {
			cell.Status = "today"
		}
		st.Cycle = append(st.Cycle, cell)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/me/points — balance + cursor-paginated ledger
// ─────────────────────────────────────────────────────────────────────────────

const (
	DefaultPointLimit = 50
	MaxPointLimit     = 50
)

// PointCursorError rejects a malformed ledger cursor.
type PointCursorError struct{ Message string }

func (e *PointCursorError) Error() string { return e.Message }

// PointValidationError rejects an out-of-range page size.
type PointValidationError struct{ Message string }

func (e *PointValidationError) Error() string { return e.Message }

// PointPage is one bounded, newest-first page of one user's ledger, carrying
// the materialized balance so the points page renders in one port call.
type PointPage struct {
	Items      []*PointTransaction
	Balance    int
	NextCursor string
}

type pointCursor struct {
	ID string `json:"id"`
}

func encodePointCursor(c pointCursor) (string, error) {
	body, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(body), nil
}

func decodePointCursor(raw string) (pointCursor, error) {
	var c pointCursor
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || json.Unmarshal(body, &c) != nil || c.ID == "" {
		return c, &PointCursorError{Message: "invalid points cursor"}
	}
	if _, err := uuid.Parse(c.ID); err != nil {
		return c, &PointCursorError{Message: "invalid points cursor"}
	}
	return c, nil
}

// ListPointTransactions returns one user's ledger newest-first on the
// (user_id, id DESC) index, with injuries-style keyset cursor pagination.
func (s *Store) ListPointTransactions(ctx context.Context, userID, cursor string, limit int) (*PointPage, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if limit == 0 {
		limit = DefaultPointLimit
	}
	if limit < 1 || limit > MaxPointLimit {
		return nil, &PointValidationError{Message: fmt.Sprintf("limit must be between 1 and %d", MaxPointLimit)}
	}

	query := s.db.WithContext(ctx).Where("user_id = ?", uid)
	if cursor != "" {
		c, err := decodePointCursor(cursor)
		if err != nil {
			return nil, err
		}
		query = query.Where("id < ?", c.ID)
	}

	var rows []*PointTransaction
	if err := query.Order("id DESC").Limit(limit + 1).Find(&rows).Error; err != nil {
		return nil, err
	}
	balance, err := readBalance(s.db.WithContext(ctx), uid)
	if err != nil {
		return nil, err
	}
	page := &PointPage{Items: rows, Balance: balance}
	if len(rows) > limit {
		encoded, err := encodePointCursor(pointCursor{ID: rows[limit-1].ID})
		if err != nil {
			return nil, err
		}
		page.Items = rows[:limit]
		page.NextCursor = encoded
	}
	return page, nil
}
