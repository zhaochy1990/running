// backfill.go is the COROS half of the chunked background backfill contract
// (devops#1010, epic devops#1004 T06): provider.BackfillSyncer over the
// extended/historical activity windows and the batch health window.
//
// Activities walk semantics (the recent scan's rules, made resumable):
//
//   - the walk runs newest→oldest over the vendor list and NEVER treats an
//     already-stored activity as a coverage proof — existence only skips the
//     re-fetch (历史扫描越过已存在活动). The opaque checkpoint records the day of
//     the last PROCESSED item: strictly newer days are skipped without a
//     probe, the checkpoint day itself is re-probed (a budget stop can split
//     a day), older days are processed.
//   - one chunk fetches at most budget.MaxActivityFetches missing details,
//     then checkpoints and yields — the executor's lease is released between
//     chunks, so new trainings/webhooks jump the queue.
//   - the walk ends at the vendor list's end or a PROVEN-ordered crossing of
//     the window's lower boundary (same proof rule as the recent scan). A
//     completion reconciliation then re-walks the list for in-window items
//     still missing from the store (mid-list backfills, webhook races) and
//     fetches what the remaining budget allows; leftovers reset the
//     checkpoint so the next chunk re-probes from the top instead of marking
//     a holed window done (对账复用，不假完成).
//
// Health is one batch request: the vendor returns one fixed window per call,
// so a chunk is the whole item regardless of day budget — COROS only ever
// declares the days that batch actually returned (只声明实际可得范围).
package coros

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/provider"
	"go.uber.org/zap"
)

// backfillMaxListPages bounds one chunk's list walk. The walk stops at the
// budget or the window boundary long before this in any healthy account;
// reaching the bound means pathological feed content and surfaces as an error
// instead of an unbounded crawl.
const backfillMaxListPages = 2000

// The COROS adapter carries the chunked backfill contract (devops#1010).
var _ provider.BackfillSyncer = (*Provider)(nil)

// cpActPrefix/cpActDone build/parse the activities checkpoint:
// coros:v1:cp:act:done=<YYYY-MM-DD>.
const (
	cpActPrefix = "coros:v1:cp:act:done="
)

func encodeActCheckpoint(doneThrough string) string {
	if doneThrough == "" {
		return ""
	}
	return cpActPrefix + doneThrough
}

func parseActCheckpoint(cp string) string {
	if !strings.HasPrefix(cp, cpActPrefix) {
		return "" // foreign/empty checkpoint: restart from the window top
	}
	day := strings.TrimPrefix(cp, cpActPrefix)
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
	client.EnableRateLimit(provider.DetailJobs(opts.Jobs))

	var rep provider.BackfillRangeReport
	if opts.Activities != nil {
		r, err := p.backfillActivities(ctx, client, user, *opts.Activities, opts.ActivitiesCheckpoint, opts.RejectedActivityIDs, opts.Budget, opts.Jobs, progress)
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
		r, err := p.backfillHealth(ctx, client, user, *opts.Health)
		if err != nil {
			if !isRangeRejection(err) {
				return rep, err
			}
			r = &provider.ChannelBackfillReport{Done: true, Rejected: true, GapEvents: []provider.RangeGap{provider.RejectedRange(*opts.Health, err)}}
		}
		rep.Health = r
	}
	return rep, nil
}

// backfillCandidate is one process-candidate of the chunk walk.
type backfillCandidate struct {
	item listItem
	day  string // "" = undated (the detail decides)
}

// backfillActivities runs one activities chunk: walk → process (skip existing
// / fetch missing ≤ budget) → optional completion reconcile.
func (p *Provider) backfillActivities(ctx context.Context, client *Client, user string, win provider.DayWindow, checkpoint string, rejectedIDs map[string]bool, budget provider.BackfillBudget, jobs int, progress provider.ProgressCallback) (*provider.ChannelBackfillReport, error) {
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

	// Phase 1: walk the list collecting this chunk's process-candidates.
	// Everything strictly above doneThrough (and inside the window) is
	// already processed — skipped on list-date alone, no store probe.
	var candidates []backfillCandidate
	fetchesNeeded := 0 // missing (unprobed) candidates — the walk probes as it goes
	seenLabels := map[string]bool{}
	ordered := true
	prevDay := ""
	belowBoundary := false
	scanEnded := false
	lastSeenDay := doneThrough

	for page := 1; page <= backfillMaxListPages; page++ {
		if !deadline.IsZero() && time.Now().After(deadline) {
			break // soft budget: checkpoint what the walk already collected
		}
		raw, err := client.ListActivities(ctx, page, rangePageSize)
		if err != nil {
			return nil, err
		}
		dataList, err := parseListPage(raw)
		if err != nil {
			return nil, err
		}
		if len(dataList) == 0 {
			scanEnded = true // list exhausted: the whole history was walked
			break
		}
		for _, item := range dataList {
			day, dated := listShanghaiDay(item)
			if dated {
				if prevDay != "" && day > prevDay {
					ordered = false
				}
				prevDay = day
				if day < win.From {
					belowBoundary = true
				}
			} else {
				ordered = false
			}
			if !isKnownSportCode(item.SportType) {
				continue
			}
			if dated && (day > win.To || (doneThrough != "" && day > doneThrough)) {
				continue // above the window or already processed: no probe
			}
			if dated && day < win.From {
				continue // below the window: never fetched
			}
			if seenLabels[item.LabelID] {
				continue // a shifted/re-served page repeated an entry
			}
			seenLabels[item.LabelID] = true
			if rejectedIDs[item.LabelID] {
				if dated {
					lastSeenDay = day
				}
				continue
			}
			exists, err := p.store.ActivityExists(ctx, user, item.LabelID)
			if err != nil {
				return nil, err
			}
			if exists {
				if dated {
					lastSeenDay = day
				}
				continue // 历史扫描越过已存在活动（webhook/近期阶段写入可复用）
			}
			if fetchesNeeded >= maxFetches {
				// Budget is full: stop collecting. The checkpoint stops at the
				// last processed item, so the remainder re-probes next chunk.
				continue
			}
			fetchesNeeded++
			candidates = append(candidates, backfillCandidate{item: item, day: day})
			if dated {
				lastSeenDay = day
			}
		}
		if ordered && belowBoundary {
			scanEnded = true // proven crossing of the lower boundary
			break
		}
		if len(dataList) < rangePageSize {
			scanEnded = true // short page = list end
			break
		}
		if fetchesNeeded >= maxFetches {
			break // budget full: the checkpoint resumes behind this position
		}
	}
	// Hitting the page bound without scanEnded is a legitimate chunk boundary:
	// the checkpoint carries the walk position and the next chunk continues
	// behind it. A walk that truly cannot advance (no new day, no candidates)
	// reports Advanced=false and the executor fails the chunk instead of
	// spinning.

	// Phase 2: fetch + commit the chunk's missing details through the same
	// ordered fenced path the recent scan uses. Permanently rejected items
	// become gap events; any other failure fails the chunk (the retry resumes
	// from the persisted checkpoint — committed rows re-probe as existing).
	var gapEvents []provider.RangeGap
	fetched := 0
	if len(candidates) > 0 {
		committed, commitErr := fetchBackfillCandidates(ctx, p, client, user, candidates, jobs, progress, win, &gapEvents)
		fetched = committed + len(gapEvents)
		if commitErr != nil {
			// The committed prefix is durable in the store; the retry re-probes
			// it as existing. No report on failure — the executor must not
			// persist a checkpoint past an uncommitted gap.
			return &provider.ChannelBackfillReport{Checkpoint: checkpoint, GapEvents: gapEvents}, commitErr
		}
	}

	provider.RememberRejectedActivities(rejectedIDs, gapEvents)

	advanced := fetched > 0 || lastSeenDay != doneThrough || len(gapEvents) > 0

	// Phase 3: completion reconciliation — only once the walk reached the
	// list end / proven boundary. Re-walk for in-window items still missing
	// from the store (mid-list backfills, webhook-written rows moving).
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
			priorGaps := len(gapEvents)
			committed, commitErr := fetchBackfillCandidates(ctx, p, client, user, missing, jobs, progress, win, &gapEvents)
			fetched += committed + len(gapEvents) - priorGaps
			if commitErr != nil {
				return &provider.ChannelBackfillReport{Checkpoint: checkpoint, GapEvents: gapEvents}, commitErr
			}
		}
		if !overflow {
			// The window is walked and reconciled with every in-window item
			// either stored or gap-recorded: the channel is complete — also
			// after a checkpoint reset whose follow-up chunk finds nothing
			// left (the reset's "re-probe everything" pass).
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
	return &provider.ChannelBackfillReport{
		Checkpoint:     encodeActCheckpoint(scannedThrough),
		ScannedThrough: scannedThrough,
		Advanced:       advanced,
		Fetches:        fetched,
		GapEvents:      gapEvents,
	}, nil
}

// fetchBackfillCandidates fetches and commits one candidate batch through the
// shared ordered path, appending permanent-rejection gap events.
func fetchBackfillCandidates(ctx context.Context, p *Provider, client *Client, user string, candidates []backfillCandidate, jobs int, progress provider.ProgressCallback, win provider.DayWindow, gapEvents *[]provider.RangeGap) (int, error) {
	orderedItems := make([]listItem, len(candidates))
	for i, c := range candidates {
		orderedItems[i] = c.item
	}
	res := &provider.SyncResult{}
	skip := func(item listItem, err error) {
		day, ok := listShanghaiDay(item)
		if !ok {
			day = win.To
		}
		*gapEvents = append(*gapEvents, provider.RangeGap{
			From: day, To: day,
			Kind: provider.RangeGapUnavailable, ActivityID: item.LabelID, Reason: fmt.Sprintf("activity %s permanently rejected by provider: %v", item.LabelID, err),
		})
		logging.Default().Warn("coros: backfill records permanent activity gap",
			zap.String("user", user), zap.String("label_id", item.LabelID), zap.Error(err))
	}
	committed, commitErr := p.fetchDetailsOrdered(ctx, client, user, orderedItems, provider.DetailJobs(jobs), progress, res, skip)
	return len(committed), commitErr
}

// reconcileBackfillRange re-walks the FULL vendor list (to its end or a
// proven below-boundary page — no head shortcut) and returns the in-window
// items still missing from the store. This is the completion honesty gate: a
// mid-list backfill at any depth must be found before the channel may report
// done (对账不漏深处分页补传).
func (p *Provider) reconcileBackfillRange(ctx context.Context, client *Client, user string, win provider.DayWindow, rejectedIDs map[string]bool) ([]backfillCandidate, error) {
	var missing []backfillCandidate
	seen := map[string]bool{}
	prevDay := ""
	ordered := true
	belowBoundary := false
	for page := 1; page <= backfillMaxListPages; page++ {
		raw, err := client.ListActivities(ctx, page, rangePageSize)
		if err != nil {
			return nil, err
		}
		dataList, err := parseListPage(raw)
		if err != nil {
			return nil, err
		}
		if len(dataList) == 0 {
			return missing, nil
		}
		for _, item := range dataList {
			if !isKnownSportCode(item.SportType) {
				continue
			}
			day, dated := listShanghaiDay(item)
			if dated {
				if prevDay != "" && day > prevDay {
					ordered = false
				}
				prevDay = day
				if day < win.From {
					belowBoundary = true
				}
			} else {
				ordered = false
			}
			if dated && (day < win.From || day > win.To) {
				continue
			}
			if seen[item.LabelID] || rejectedIDs[item.LabelID] {
				continue
			}
			seen[item.LabelID] = true
			exists, err := p.store.ActivityExists(ctx, user, item.LabelID)
			if err != nil {
				return nil, err
			}
			if !exists {
				missing = append(missing, backfillCandidate{item: item, day: day})
			}
		}
		if ordered && belowBoundary {
			return missing, nil // proven: nothing older is in-window
		}
		if len(dataList) < rangePageSize {
			return missing, nil
		}
	}
	return nil, fmt.Errorf("coros: backfill reconcile exceeded %d pages", backfillMaxListPages)
}

// backfillHealth runs the whole health item in one chunk: the batch endpoint
// is a single request returning a fixed window — a day budget would only
// re-download the same batch. The channel completes in this chunk; the
// executor derives observed days and gaps from the store (the range report's
// own gap/observed accounting is intentionally dropped — storage is the
// coverage truth for backfill channels).
func (p *Provider) backfillHealth(ctx context.Context, client *Client, user string, win provider.DayWindow) (*provider.ChannelBackfillReport, error) {
	rep, err := p.rangeHealth(ctx, client, user, win)
	if err != nil {
		return nil, err
	}
	return &provider.ChannelBackfillReport{
		Done: true, Advanced: true, DaysWalked: rep.Count, GapEvents: rep.Gaps,
	}, nil
}
