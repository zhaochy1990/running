// backfill.go is the Garmin half of the chunked background backfill contract
// (devops#1010, epic devops#1004 T06): provider.BackfillSyncer over the
// extended/historical activity windows and the up-to-365-day health walk.
//
// Activities walk semantics mirror the COROS backfill (and the recent scan's
// proof rules): newest→oldest walk, never stopping at already-stored rows
// (existence only skips the re-fetch — webhook/recent writes are reused
// verbatim), checkpoint = day of the last processed item (strictly newer days
// skip without a probe, the checkpoint day re-probes), one chunk fetches at
// most budget.MaxActivityFetches details then checkpoints and yields. The
// walk ends at the vendor list's end or a PROVEN-ordered page entirely older
// than the window; a completion reconciliation then re-walks the full list
// for in-window items still missing from the store (mid-list backfills,
// webhook races) and fetches what the remaining budget allows — overflow
// resets the checkpoint so the next chunk re-probes instead of faking a done
// window (对账复用，不假完成).
//
// Undatable entries follow the recent policy one level down: the detail
// payload's startTimeGMT recovers a date (recovered rows rejoin the window),
// a 404 is a phantom drop — but an entry that stays undatable DEEP IN HISTORY
// is recorded as a per-item gap event and the walk continues, instead of
// blocking the user's whole history the way the recent window does
// (devops#1010: one vendor garbage row must not permanently fail a
// years-deep backfill; the gap is the honest record).
//
// Health walks old→new in ≤ budget.MaxHealthDays day chunks from the
// checkpoint's next un-walked day; Done arrives only after the window's last
// day. Observed days and empty-day gaps are derived from storage by the
// executor (a day with no stored health/HRV row is the vendor's honest "no
// rows for this date").
package garmin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/provider"
	"go.uber.org/zap"
)

// The Garmin adapter carries the chunked backfill contract (devops#1010).
var _ provider.BackfillSyncer = (*Provider)(nil)

// Checkpoint codecs: garmin:v1:cp:act:done=<day> / garmin:v1:cp:health:next=<day>.
const (
	cpActPrefix    = "garmin:v1:cp:act:done="
	cpHealthPrefix = "garmin:v1:cp:health:next="
)

func encodeActCheckpoint(doneThrough string) string {
	if doneThrough == "" {
		return ""
	}
	return cpActPrefix + doneThrough
}

func parseActCheckpoint(cp string) string {
	if !strings.HasPrefix(cp, cpActPrefix) {
		return ""
	}
	day := strings.TrimPrefix(cp, cpActPrefix)
	if len(day) != 10 {
		return ""
	}
	return day
}

func encodeHealthCheckpoint(next string) string { return cpHealthPrefix + next }

func parseHealthCheckpoint(cp string) string {
	if !strings.HasPrefix(cp, cpHealthPrefix) {
		return ""
	}
	day := strings.TrimPrefix(cp, cpHealthPrefix)
	if len(day) != 10 {
		return ""
	}
	return day
}

// SyncBackfillRange executes one bounded chunk of the requested channels.
func (p *Provider) SyncBackfillRange(ctx context.Context, user string, opts provider.BackfillRangeOptions, progress provider.ProgressCallback) (provider.BackfillRangeReport, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return provider.BackfillRangeReport{}, err
	}
	jobs := provider.DetailJobs(opts.Jobs)
	client.EnableRateLimit(jobs)

	var rep provider.BackfillRangeReport
	if opts.Activities != nil {
		r, err := p.backfillActivities(ctx, client, user, *opts.Activities, opts.ActivitiesCheckpoint, opts.RejectedActivityIDs, opts.Budget, jobs, progress)
		if err != nil {
			if !isRangeRejection(err) {
				rep.Activities = r
				return rep, err
			}
			r = &provider.ChannelBackfillReport{Done: true, Rejected: true, GapEvents: []provider.RangeGap{provider.RejectedRange(*opts.Activities, err)}}
		}
		rep.Activities = r
	}
	if opts.Health != nil {
		r, err := p.backfillHealth(ctx, client, user, *opts.Health, opts.HealthCheckpoint, opts.Budget, jobs, opts.RejectedHealthEndpoints, progress)
		if err != nil {
			if !isRangeRejection(err) {
				rep.Health = r
				return rep, err
			}
			r = &provider.ChannelBackfillReport{Done: true, Rejected: true, GapEvents: []provider.RangeGap{provider.RejectedRange(*opts.Health, err)}}
		}
		rep.Health = r
	}
	return rep, nil
}

// backfillActivities runs one activities chunk.
func (p *Provider) backfillActivities(ctx context.Context, client *Client, user string, win provider.DayWindow, checkpoint string, rejectedIDs map[string]bool, budget provider.BackfillBudget, jobs int, progress provider.ProgressCallback) (*provider.ChannelBackfillReport, error) {
	log := logging.Default().With(zap.String("user", user))
	if rejectedIDs == nil {
		rejectedIDs = make(map[string]bool)
	}
	maxFetches := budget.MaxActivityFetches
	if maxFetches <= 0 {
		maxFetches = provider.DefaultBackfillActivityFetches
	}
	var deadline time.Time
	if budget.Soft > 0 {
		deadline = time.Now().Add(budget.Soft)
	}
	doneThrough := parseActCheckpoint(checkpoint)
	// resetToTop marks the overflow reset: the next chunk re-probes the whole
	// window, so the returned checkpoint clears entirely.
	resetToTop := false
	seen := map[string]bool{} // vendor re-served pages must not duplicate candidates

	var candidates []scannedItem
	fetchesNeeded := 0
	var gapEvents []provider.RangeGap
	prevDay := ""
	ordered := true
	scanEnded := false
	lastSeenDay := doneThrough

	// confirmUndated resolves an unclassifiable list entry against its detail
	// payload (the recent policy): a recovered date rejoins the window, a 404
	// is a phantom drop, a still-undatable entry becomes a gap event and the
	// walk continues.
	confirmUndated := func(a rawActivity) error {
		id := a.labelID()
		raw, err := client.GetActivityDetails(ctx, id, activityDetailsMaxChart, activityDetailsMaxPoly)
		var apiErr *APIError
		switch {
		case errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound:
			gapEvents = append(gapEvents, rejectedActivityGap(id, win.To, err))
			log.Warn("garmin: backfill dropped a phantom undated list entry", zap.String("label_id", id))
			return nil
		case err != nil:
			return err
		default:
			var detail struct {
				StartTimeGMT string `json:"startTimeGMT"`
			}
			if json.Unmarshal(raw, &detail) == nil && detail.StartTimeGMT != "" {
				fixed := a
				fixed.StartTimeGMT = detail.StartTimeGMT
				if day, inst, ok := shanghaiDayOfClassifiable(fixed); ok && day >= win.From && day <= win.To {
					return p.collectBackfillCandidate(ctx, user, fixed, day, inst, &candidates, &lastSeenDay, &fetchesNeeded, maxFetches)
				}
			}
			anchor := lastSeenDay
			if anchor == "" {
				anchor = win.To
			}
			gapEvents = append(gapEvents, provider.RangeGap{
				From: anchor, To: anchor,
				Kind: provider.RangeGapUnavailable, Reason: fmt.Sprintf("activity %s has an unclassifiable start date even in its detail payload", id),
			})
			return nil
		}
	}

	for page := 0; page < recentMaxListPages; page++ {
		if !deadline.IsZero() && time.Now().After(deadline) {
			break // soft budget: checkpoint what the walk collected
		}
		raw, err := client.ListActivities(ctx, page*recentListPage, recentListPage)
		if err != nil {
			return nil, err
		}
		acts, err := parseActivityList(raw)
		if err != nil {
			return nil, err
		}
		if len(acts) == 0 {
			scanEnded = true // list exhausted
			break
		}
		pageAllBelowFrom := true // proof candidate: every entry older than From
		for _, a := range acts {
			id := a.labelID()
			day, inst, ok := shanghaiDayOfClassifiable(a)
			if !ok || id == "" {
				pageAllBelowFrom = false // unclassifiable/identityless: no proof
				ordered = false
				if id != "" && !rejectedIDs[id] && !seen[id] {
					seen[id] = true
					if err := confirmUndated(a); err != nil {
						return nil, err
					}
				}
				continue
			}
			if prevDay != "" && day > prevDay {
				ordered = false
			}
			prevDay = day
			switch {
			case day < win.From:
				// The candidate stop signal; never fetched.
			case day > win.To:
				pageAllBelowFrom = false // newer than the window
			case doneThrough != "" && day > doneThrough:
				// Already processed: skip on date alone, no probe.
			default:
				pageAllBelowFrom = false
				if seen[id] {
					continue // a shifted/re-served page repeated an entry
				}
				seen[id] = true
				if rejectedIDs[id] {
					lastSeenDay = day
					continue
				}
				if err := p.collectBackfillCandidate(ctx, user, a, day, inst, &candidates, &lastSeenDay, &fetchesNeeded, maxFetches); err != nil {
					return nil, err
				}
			}
		}
		if ordered && pageAllBelowFrom {
			scanEnded = true // proven crossing of the lower boundary
			break
		}
		if len(acts) < recentListPage {
			scanEnded = true // short page = list end
			break
		}
		if fetchesNeeded >= maxFetches {
			break // budget full: the checkpoint resumes behind this position
		}
	}

	// Fetch + commit the chunk's missing candidates through the shared ordered
	// resume path (existence re-probed inside; committed rows never re-fetch).
	fetched := 0
	if len(candidates) > 0 {
		written, _, _, _, rejected, commitErr := p.recentFetchOrdered(ctx, client, user, candidates, jobs, progress)
		gapEvents = append(gapEvents, rejected...)
		fetched = written + len(rejected)
		if commitErr != nil {
			return &provider.ChannelBackfillReport{Checkpoint: checkpoint, GapEvents: gapEvents}, commitErr
		}
	}

	provider.RememberRejectedActivities(rejectedIDs, gapEvents)

	advanced := fetched > 0 || lastSeenDay != doneThrough || len(gapEvents) > 0

	// Completion reconciliation: the full-list re-walk for in-window items
	// still missing (mid-list backfills, webhook races).
	if scanEnded {
		missing, err := p.reconcileBackfillRange(ctx, client, user, win, rejectedIDs)
		if err != nil {
			return &provider.ChannelBackfillReport{Checkpoint: checkpoint, GapEvents: gapEvents}, err
		}
		overflow := len(missing) > maxFetches-fetched
		if overflow {
			resetToTop = true
			// More backfill than the budget allows: do NOT claim the window
			// done — reset the checkpoint so the next chunk re-probes the
			// whole window (existence skips what exists; nothing re-downloads).
			doneThrough = ""
			advanced = true
		} else if len(missing) > 0 {
			written, _, _, _, rejected, commitErr := p.recentFetchOrdered(ctx, client, user, missing, jobs, progress)
			gapEvents = append(gapEvents, rejected...)
			fetched += written + len(rejected)
			if commitErr != nil {
				return &provider.ChannelBackfillReport{Checkpoint: checkpoint, GapEvents: gapEvents}, commitErr
			}
		}
		if !overflow {
			// The window is walked and reconciled with every in-window item
			// stored or gap-recorded — also after a checkpoint reset whose
			// follow-up chunk finds nothing left.
			return &provider.ChannelBackfillReport{
				Done: true, Advanced: true, Fetches: fetched, GapEvents: gapEvents,
			}, nil
		}
	}

	scannedThrough := lastSeenDay
	if doneThrough != "" && (lastSeenDay == "" || lastSeenDay > doneThrough) {
		scannedThrough = doneThrough
	}
	if resetToTop {
		// The overflow reset: the next chunk must re-probe the WHOLE window
		// (existence skips stored rows), so the checkpoint clears entirely.
		scannedThrough = ""
	}
	if !advanced {
		// Nothing moved and the window did not complete: a transient stall
		// (e.g. the soft budget expired before any item landed), never a
		// permanent defect — fail retryable so the job backs off instead of
		// the executor's no-progress permanent kill.
		return nil, fmt.Errorf("garmin: backfill chunk made no progress (window %s..%s)", win.From, win.To)
	}
	return &provider.ChannelBackfillReport{
		Checkpoint:     encodeActCheckpoint(scannedThrough),
		ScannedThrough: scannedThrough,
		Advanced:       advanced,
		Fetches:        fetched,
		GapEvents:      gapEvents,
	}, nil
}

// collectBackfillCandidate probes one classified in-window item and collects
// it when missing (within budget); an existing row advances the scan position
// without a re-fetch (越过已存在活动 — recent-stage and webhook writes are
// reused verbatim).
func (p *Provider) collectBackfillCandidate(ctx context.Context, user string, a rawActivity, day string, inst time.Time, candidates *[]scannedItem, lastSeenDay *string, fetchesNeeded *int, maxFetches int) error {
	exists, err := p.store.ActivityExists(ctx, user, a.labelID())
	if err != nil {
		return err
	}
	if exists {
		*lastSeenDay = day
		return nil
	}
	if *fetchesNeeded >= maxFetches {
		return nil // budget full: the checkpoint stays above this day
	}
	*fetchesNeeded++
	*candidates = append(*candidates, scannedItem{a: a, day: day, inst: inst})
	*lastSeenDay = day
	return nil
}

// reconcileBackfillRange re-walks the FULL vendor list (to its end or a
// proven below-boundary page — no head shortcut) and returns the in-window
// items still missing from the store. This is the completion honesty gate: a
// mid-list backfill at any depth must be found before the channel may report
// done.
func (p *Provider) reconcileBackfillRange(ctx context.Context, client *Client, user string, win provider.DayWindow, rejectedIDs map[string]bool) ([]scannedItem, error) {
	var missing []scannedItem
	seen := map[string]bool{}
	prevDay := ""
	ordered := true
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
			return missing, nil
		}
		pageAllBelowFrom := true
		for _, a := range acts {
			id := a.labelID()
			day, inst, ok := shanghaiDayOfClassifiable(a)
			if !ok || id == "" {
				ordered = false
				pageAllBelowFrom = false
				continue
			}
			if prevDay != "" && day > prevDay {
				ordered = false
			}
			prevDay = day
			if day < win.From {
				continue
			}
			pageAllBelowFrom = false
			if day > win.To || seen[id] || rejectedIDs[id] {
				continue
			}
			seen[id] = true
			exists, err := p.store.ActivityExists(ctx, user, id)
			if err != nil {
				return nil, err
			}
			if !exists {
				missing = append(missing, scannedItem{a: a, day: day, inst: inst})
			}
		}
		if ordered && pageAllBelowFrom {
			return missing, nil // proven: nothing older is in-window
		}
		if len(acts) < recentListPage {
			return missing, nil
		}
	}
	return nil, fmt.Errorf("garmin: backfill reconcile exceeded %d pages", recentMaxListPages)
}

// backfillHealth walks ≤ budget.MaxHealthDays days old→new from the
// checkpoint's next un-walked day. Every day is queried (no now(), no
// consecutive-empty cutoff); signal days are written, empty days stay absent
// and are derived as gaps from storage by the executor.
func (p *Provider) backfillHealth(ctx context.Context, client *Client, user string, win provider.DayWindow, checkpoint string, budget provider.BackfillBudget, jobs int, rejectedEndpoints map[string]map[string]bool, progress provider.ProgressCallback) (*provider.ChannelBackfillReport, error) {
	if _, err := time.Parse("2006-01-02", win.From); err != nil {
		return nil, fmt.Errorf("garmin: backfill health window start %q: %w", win.From, err)
	}
	to, err := time.Parse("2006-01-02", win.To)
	if err != nil {
		return nil, fmt.Errorf("garmin: backfill health window end %q: %w", win.To, err)
	}
	maxDays := budget.MaxHealthDays
	if maxDays <= 0 {
		maxDays = provider.DefaultBackfillHealthDays
	}
	next := parseHealthCheckpoint(checkpoint)
	if next == "" {
		next = win.From
	}
	if next > win.To {
		return &provider.ChannelBackfillReport{Done: true, Advanced: true}, nil // already complete
	}
	start, err := time.Parse("2006-01-02", next)
	if err != nil {
		return nil, fmt.Errorf("garmin: backfill health checkpoint %q: %w", next, err)
	}
	var deadline time.Time
	if budget.Soft > 0 {
		deadline = time.Now().Add(budget.Soft)
	}
	walked := 0
	var gaps []provider.RangeGap
	for d := start; !d.After(to) && walked < maxDays; d = d.AddDate(0, 0, 1) {
		if !deadline.IsZero() && time.Now().After(deadline) {
			break
		}
		date := d.Format("2006-01-02")
		_, dayGaps, err := p.rangeHealthDay(ctx, client, user, date, jobs, rejectedEndpoints[date])
		gaps = append(gaps, dayGaps...)
		if err != nil {
			return &provider.ChannelBackfillReport{Checkpoint: encodeHealthCheckpoint(date), DaysWalked: walked, GapEvents: gaps}, err
		}
		walked++
		provider.EmitProgress(progress, "health", walked, maxDays, provider.PercentInBand(walked, maxDays, 80, 95))
	}
	if walked == 0 {
		// The soft budget expired before the first health day landed: a
		// transient slow-vendor condition, not a no-progress defect — return
		// a retryable error instead of an Advanced=false report (which the
		// executor would fail PERMANENTLY).
		return nil, fmt.Errorf("garmin: backfill health soft budget expired before the first day (%s)", next)
	}
	nextLabel := start.AddDate(0, 0, walked).Format("2006-01-02")
	if nextLabel > win.To {
		return &provider.ChannelBackfillReport{Done: true, Advanced: true, DaysWalked: walked, GapEvents: gaps}, nil
	}
	return &provider.ChannelBackfillReport{
		Checkpoint: encodeHealthCheckpoint(nextLabel), Advanced: true, DaysWalked: walked, GapEvents: gaps,
	}, nil
}
