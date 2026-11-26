// range_sync.go is the COROS recent-range executor's adapter half (devops#1008,
// epic devops#1004 T04): it implements provider.RecentSyncer for the onboarding
// first-sync session's recent stage — the 90-Shanghai-day activity window, the
// batch health pull and the dashboard snapshot.
//
// The range scan is deliberately NOT the incremental cursor: it never stops at
// the first already-known activity (an existing row proves nothing about the
// rows beside it), walks the vendor list newest→oldest until the window's
// lower boundary is PROVEN crossed (page ordering verified) or the list ends,
// reconciles backfill that appeared mid-pagination, and then commits details
// newest-first through the same ordered path SyncUser uses — a publish session
// in ctx fences every activity write exactly like a watch_sync run. Newest-
// first (11-17) puts the user's recent activities in the DB first; downstream
// analysis reads by date from storage after recent_raw terminal, so commit
// order carries no computational meaning.
package coros

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"time"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
	"go.uber.org/zap"
)

// rangePageSize matches the incremental scan's page size; the vendor honours it
// and a short page reliably marks the list's end.
const rangePageSize = 20

// SyncRecentRange runs the requested channels over their windows and reports
// each channel's terminal outcome. Channels that finished before a failure
// stay in the report so the executor can persist their complete-fetch
// credentials; the error explains the first failure.
func (p *Provider) SyncRecentRange(ctx context.Context, user string, opts provider.RecentRangeOptions, progress provider.ProgressCallback) (provider.RecentRangeReport, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return provider.RecentRangeReport{}, err
	}
	client.EnableRateLimit(provider.DetailJobs(opts.Jobs))

	var rep provider.RecentRangeReport
	if opts.Activities != nil {
		r, err := p.rangeActivities(ctx, client, user, *opts.Activities, opts.Jobs, opts.RejectedActivityIDs, progress)
		if err != nil {
			if !isRangeRejection(err) {
				rep.Activities = r
				return rep, err
			}
			r = &provider.RangeChannelReport{Status: provider.RangeChannelGap, Gaps: []provider.RangeGap{provider.RejectedRange(*opts.Activities, err)}}
		}
		rep.Activities = r
	}
	if opts.Health != nil {
		r, err := p.rangeHealth(ctx, client, user, *opts.Health)
		if err != nil {
			if !isRangeRejection(err) {
				return rep, err
			}
			r = &provider.RangeChannelReport{Status: provider.RangeChannelGap, Gaps: []provider.RangeGap{provider.RejectedRange(*opts.Health, err)}}
		}
		rep.Health = r
	}
	if opts.Dashboard != nil {
		r, err := p.rangeDashboard(ctx, client, user, *opts.Dashboard)
		if err != nil {
			if !isRangeRejection(err) {
				return rep, err
			}
			r = &provider.RangeChannelReport{Status: provider.RangeChannelGap, Gaps: []provider.RangeGap{provider.RejectedRange(*opts.Dashboard, err)}}
		}
		rep.Dashboard = r
	}
	return rep, nil
}

// isRangeRejection recognizes explicit refusals of a range endpoint.
func isRangeRejection(err error) bool {
	var rejection *dataEndpointRejection
	return errors.As(err, &rejection) || provider.IsRangeRejection(err)
}

// ─────────────────────────────────────────────────────────────────────────────
// Activities channel
// ─────────────────────────────────────────────────────────────────────────────

// rangeScan is one completed walk of the vendor activity list: the in-window
// items (deduped by label, newest-first discovery order) and every label seen,
// for the backfill reconciliation pass.
type rangeScan struct {
	items []listItem
	seen  map[string]bool
}

// listShanghaiDay resolves a list item's date to its Shanghai natural day
// label. ok=false covers a missing or unparsable date — the item is still
// fetched (its detail carries the real start), but it cannot serve as an
// ordering proof point.
func listShanghaiDay(item listItem) (string, bool) {
	s := string(item.Date)
	if s == "" {
		return "", false
	}
	t := parseListDate(s)
	if t.IsZero() {
		return "", false
	}
	return timefmt.ShanghaiDayStr(t), true
}

// parseListPage decodes one /activity/query page.
func parseListPage(raw []byte) ([]listItem, error) {
	var pageData struct {
		DataList []listItem `json:"dataList"`
	}
	if err := json.Unmarshal(raw, &pageData); err != nil {
		return nil, fmt.Errorf("coros: parse activity list: %w", err)
	}
	return pageData.DataList, nil
}

// collectActivitiesInRange walks the activity list newest→oldest collecting
// every in-window item. It never stops at an already-stored activity; the only
// early stop is the window's lower boundary crossed on a PROVEN-ordered walk
// (COROS answers desc by date, but the proof is re-verified per item — one
// out-of-order or undated item and the scan pages to the list's end instead of
// trusting the first below-boundary item). Unknown-sport entries are skipped
// like the incremental scan skips them.
func (p *Provider) collectActivitiesInRange(ctx context.Context, client *Client, win provider.DayWindow) (*rangeScan, error) {
	scan := &rangeScan{seen: map[string]bool{}}
	ordered := true // every item so far had a date ≤ its predecessor's
	prevDay := ""   // previous item's day (carried across pages)
	belowBoundary := false

	for page := 1; ; page++ {
		raw, err := client.ListActivities(ctx, page, rangePageSize)
		if err != nil {
			return nil, err
		}
		dataList, err := parseListPage(raw)
		if err != nil {
			return nil, err
		}
		if len(dataList) == 0 {
			return scan, nil // list exhausted: the whole history was walked
		}
		newOnPage := 0 // unseen labels, INCLUDING below-boundary ones
		for _, item := range dataList {
			day, dated := listShanghaiDay(item)
			if !dated {
				ordered = false // an undated item breaks the ordering chain
			} else {
				if prevDay != "" && day > prevDay {
					ordered = false // vendor sent a newer item after an older one
				}
				prevDay = day
			}
			if !isKnownSportCode(item.SportType) {
				continue
			}
			if scan.seen[item.LabelID] {
				continue // pagination shifted and re-served a page
			}
			scan.seen[item.LabelID] = true
			newOnPage++
			if dated && day < win.From {
				belowBoundary = true
				continue // older than the window: never fetched
			}
			// In-window (or undated — the detail decides) → always collected,
			// existing store rows notwithstanding.
			scan.items = append(scan.items, item)
		}
		// Early stop ONLY on a proven-ordered walk past the boundary: ordering
		// verified + at least one item strictly below From means everything
		// after it is older still.
		if ordered && belowBoundary {
			return scan, nil
		}
		// A page with zero unseen labels is a pagination anomaly (the vendor
		// re-served known items); the window's content is already collected and
		// the reconciliation pass will catch any shift.
		if newOnPage == 0 {
			return scan, nil
		}
		if len(dataList) < rangePageSize {
			return scan, nil // short page = list end
		}
	}
}

// reconcileBackfill re-walks the list head for activities that appeared (or
// moved) while the first pass was paginating — the vendor inserts backfilled
// uploads into the middle of the list, so a single newest→oldest walk can miss
// them. The pass stops at the first page that yields no unseen in-window item,
// so a no-backfill stage costs exactly one extra request. It runs once; work
// that lands after it is the next sync's job.
func (p *Provider) reconcileBackfill(ctx context.Context, client *Client, win provider.DayWindow, scan *rangeScan) error {
	for page := 1; ; page++ {
		raw, err := client.ListActivities(ctx, page, rangePageSize)
		if err != nil {
			return err
		}
		dataList, err := parseListPage(raw)
		if err != nil {
			return err
		}
		if len(dataList) == 0 {
			return nil
		}
		newOnPage := 0
		for _, item := range dataList {
			if !isKnownSportCode(item.SportType) {
				continue
			}
			if scan.seen[item.LabelID] {
				continue
			}
			scan.seen[item.LabelID] = true
			if day, ok := listShanghaiDay(item); ok && day < win.From {
				continue
			}
			scan.items = append(scan.items, item)
			newOnPage++
		}
		if newOnPage == 0 {
			return nil
		}
	}
}

// rangeActivities runs the full activities channel: collect + reconcile +
// ordered detail commit, and derives the coverage report from what actually
// committed. Per-item permanent provider rejections become one-day gaps; the
// rest of the window still commits (合法无曲线 vs 抓取失败 are already distinct
// one layer down: a parseable detail with no curves commits fine, only a
// rejected/failed fetch is an error).
func (p *Provider) rangeActivities(ctx context.Context, client *Client, user string, win provider.DayWindow, jobs int, rejectedIDs map[string]bool, progress provider.ProgressCallback) (*provider.RangeChannelReport, error) {
	scan, err := p.collectActivitiesInRange(ctx, client, win)
	if err != nil {
		return nil, err
	}
	if err := p.reconcileBackfill(ctx, client, win, scan); err != nil {
		return nil, err
	}

	total := len(scan.items)
	provider.EmitProgress(progress, "activities", 0, total, provider.PercentInBand(0, total, 10, 80))

	// Newest-first ordered commit（11-17 拍板：近期活动先落库、先对用户可见）。
	// 提交顺序不影响任何下游计算——分析/校准在 recent_raw 终态后按日期从库读；
	// ordered 指的是「同一 publish session 内按序提交」的隔离语义，不是升序。
	// 同日多条按 label id 升序保持确定性（与 garmin 侧同一平手规则）；不可定
	// 日期项（fetch 侧有三级日期恢复/阻塞）稳定沉底。
	sort.SliceStable(scan.items, func(i, j int) bool {
		di, oki := listShanghaiDay(scan.items[i])
		dj, okj := listShanghaiDay(scan.items[j])
		if oki != okj {
			return oki
		}
		if di != dj {
			return di > dj
		}
		return scan.items[i].LabelID < scan.items[j].LabelID
	})
	ordered := slices.DeleteFunc(scan.items, func(item listItem) bool { return rejectedIDs[item.LabelID] })
	res := &provider.SyncResult{}
	gaps := []provider.RangeGap{}
	skip := func(item listItem, err error) {
		day, ok := listShanghaiDay(item)
		if !ok {
			day = win.To // undated and unobtainable: anchor the gap at the window's newest day
		}
		gaps = append(gaps, provider.RangeGap{
			From: day, To: day,
			Kind: provider.RangeGapUnavailable, ActivityID: item.LabelID, Reason: fmt.Sprintf("activity %s permanently rejected by provider: %v", item.LabelID, err),
		})
		logging.Default().Warn("coros: range sync records permanent activity gap",
			zap.String("user", user), zap.String("label_id", item.LabelID), zap.Error(err))
	}
	committed, commitErr := p.fetchDetailsOrdered(ctx, client, user, ordered, provider.DetailJobs(jobs), progress, res, skip)

	days := make([]string, 0, len(committed))
	for _, a := range committed {
		days = append(days, timefmt.ShanghaiDayStr(a.Date))
	}
	sort.Strings(days)
	rep := &provider.RangeChannelReport{
		Status:      provider.RangeChannelDone,
		ScannedFrom: win.From,
		ScannedTo:   win.To,
		Gaps:        gaps,
		Count:       res.Activities,
		Credential:  fmt.Sprintf("coros:v1:range:activities:%s..%s:obs=-..-:n=%d", win.From, win.To, res.Activities),
	}
	if len(days) > 0 {
		rep.ObservedFrom, rep.ObservedTo = &days[0], &days[len(days)-1]
		rep.Credential = fmt.Sprintf("coros:v1:range:activities:%s..%s:obs=%s..%s:n=%d",
			win.From, win.To, days[0], days[len(days)-1], res.Activities)
		// The walk covered the whole window, so target days with no activity
		// are the vendor's honest emptiness — recorded like the health
		// channel's short answer, never silently read as covered.
		if days[0] > win.From {
			rep.Gaps = append(rep.Gaps, provider.RangeGap{
				From: win.From, To: prevDay(days[0]), Kind: provider.RangeGapEmpty, Reason: "no activities at provider in range",
			})
		}
		if days[len(days)-1] < win.To {
			rep.Gaps = append(rep.Gaps, provider.RangeGap{
				From: nextDay(days[len(days)-1]), To: win.To, Kind: provider.RangeGapEmpty, Reason: "no activities at provider in range",
			})
		}
	} else if len(gaps) == 0 {
		// A fully-walked window with no activities and no per-item gap is the
		// "user has nothing in range" truth — recorded as a window-wide gap so
		// the stage never reads as covered (observed ≠ scanned; 不伪造覆盖).
		rep.Gaps = append(gaps, provider.RangeGap{From: win.From, To: win.To, Kind: provider.RangeGapEmpty, Reason: "no activities in window"})
	}
	if len(rep.Gaps) > 0 {
		rep.Gaps = coalesceGaps(rep.Gaps)
		rep.Status = provider.RangeChannelGap
	}
	if commitErr != nil {
		// The committed prefix stays durable in the store, but the window's
		// complete fetch did NOT succeed — no report, so the executor never
		// records a complete-fetch credential for a partial window. The retry
		// re-scans and re-fetches; upserts are idempotent.
		if len(gaps) != 0 {
			return &provider.RangeChannelReport{Gaps: gaps}, commitErr
		}
		return nil, commitErr
	}
	return rep, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Health channel
// ─────────────────────────────────────────────────────────────────────────────

// rangeHealth pulls the vendor's batch daily-health payload and keeps EVERY day
// it returns — the window is the server's target, not a cap (COROS legitimately
// answers more than the 28-day target; those days are kept, and the report
// marks the ACTUAL coverage, never promising days the vendor did not send).
// Day labels resolve through analyseDayDate so the whole chain (ordering,
// credential, gaps, the stored daily_health key) speaks ISO dates — a compact
// vendor label never reaches the coverage contract (devops#1008 D1).
func (p *Provider) rangeHealth(ctx context.Context, client *Client, user string, win provider.DayWindow) (*provider.RangeChannelReport, error) {
	raw, err := client.GetAnalyse(ctx)
	if err != nil {
		return nil, err
	}
	var data struct {
		DayList []dayItem `json:"dayList"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, fmt.Errorf("coros: parse analyse: %w", err)
	}
	days := make([]string, 0, len(data.DayList))
	for _, d := range data.DayList {
		date, ok := analyseDayDate(d)
		if !ok {
			continue
		}
		h := dayItemToHealth(user, d, date)
		if err := p.store.UpsertDailyHealth(ctx, h); err != nil {
			return nil, err
		}
		days = append(days, date)
	}
	sort.Strings(days)
	rep := &provider.RangeChannelReport{
		Status:      provider.RangeChannelDone,
		ScannedFrom: win.From,
		ScannedTo:   win.To,
		Count:       len(days),
	}
	if len(days) > 0 {
		rep.ObservedFrom, rep.ObservedTo = &days[0], &days[len(days)-1]
		rep.Credential = fmt.Sprintf("coros:v1:range:health:%s..%s:obs=%s..%s:n=%d",
			win.From, win.To, days[0], days[len(days)-1], len(days))
		// The vendor's answer IS the coverage truth: target days it did not
		// return are recorded as gaps so a short batch never reads as fully
		// covered and an honest window never blocks on a vendor cap.
		if days[0] > win.From {
			rep.Gaps = append(rep.Gaps, provider.RangeGap{
				From: win.From, To: prevDay(days[0]), Kind: provider.RangeGapEmpty, Reason: "provider returned no health rows for range",
				HealthHistoryDays: provider.HealthLookbackDays(days[0], days[len(days)-1], win.To),
			})
		}
		if days[len(days)-1] < win.To {
			rep.Gaps = append(rep.Gaps, provider.RangeGap{
				From: nextDay(days[len(days)-1]), To: win.To, Kind: provider.RangeGapEmpty, Reason: "provider returned no health rows for range",
			})
		}
	} else {
		rep.Credential = fmt.Sprintf("coros:v1:range:health:%s..%s:obs=-..-:n=0", win.From, win.To)
		rep.Gaps = append(rep.Gaps, provider.RangeGap{
			From: win.From, To: win.To, Kind: provider.RangeGapEmpty, Reason: "provider returned no health rows",
		})
	}
	rep.Gaps = coalesceGaps(rep.Gaps)
	if len(rep.Gaps) > 0 {
		rep.Status = provider.RangeChannelGap
	}
	return rep, nil
}

// coalesceGaps combines adjacent or overlapping ranges with the same meaning.
func coalesceGaps(gaps []provider.RangeGap) []provider.RangeGap {
	if len(gaps) <= 1 {
		return gaps
	}
	sort.Slice(gaps, func(i, j int) bool { return gaps[i].From < gaps[j].From })
	out := make([]provider.RangeGap, 0, len(gaps))
	cur := gaps[0]
	for _, g := range gaps[1:] {
		if g.Kind == cur.Kind && g.Reason == cur.Reason && g.HealthHistoryDays == cur.HealthHistoryDays && g.From <= nextDay(cur.To) {
			if g.To > cur.To {
				cur.To = g.To
			}
			continue
		}
		out = append(out, cur)
		cur = g
	}
	return append(out, cur)
}

// prevDay/nextDay step one Shanghai natural day inside the YYYY-MM-DD label
// space (labels are calendar days, so date arithmetic in the Shanghai location
// is exact).
func prevDay(day string) string { return stepDay(day, -1) }
func nextDay(day string) string { return stepDay(day, +1) }

func stepDay(day string, delta int) string {
	t, err := time.ParseInLocation("2006-01-02", day, timefmt.Shanghai)
	if err != nil {
		return day
	}
	return t.AddDate(0, 0, delta).Format("2006-01-02")
}

// dayItemToHealth maps one analyse day onto the daily_health row — the exact
// mapping the incremental syncHealth uses (unit conversions and fallbacks
// preserved verbatim).
func dayItemToHealth(user string, d dayItem, date string) *storage.DailyHealth {
	return &storage.DailyHealth{
		UserID:            user,
		Date:              date,
		ATI:               d.ATI,
		CTI:               d.CTI,
		RHR:               firstInt(d.TestRhr, d.Rhr),
		DistanceM:         d.Distance,
		DurationS:         d.Duration,
		TrainingLoadRatio: d.TrainingLoadRatio,
		Fatigue:           firstFloat(d.TiredRate, d.Fatigue),
		Provider:          providerName,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard channel
// ─────────────────────────────────────────────────────────────────────────────

// rangeDashboard fetches and stores the dashboard snapshot for the anchor day.
// Unlike the periodic sync's best-effort dashboard pull, a fetch failure here
// FAILS the channel: the onboarding stage's dashboard work item must not
// silently read done with no snapshot behind it.
func (p *Provider) rangeDashboard(ctx context.Context, client *Client, user string, win provider.DayWindow) (*provider.RangeChannelReport, error) {
	summary, week, err := p.fetchDashboardPayloads(ctx, client, user)
	if err != nil {
		return nil, err
	}
	res := &provider.SyncResult{}
	if err := p.storeDashboard(ctx, user, summary, week, nil, res); err != nil {
		return nil, err
	}
	if res.Health == 0 {
		// The vendor answered but carried no summary at all — nothing was
		// stored, which is a gap, not a done dashboard.
		return &provider.RangeChannelReport{
			Status: provider.RangeChannelGap, ScannedFrom: win.From, ScannedTo: win.To,
			Credential: fmt.Sprintf("coros:v1:range:dashboard:%s..%s:obs=-..-:n=0", win.From, win.To),
			Gaps: []provider.RangeGap{{
				From: win.From, To: win.To, Kind: provider.RangeGapEmpty, Reason: "provider returned no dashboard summary",
			}},
		}, nil
	}
	return &provider.RangeChannelReport{
		Status: provider.RangeChannelDone, ScannedFrom: win.From, ScannedTo: win.To,
		ObservedFrom: &win.From, ObservedTo: &win.To, Count: res.Health,
		Credential: fmt.Sprintf("coros:v1:range:dashboard:%s..%s:obs=%s..%s:n=%d",
			win.From, win.To, win.From, win.To, res.Health),
	}, nil
}
