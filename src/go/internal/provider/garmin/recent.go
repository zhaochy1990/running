// recent.go is the Garmin executor's adapter half for the onboarding recent
// stage (devops#1007, epic devops#1004 T03): it implements
// provider.RecentSyncer — the 90-Shanghai-day complete-activity window, the
// 28-day health walk and the dashboard snapshot — over the same
// normalization and storage paths SyncUser uses (a publish session in ctx
// fences every activity write exactly like a watch_sync run).
//
// The range scan is deliberately NOT the incremental cursor:
//
//   - it never stops at the first already-known activity and never uses a
//     limit as a substitute for covering the window; pages are walked
//     newest-first and the only early stop is a page consisting ENTIRELY of
//     valid-dated entries older than the window — one out-of-order or
//     unclassifiable entry keeps the walk going, so an unproven order can
//     never end the scan early (devops#1007 AC3);
//   - implausible dates (missing, unparsable, pre-2000 epoch garbage) are
//     UNCLASSIFIABLE, never "old": each is confirmed against the detail
//     payload (the detail carries the real startTimeGMT — a recovered date
//     rejoins the ordered window), a 404 is a phantom list entry, and an
//     entry that stays undatable blocks the stage explicitly via
//     provider.ErrUnrecoverableRangeData instead of being silently skipped
//     (无效日期需详情确认或明确阻塞);
//   - a mid-run retry first checks for already-stored rows and re-downloads
//     nothing that previously succeeded (成功详情不重复下载); the window
//     commits newest→oldest (11-17: recent activities land first) with label-id
//     tie-breaking so the commit order stays deterministic; downstream
//     analysis reads by date from storage after the stage terminal state;
//   - detail/splits 404s are the vendor legitimately not providing them —
//     recorded and never fabricated — while any other failure fails the
//     channel so the job retry resumes;
//   - the health channel walks the FIXED anchor window day by day (no now(),
//     no consecutive-empty cutoff): every day is queried, signal days are
//     written, and honestly-empty days are recorded as gaps exactly like the
//     COROS channel's short batch answer (合法无数据不伪造测量).
package garmin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// The Garmin adapter carries the onboarding recent-range contract (T03).
var _ provider.RecentSyncer = (*Provider)(nil)

// plausibleDayFrom is the oldest start date a Garmin activity may carry and
// still be trusted as a real classification (consumer GPS watches postdate
// it). Anything older — typically an epoch-defaulted garbage date — is
// unclassifiable, never "old".
const plausibleDayFrom = "2000-01-01"

// recentListPage follows the adapter's list paging size.
const recentListPage = 20

// recentMaxListPages bounds the newest-first walk. The walk stops at the
// first all-older page, so reaching the bound requires pathological feed
// content (e.g. unclassifiable dates on every page); that surfaces as an
// error instead of an unbounded crawl.
const recentMaxListPages = 500

// SyncRecentRange runs the requested channels over their windows and reports
// each channel's terminal outcome. Channels that finished before a failure
// stay in the report so the executor can persist their complete-fetch
// credentials; the error explains the first failure.
func (p *Provider) SyncRecentRange(ctx context.Context, user string, opts provider.RecentRangeOptions, progress provider.ProgressCallback) (provider.RecentRangeReport, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return provider.RecentRangeReport{}, err
	}
	jobs := provider.DetailJobs(opts.Jobs)
	client.EnableRateLimit(jobs)
	var rep provider.RecentRangeReport
	if opts.Activities != nil {
		r, err := p.recentActivities(ctx, client, user, *opts.Activities, jobs, opts.RejectedActivityIDs, progress)
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
		r, err := p.recentHealth(ctx, client, user, *opts.Health, jobs, opts.RejectedHealthEndpoints, progress)
		if err != nil {
			if !isRangeRejection(err) {
				rep.Health = r
				return rep, err
			}
			r = &provider.RangeChannelReport{Status: provider.RangeChannelGap, Gaps: []provider.RangeGap{provider.RejectedRange(*opts.Health, err)}}
		}
		rep.Health = r
	}
	if opts.Dashboard != nil {
		known := opts.RejectedDashboardEndpoints
		if known == nil {
			known = make(map[string]map[string]bool)
		}
		if rep.Health != nil {
			provider.RememberRejectedHealthEndpoints(known, rep.Health.Gaps)
		}
		r, err := p.recentDashboard(ctx, client, user, *opts.Dashboard, known)
		if err != nil {
			if !isRangeRejection(err) {
				rep.Dashboard = r
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
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, cause := range joined.Unwrap() {
			if !isRangeRejection(cause) {
				return false
			}
		}
		return true
	}
	var status *APIError
	if errors.As(err, &status) {
		switch status.Status {
		case http.StatusBadRequest, http.StatusNotFound, http.StatusGone, http.StatusNotImplemented:
			return true
		}
	}
	return provider.IsRangeRejection(err)
}

// ─────────────────────────────────────────────────────────────────────────────
// Activities channel
// ─────────────────────────────────────────────────────────────────────────────

// scannedItem is one classified activity-list entry of the recent walk.
type scannedItem struct {
	a    rawActivity
	day  string // Shanghai calendar day of the start instant
	inst time.Time
}

// shanghaiDayOfClassifiable parses the summary start time and reports the
// Shanghai calendar day. ok=false marks the entry UNCLASSIFIABLE (missing,
// unparseable, or implausibly old) — such entries never count as "older than
// the window" and never authorize an early stop.
func shanghaiDayOfClassifiable(a rawActivity) (day string, inst time.Time, ok bool) {
	if len(a.StartTimeGMT) < 10 {
		return "", time.Time{}, false
	}
	t, err := time.Parse("2006-01-02 15:04:05", a.StartTimeGMT)
	if err != nil {
		return "", time.Time{}, false
	}
	d := timefmt.ShanghaiDayStr(t)
	if d < plausibleDayFrom {
		return "", time.Time{}, false
	}
	return d, t, true
}

// walkOutcome is one newest-first walk of the activity list: the classified
// in-window items, the entries needing confirmation, and the accounting
// deltas. Newer ids are collected (not counted) so the scan + reconcile
// walks merge without double counting.
type walkOutcome struct {
	items     []scannedItem
	invalid   []rawActivity
	newerIDs  []string
	malformed int
}

// recentActivities runs the full activities channel: two walks (scan +
// backfill reconciliation), unclassifiable-date confirmation, then the
// newest→oldest ordered commit (近期先落库), and derives the coverage report
// from what actually landed in the window.
func (p *Provider) recentActivities(ctx context.Context, client *Client, user string, win provider.DayWindow, jobs int, rejectedIDs map[string]bool, progress provider.ProgressCallback) (*provider.RangeChannelReport, error) {
	log := logging.Default().With(zap.String("user", user))
	first, err := p.walkRecentWindow(ctx, client, win)
	if err != nil {
		return nil, err
	}
	// End-of-stage reconciliation (对账): one immediate re-walk of the head
	// picks up list entries that appeared, moved, or were back-filled while
	// the first walk paged — they merge into the same ordered pipeline. The
	// pass costs one extra request when nothing shifted (the head page yields
	// no unseen in-window item).
	second, err := p.walkRecentWindow(ctx, client, win)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	newerSeen := map[string]bool{}
	collected := make([]scannedItem, 0, len(first.items)+len(second.items))
	newer, malformed := 0, 0
	for i, walk := range []*walkOutcome{first, second} {
		if i == 0 {
			// Malformed entries carry no identity, so they can only be
			// counted once — from the first walk.
			malformed += walk.malformed
		}
		for _, id := range walk.newerIDs {
			if !newerSeen[id] {
				newerSeen[id] = true
				newer++
			}
		}
		for _, it := range walk.items {
			if id := it.a.labelID(); !seen[id] {
				seen[id] = true
				collected = append(collected, it)
			}
		}
	}

	// Unclassifiable entries: confirm against the DETAIL payload — it carries
	// the real startTimeGMT, so a recoverable date rejoins the window. A 404
	// is a phantom list entry (dropped); an entry that stays undatable blocks
	// the channel explicitly (明确阻塞), never a silent skip.
	var invalidSeen = map[string]bool{}
	var blocked []string
	var gaps []provider.RangeGap
	for _, walk := range []*walkOutcome{first, second} {
		for _, a := range walk.invalid {
			id := a.labelID()
			if invalidSeen[id] || rejectedIDs[id] {
				continue
			}
			invalidSeen[id] = true
			raw, err := client.GetActivityDetails(ctx, id, activityDetailsMaxChart, activityDetailsMaxPoly)
			switch {
			case isRangeRejection(err):
				gaps = append(gaps, rejectedActivityGap(id, win.To, err))
				log.Warn("garmin: range sync dropped a phantom undated list entry", zap.String("label_id", id))
			case err != nil:
				if len(gaps) > 0 {
					return &provider.RangeChannelReport{Gaps: gaps}, err
				}
				return nil, err
			default:
				var detail struct {
					StartTimeGMT string `json:"startTimeGMT"`
				}
				if json.Unmarshal(raw, &detail) == nil && detail.StartTimeGMT != "" {
					fixed := a
					fixed.StartTimeGMT = detail.StartTimeGMT
					if day, inst, ok := shanghaiDayOfClassifiable(fixed); ok && day >= win.From && day <= win.To && !seen[id] {
						seen[id] = true
						collected = append(collected, scannedItem{a: fixed, day: day, inst: inst})
						log.Info("garmin: range sync recovered an undated list entry from its detail",
							zap.String("label_id", id), zap.String("day", day))
						continue
					}
				}
				blocked = append(blocked, id)
			}
		}
	}
	if len(blocked) > 0 {
		sort.Strings(blocked)
		return nil, fmt.Errorf("garmin: %d confirmed activities have unclassifiable start dates (%v …): %w",
			len(blocked), blocked[:min(5, len(blocked))], provider.ErrUnrecoverableRangeData)
	}

	// New→old for the ordered pipeline（11-17 拍板：近期活动先落库、先对用户
	// 可见；下游分析在 recent_raw 终态后按日期从库读，提交顺序无计算语义）；
	// ties (same instant, e.g. same-second uploads) order by label id for
	// determinism.
	collected = slices.DeleteFunc(collected, func(item scannedItem) bool { return rejectedIDs[item.a.labelID()] })
	sort.Slice(collected, func(i, j int) bool {
		if !collected[i].inst.Equal(collected[j].inst) {
			return collected[i].inst.After(collected[j].inst)
		}
		return collected[i].a.labelID() < collected[j].a.labelID()
	})
	log.Info("garmin: range activity scan collected",
		zap.Int("in_window", len(collected)), zap.Int("newer_than_window", newer),
		zap.Int("malformed_entries", malformed))
	provider.EmitProgress(progress, "activities", 0, len(collected), provider.PercentInBand(0, len(collected), 10, 80))

	written, skipped, missing, days, rejected, commitErr := p.recentFetchOrdered(ctx, client, user, collected, jobs, progress)
	if commitErr != nil {
		// The committed prefix stays durable in the store, but the window's
		// complete fetch did NOT succeed — no report, so the executor never
		// records a complete-fetch credential for a partial window. The retry
		// re-scans; already-stored rows are skipped, not re-downloaded.
		if gaps = append(gaps, rejected...); len(gaps) != 0 {
			return &provider.RangeChannelReport{Gaps: gaps}, commitErr
		}
		return nil, commitErr
	}

	// days = every in-window activity the store now holds (this run's writes
	// plus prior-pass rows the resume skipped) — the observed window is the
	// data-existence truth, exactly like the COROS channel.
	sort.Strings(days)
	rep := &provider.RangeChannelReport{
		Status:      provider.RangeChannelDone,
		ScannedFrom: win.From,
		ScannedTo:   win.To,
		Count:       written,
		Gaps:        append(gaps, rejected...),
		Credential:  fmt.Sprintf("garmin:v1:range:activities:%s..%s:obs=-..-:n=%d", win.From, win.To, written),
	}
	if len(days) > 0 {
		rep.ObservedFrom, rep.ObservedTo = &days[0], &days[len(days)-1]
		rep.Credential = fmt.Sprintf("garmin:v1:range:activities:%s..%s:obs=%s..%s:n=%d",
			win.From, win.To, days[0], days[len(days)-1], written)
		// The walk covered the whole window, so target days with no activity
		// are the vendor's honest emptiness — recorded as gaps like the COROS
		// channel, never silently read as covered.
		if days[0] > win.From {
			rep.Gaps = append(rep.Gaps, provider.RangeGap{
				From: win.From, To: prevShanghaiDay(days[0]), Kind: provider.RangeGapEmpty, Reason: "no activities at provider in range",
			})
		}
		if days[len(days)-1] < win.To {
			rep.Gaps = append(rep.Gaps, provider.RangeGap{
				From: nextShanghaiDay(days[len(days)-1]), To: win.To, Kind: provider.RangeGapEmpty, Reason: "no activities at provider in range",
			})
		}
	} else {
		// A fully-walked window with no activities is the "user has nothing
		// in range" truth — a window-wide gap so the stage never reads as
		// covered (observed ≠ scanned; 不伪造覆盖).
		rep.Gaps = append(rep.Gaps, provider.RangeGap{From: win.From, To: win.To, Kind: provider.RangeGapEmpty, Reason: "no activities in window"})
	}
	if missing > 0 {
		// Provider-legitimately-missing detail sub-resources (404s) — an
		// accounting note on the credential, never a gap and never fabricated.
		rep.Credential += fmt.Sprintf(":missing=%d", missing)
	}
	if skipped > 0 {
		rep.Credential += fmt.Sprintf(":reused=%d", skipped)
	}
	if len(rep.Gaps) > 0 {
		rep.Gaps = coalesceRecentGaps(rep.Gaps)
		rep.Status = provider.RangeChannelGap
	}
	return rep, nil
}

// walkRecentWindow pages the activity list newest-first and returns the
// in-window items. The walk stops at the first page consisting ENTIRELY of
// valid-dated entries older than the window: a single out-of-order or
// unclassifiable entry keeps the walk going, so an unproven order can never
// end the scan early (devops#1007 AC3).
func (p *Provider) walkRecentWindow(ctx context.Context, client *Client, win provider.DayWindow) (*walkOutcome, error) {
	out := &walkOutcome{}
	seen := map[string]bool{}
	for page := 0; page < recentMaxListPages; page++ {
		raw, err := client.ListActivities(ctx, page*recentListPage, recentListPage)
		if err != nil {
			return nil, err
		}
		acts, err := parseActivityList(raw)
		if err != nil {
			return nil, err
		}
		if len(acts) == 0 {
			return out, nil
		}
		allOlder := true
		for _, a := range acts {
			id := a.labelID()
			day, inst, ok := shanghaiDayOfClassifiable(a)
			switch {
			case id == "":
				// A list entry without an activity id cannot be fetched or
				// confirmed; it carries no data, so count it and keep the
				// walk honest (it cannot prove the page older either).
				out.malformed++
				allOlder = false
			case !ok:
				// Unclassifiable date: stash for detail confirmation; it must
				// not authorize an early stop.
				out.invalid = append(out.invalid, a)
				allOlder = false
			case day < win.From:
				// Older than the window: the candidate stop signal.
			case day > win.To:
				out.newerIDs = append(out.newerIDs, id)
				allOlder = false
			default:
				if !seen[id] {
					seen[id] = true
					out.items = append(out.items, scannedItem{a: a, day: day, inst: inst})
				}
				allOlder = false
			}
		}
		if allOlder {
			return out, nil
		}
		if len(acts) < recentListPage {
			return out, nil // short page = list end
		}
	}
	return nil, fmt.Errorf("garmin: recent activity walk exceeded %d pages without crossing the window start", recentMaxListPages)
}

// fetchOneActivityRecent fetches one activity's detail sub-resources with the
// onboarding completeness policy: detail and splits are REQUIRED unless the
// vendor answers 404 (legitimately not provided — recorded, not fabricated);
// any other failure fails the run. Weather stays best-effort, matching the
// general sync.
func (p *Provider) fetchOneActivityRecent(ctx context.Context, client *Client, user string, a rawActivity) (activityResult, int, error) {
	missing := 0
	labelID := a.labelID()
	fetch := func(kind string, get func() (json.RawMessage, error)) (json.RawMessage, error) {
		raw, err := get()
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
			missing++
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("garmin: activity %s %s fetch: %w", labelID, kind, err)
		}
		return raw, nil
	}
	detailsRaw, err := fetch("details", func() (json.RawMessage, error) {
		return client.GetActivityDetails(ctx, labelID, activityDetailsMaxChart, activityDetailsMaxPoly)
	})
	if err != nil {
		return activityResult{}, missing, err
	}
	splitsRaw, err := fetch("splits", func() (json.RawMessage, error) {
		return client.GetActivitySplits(ctx, labelID)
	})
	if err != nil {
		return activityResult{}, missing, err
	}
	// A 200 whose body is not the expected shape is a vendor anomaly, not a
	// silent nil: keep the general sync's guard but count it as missing (a
	// 404 already counted above and stays nil without double counting).
	if len(detailsRaw) > 0 {
		var detailShape map[string]json.RawMessage
		if json.Unmarshal(detailsRaw, &detailShape) != nil || detailShape["activityDetailMetrics"] == nil {
			detailsRaw = nil
			missing++
		}
	}
	if len(splitsRaw) > 0 {
		var splitShape map[string]json.RawMessage
		if json.Unmarshal(splitsRaw, &splitShape) != nil || splitShape["lapDTOs"] == nil {
			splitsRaw = nil
			missing++
		}
	}
	weatherRaw, _ := client.GetActivityWeather(ctx, labelID)
	var weather *rawWeather
	if len(weatherRaw) > 0 {
		var w rawWeather
		if json.Unmarshal(weatherRaw, &w) == nil {
			weather = &w
		}
	}
	activity := buildActivity(user, a, weather)
	timeseries := parseDetailsTimeseries(detailsRaw)
	activity.SetStartGPSFromTimeseries(timeseries)
	return activityResult{
		activity:   activity,
		laps:       parseSplits(splitsRaw),
		timeseries: timeseries,
	}, missing, nil
}

// recentFetchOrdered mirrors the general sync's bounded-ahead fetch +
// strictly-ordered commit, with the onboarding resume rule applied BEFORE any
// fetch: an activity that already exists was committed complete by an earlier
// attempt (summary and detail commit together), so it is skipped without
// re-downloading anything (中断重试不重复下载成功详情). The first failure
// stops the commit at the gap; the job retry resumes from it. It returns the
// write/skip/missing accounting plus every in-window day the store now holds.
func (p *Provider) recentFetchOrdered(ctx context.Context, client *Client, user string, ordered []scannedItem, jobs int, progress provider.ProgressCallback) (written, skipped, missing int, days []string, gaps []provider.RangeGap, commitErr error) {
	started := time.Now()
	fetchList := make([]scannedItem, 0, len(ordered))
	days = make([]string, 0, len(ordered))
	for _, it := range ordered {
		exists, err := p.store.ActivityExists(ctx, user, it.a.labelID())
		if err != nil {
			return 0, 0, 0, nil, nil, err
		}
		if exists {
			// Resume reuse: a row inside this window was necessarily written
			// by a completed pass of this stage, and its day still counts
			// toward the observed window.
			skipped++
			days = append(days, it.day)
			continue
		}
		fetchList = append(fetchList, it)
	}
	results := make([]activityResult, len(fetchList))
	missings := make([]int, len(fetchList))
	ready := make([]chan struct{}, len(fetchList))
	for i := range ready {
		ready[i] = make(chan struct{})
	}
	fetchCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	indices := make(chan int)
	inFlight := make(chan struct{}, jobs)
	go func() {
		defer close(indices)
		for i := range fetchList {
			select {
			case inFlight <- struct{}{}:
			case <-fetchCtx.Done():
				return
			}
			select {
			case indices <- i:
			case <-fetchCtx.Done():
				return
			}
		}
	}()
	var wg sync.WaitGroup
	for range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range indices {
				var err error
				results[i], missings[i], err = p.fetchOneActivityRecent(fetchCtx, client, user, fetchList[i].a)
				if err != nil {
					results[i].err = err
				}
				close(ready[i])
			}
		}()
	}
	for i := range fetchList {
		select {
		case <-ready[i]:
		case <-ctx.Done():
			commitErr = ctx.Err()
		}
		if commitErr != nil {
			break
		}
		r := results[i]
		results[i] = activityResult{}
		<-inFlight
		if r.err != nil {
			if isRangeRejection(r.err) {
				gaps = append(gaps, rejectedActivityGap(fetchList[i].a.labelID(), fetchList[i].day, r.err))
				continue
			}
			commitErr = r.err
			break
		}
		labelID := fetchList[i].a.labelID()
		missing += missings[i]
		if err := p.store.UpsertActivityPreservingEmptyChildren(ctx, r.activity, r.laps, r.timeseries, nil); err != nil {
			commitErr = err
			break
		}
		written++
		days = append(days, fetchList[i].day)
		if err := p.store.SetMeta(ctx, user, "last_label_id", labelID); err != nil {
			commitErr = err
			break
		}
		provider.EmitProgress(progress, "activities", i+1, len(fetchList), provider.PercentInBand(i+1, len(fetchList), 10, 80))
	}
	cancel()
	wg.Wait()
	log := logging.Default()
	if commitErr != nil {
		for i, result := range results {
			if isRangeRejection(result.err) {
				gaps = append(gaps, rejectedActivityGap(fetchList[i].a.labelID(), fetchList[i].day, result.err))
			}
		}
		log.Warn("garmin recent activity pipeline failed",
			zap.String("user", user), zap.Int("written", written),
			zap.Int("skipped_existing", skipped), zap.Error(commitErr))
	} else {
		log.Info("garmin recent activity pipeline completed",
			zap.String("user", user), zap.Int("written", written),
			zap.Int("skipped_existing", skipped), zap.Int("provider_missing_detail", missing),
			zap.Duration("elapsed", time.Since(started)))
	}
	return written, skipped, missing, days, gaps, commitErr
}

func rejectedActivityGap(id, day string, err error) provider.RangeGap {
	return provider.RangeGap{From: day, To: day, Kind: provider.RangeGapUnavailable, ActivityID: id,
		Reason: fmt.Sprintf("activity %s permanently rejected by provider: %v", id, err)}
}

// ─────────────────────────────────────────────────────────────────────────────
// Health channel
// ─────────────────────────────────────────────────────────────────────────────

// recentHealth walks the FIXED anchor window old→new (no now(), no
// consecutive-empty cutoff — every day is queried). Measurements are written
// only when the provider returned signal; a day every endpoint of which
// answered empty is the vendor's honest "no rows for this date" — recorded
// as a gap day exactly like the COROS channel's short batch answer, never a
// fabricated measurement (合法无数据不伪造).
func (p *Provider) recentHealth(ctx context.Context, client *Client, user string, win provider.DayWindow, jobs int, rejectedEndpoints map[string]map[string]bool, progress provider.ProgressCallback) (*provider.RangeChannelReport, error) {
	from, err := time.Parse(time.DateOnly, win.From)
	if err != nil {
		return nil, fmt.Errorf("garmin: recent health window start %q: %w", win.From, err)
	}
	to, err := time.Parse(time.DateOnly, win.To)
	if err != nil {
		return nil, fmt.Errorf("garmin: recent health window end %q: %w", win.To, err)
	}
	total := int(to.Sub(from).Hours()/24) + 1
	rep := &provider.RangeChannelReport{ScannedFrom: win.From}
	for n := 0; n < total; n++ {
		date := from.AddDate(0, 0, n).Format(time.DateOnly)
		wrote, gaps, err := p.rangeHealthDay(ctx, client, user, date, jobs, rejectedEndpoints[date])
		rep.Gaps = append(rep.Gaps, gaps...)
		if err != nil {
			if rep.ScannedTo == "" && len(rep.Gaps) == 0 {
				return nil, err
			}
			return rep, err
		}
		rep.ScannedTo = date
		if wrote {
			if rep.ObservedFrom == nil {
				rep.ObservedFrom = &date
			}
			rep.ObservedTo = &date
			rep.Count++
		} else if len(gaps) == 0 && len(rejectedEndpoints[date]) == 0 {
			rep.Gaps = append(rep.Gaps, provider.RangeGap{
				From: date, To: date, Kind: provider.RangeGapEmpty, Reason: "provider returned no health rows for day",
			})
		}
		provider.EmitProgress(progress, "health", n+1, total, provider.PercentInBand(n+1, total, 80, 95))
	}
	rep.Status = provider.RangeChannelDone
	if len(rep.Gaps) > 0 {
		rep.Status = provider.RangeChannelGap
		rep.Gaps = coalesceRecentGaps(rep.Gaps)
	}
	obs := "-..-"
	if rep.ObservedFrom != nil {
		obs = *rep.ObservedFrom + ".." + *rep.ObservedTo
	}
	rep.Credential = fmt.Sprintf("garmin:v1:range:health:%s..%s:obs=%s:n=%d", win.From, win.To, obs, rep.Count)
	return rep, nil
}

// rangeHealthDay records per-endpoint rejection evidence even when another
// endpoint on that day needs retry, so subsequent attempts can skip it.
func (p *Provider) rangeHealthDay(ctx context.Context, client *Client, user, date string, jobs int, skip map[string]bool) (bool, []provider.RangeGap, error) {
	tsRaw, usRaw, sleepRaw, hrvRaw, err := fetchHealthDay(ctx, client, date, jobs, skip)
	gaps, retry := classifyRangeHealthErrors(date, err)
	if retry != nil {
		return false, gaps, retry
	}
	observed := false
	if h := buildDailyHealth(user, date, tsRaw, usRaw, sleepRaw); hasSignal(h) {
		if err := p.store.UpsertDailyHealth(ctx, h); err != nil {
			return false, gaps, err
		}
		observed = true
	}
	if hrv := buildDailyHRV(user, date, hrvRaw); hrvHasSignal(hrv) {
		if err := p.store.UpsertDailyHRV(ctx, hrv); err != nil {
			return false, gaps, err
		}
		observed = true
	}
	return observed, gaps, nil
}

func classifyRangeHealthErrors(date string, err error) ([]provider.RangeGap, error) {
	if err == nil {
		return nil, nil
	}
	window := provider.DayWindow{From: date, To: date}
	causes := []error{err}
	var joined interface{ Unwrap() []error }
	if errors.As(err, &joined) {
		causes = joined.Unwrap()
	}
	var gaps []provider.RangeGap
	var retry error
	for _, cause := range causes {
		if !isRangeRejection(cause) {
			retry = errors.Join(retry, cause)
			continue
		}
		gap := provider.RejectedRange(window, cause)
		var endpoint *healthEndpointError
		if errors.As(cause, &endpoint) {
			gap.Endpoint = endpoint.endpoint
		}
		gaps = append(gaps, gap)
	}
	if retry != nil {
		return gaps, &provider.RangeFetchError{Window: window, Err: retry}
	}
	return gaps, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard channel
// ─────────────────────────────────────────────────────────────────────────────

// recentDashboard refreshes the dashboard singleton for the anchor day through
// the existing normalization and write path (syncDashboard). Unlike the
// periodic sync's best-effort dashboard pull, a fetch failure FAILS the
// channel, and an answer that stores nothing is an honest gap, not a done
// dashboard — the onboarding stage's dashboard work item must not silently
// read done with no snapshot behind it.
func (p *Provider) recentDashboard(ctx context.Context, client *Client, user string, win provider.DayWindow, known map[string]map[string]bool) (*provider.RangeChannelReport, error) {
	anchor, err := time.Parse(time.DateOnly, win.From)
	if err != nil {
		return nil, fmt.Errorf("garmin: recent dashboard day %q: %w", win.From, err)
	}
	var syncRes provider.SyncResult
	var gaps []provider.RangeGap
	err = p.syncDashboardRange(ctx, client, user, anchor, &syncRes, known, func(entries []provider.RangeGap) {
		gaps = append(gaps, entries...)
	})
	if err != nil {
		if len(gaps) > 0 {
			return &provider.RangeChannelReport{Gaps: gaps}, err
		}
		return nil, err
	}
	report := &provider.RangeChannelReport{Status: provider.RangeChannelDone, ScannedFrom: win.From, ScannedTo: win.To, Count: syncRes.Health, Gaps: gaps}
	obs := "-..-"
	if syncRes.Health > 0 {
		report.ObservedFrom, report.ObservedTo = &win.From, &win.To
		obs = win.From + ".." + win.To
	} else if len(gaps) == 0 && len(known[win.From]) == 0 {
		report.Gaps = []provider.RangeGap{{From: win.From, To: win.To, Kind: provider.RangeGapEmpty, Reason: "provider returned no dashboard summary"}}
	}
	if len(report.Gaps) > 0 {
		report.Status = provider.RangeChannelGap
	}
	report.Credential = fmt.Sprintf("garmin:v1:range:dashboard:%s..%s:obs=%s:n=%d", win.From, win.To, obs, syncRes.Health)
	return report, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Day-label helpers (the COROS channel keeps its own copies in coros; these
// stay package-local per the adapter-boundary rule).
// ─────────────────────────────────────────────────────────────────────────────

// coalesceRecentGaps combines adjacent or overlapping ranges with the same meaning.
func coalesceRecentGaps(gaps []provider.RangeGap) []provider.RangeGap {
	if len(gaps) <= 1 {
		return gaps
	}
	sort.Slice(gaps, func(i, j int) bool { return gaps[i].From < gaps[j].From })
	out := make([]provider.RangeGap, 0, len(gaps))
	cur := gaps[0]
	for _, g := range gaps[1:] {
		if g.Kind == cur.Kind && g.Reason == cur.Reason && g.Endpoint == cur.Endpoint && g.From <= nextShanghaiDay(cur.To) {
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

// prevShanghaiDay/nextShanghaiDay step one Shanghai natural day inside the
// YYYY-MM-DD label space (labels are calendar days, so date arithmetic in the
// Shanghai location is exact).
func prevShanghaiDay(day string) string { return stepShanghaiDay(day, -1) }
func nextShanghaiDay(day string) string { return stepShanghaiDay(day, +1) }

func stepShanghaiDay(day string, delta int) string {
	t, err := time.ParseInLocation("2006-01-02", day, timefmt.Shanghai)
	if err != nil {
		return day
	}
	return t.AddDate(0, 0, delta).Format("2006-01-02")
}
