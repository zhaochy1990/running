// backfill.go is the chunked background backfill executor (devops#1010, epic
// devops#1004 T06): one job run executes ONE bounded chunk of the
// extended_raw / historical_raw stages — at most ~20 activity fetches or ~7
// health days per channel under the soft wall-clock budget — persists the
// chunk's resume checkpoint, and reports onboardingsync.StageStatusInProgress
// while work remains. The reconcile sweep requeues the dispatch for the next
// chunk after the dispatch grace, so between chunks the per-user execution
// lease is released and recent stages, new trainings and webhooks jump the
// queue (AC2 让权; 不整条历史 run 持锁).
//
// Coverage honesty is derived from STORAGE, never from chunk bookkeeping: a
// channel that completes gets its terminal observed window and gap set from
// what the store actually holds (ActivityShanghaiDaysInRange /
// DailyHealthDaysInRange), merged with the per-item gap events accumulated in
// the checkpoint (vendor rejections the store cannot see). A channel that
// merely ran out of budget reports in_progress — 假完成 is impossible by
// construction.
package onboardingrecent

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/onboardingsync"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// BackfillProvider is the provider seam the backfill stages need beyond the
// recent contract: the chunked range sync (devops#1010).
type BackfillProvider interface {
	Provider
	SyncBackfillRange(ctx context.Context, user string, opts provider.BackfillRangeOptions, progress provider.ProgressCallback) (provider.BackfillRangeReport, error)
}

// backfillStore is the storage slice the backfill executor adds on top of
// Store: the day-range reads coverage is derived from.
type backfillStore interface {
	Store
	ActivityShanghaiDaysInRange(ctx context.Context, userID, from, to string) ([]string, error)
	DailyHealthDaysInRange(ctx context.Context, userID, from, to string) ([]string, error)
	SaveOnboardingSyncWorkItemCheckpoint(ctx context.Context, id int64, checkpoint string) error
}

// channelCheckpoint is the executor-side half of a backfill item's durable
// checkpoint: the provider-opaque scan cursor plus the running accounting the
// terminal report merges (per-item gap events the store cannot reconstruct,
// fetch tallies for observability). JSON-encoded into
// onboarding_sync_work_items.checkpoint.
type channelCheckpoint struct {
	Cursor         string              `json:"cursor,omitempty"`
	ScannedThrough string              `json:"scanned_through,omitempty"`
	Gaps           []provider.RangeGap `json:"gaps,omitempty"`
	Fetches        int                 `json:"fetches"`
}

func parseChannelCheckpoint(blob *string) channelCheckpoint {
	var cp channelCheckpoint
	if blob != nil && *blob != "" {
		_ = json.Unmarshal([]byte(*blob), &cp)
	}
	return cp
}

func (cp channelCheckpoint) marshal() string {
	if cp.Cursor == "" && len(cp.Gaps) == 0 && cp.Fetches == 0 && cp.ScannedThrough == "" {
		return ""
	}
	b, err := json.Marshal(cp)
	if err != nil {
		return ""
	}
	return string(b)
}

// runBackfill executes one chunk of the extended/historical stage. The
// per-user lease is already held by the caller (New); everything here runs
// fenced exactly like the recent stage.
func runBackfill(ctx context.Context, cfg Config, in stageJobInput, sess *storage.OnboardingSyncSession, prov Provider, hb job.Heartbeat) (string, error) {
	store, ok := cfg.Store.(backfillStore)
	if !ok {
		return "", job.NewPermanentError("store_not_backfill_capable",
			fmt.Errorf("onboardingrecent: store does not implement the backfill coverage reads"))
	}
	bp, ok := prov.(BackfillProvider)
	if !ok {
		// Both shipped adapters implement the contract; this guards a future
		// adapter that ships recent-only. Permanent: retrying cannot add the
		// method (and the rollout gate keeps such providers off the path).
		return "", job.NewPermanentError("provider_not_backfill_capable",
			fmt.Errorf("onboardingrecent: provider %s does not implement the backfill contract", prov.Info().Name))
	}

	if _, err := store.ResetFailedOnboardingSyncWorkItems(ctx, sess.SessionID, in.Stage); err != nil {
		return "", err
	}
	items, err := store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, in.Stage)
	if err != nil {
		return "", err
	}

	// Apply the chunk-budget defaults at ONE place: the executor. The
	// adapters only enforce what they are handed (a test may tighten the
	// budget; production wiring leaves it zero).
	budget := cfg.BackfillBudget
	if budget.MaxActivityFetches <= 0 {
		budget.MaxActivityFetches = provider.DefaultBackfillActivityFetches
	}
	if budget.MaxHealthDays <= 0 {
		budget.MaxHealthDays = provider.DefaultBackfillHealthDays
	}
	if budget.Soft <= 0 {
		budget.Soft = provider.DefaultBackfillSoftBudget
	}
	opts := provider.BackfillRangeOptions{Jobs: cfg.Jobs, Budget: budget}
	byKind := map[string]*storage.OnboardingSyncWorkItem{}
	for _, it := range items {
		byKind[it.Kind] = it
		if it.Status == storage.OnboardingSyncItemDone || it.Status == storage.OnboardingSyncItemGap {
			continue // complete-fetch credentials are reused, gaps stay gaps
		}
		w := provider.DayWindow{From: it.RangeFrom, To: it.RangeTo}
		cp := parseChannelCheckpoint(it.Checkpoint)
		switch it.Kind {
		case kindActivities:
			opts.Activities = &w
			opts.ActivitiesCheckpoint = cp.Cursor
		case kindHealth:
			opts.Health = &w
			opts.HealthCheckpoint = cp.Cursor
		default:
			return "", job.NewPermanentError("bad_work_item",
				fmt.Errorf("onboardingrecent: unknown backfill work item kind %q", it.Kind))
		}
	}
	if opts.Activities == nil && opts.Health == nil {
		// Every item terminal (idempotent completion, e.g. a chunk crash
		// after the item marks): re-report from the persisted outcomes.
		return stageResultFromItems(in.Stage, items), nil
	}

	progress := func(pr provider.SyncProgress) {
		phase, _ := pr["phase"].(string)
		pct, _ := pr["percent"].(int)
		_ = hb(phase, pct)
	}
	rep, syncErr := bp.SyncBackfillRange(ctx, sess.UserID, opts, progress)

	unfinished := map[string]bool{}
	for kind, it := range byKind {
		if it.Status == storage.OnboardingSyncItemDone || it.Status == storage.OnboardingSyncItemGap {
			continue
		}
		unfinished[kind] = true
	}

	// Persist each channel's chunk outcome BEFORE classifying the error: a
	// failed run still keeps its durable checkpoint for the retry.
	type channelOutcome struct {
		item *storage.OnboardingSyncWorkItem
		rep  *provider.ChannelBackfillReport
		kind string
	}
	var outcomes []channelOutcome
	if it := byKind[kindActivities]; it != nil && rep.Activities != nil {
		outcomes = append(outcomes, channelOutcome{it, rep.Activities, kindActivities})
	}
	if it := byKind[kindHealth]; it != nil && rep.Health != nil {
		outcomes = append(outcomes, channelOutcome{it, rep.Health, kindHealth})
	}
	progressed := false
	for _, out := range outcomes {
		cp := parseChannelCheckpoint(out.item.Checkpoint)
		cp.Gaps = mergeRangeGaps(cp.Gaps, out.rep.GapEvents)
		cp.Fetches += out.rep.Fetches
		if out.rep.Done {
			// The channel's window is fully walked and reconciled: derive the
			// terminal outcome from the store's actual content.
			cred, gapText, isGap, err := deriveBackfillChannelTerminal(ctx, store, sess.UserID, prov.Info().Name, out.kind, provider.DayWindow{From: out.item.RangeFrom, To: out.item.RangeTo}, cp)
			if err != nil {
				return "", fmt.Errorf("onboardingrecent: derive %s terminal coverage: %w", out.kind, err)
			}
			status := storage.OnboardingSyncItemDone
			var msg *string
			if isGap {
				status = storage.OnboardingSyncItemGap
				msg = &gapText
			}
			if err := store.MarkOnboardingSyncWorkItem(ctx, out.item.ID, status, cred, msg); err != nil {
				return "", fmt.Errorf("onboardingrecent: record %s terminal outcome: %w", out.kind, err)
			}
			delete(unfinished, out.kind)
			progressed = true
			continue
		}
		cp.Cursor = out.rep.Checkpoint
		if out.rep.ScannedThrough != "" {
			cp.ScannedThrough = out.rep.ScannedThrough
		}
		if err := store.SaveOnboardingSyncWorkItemCheckpoint(ctx, out.item.ID, cp.marshal()); err != nil {
			return "", fmt.Errorf("onboardingrecent: save %s checkpoint: %w", out.kind, err)
		}
		if out.rep.Advanced {
			progressed = true
		}
	}

	if syncErr != nil {
		msg := syncErr.Error()
		for kind := range unfinished {
			if it := byKind[kind]; it != nil {
				_ = store.MarkOnboardingSyncWorkItem(ctx, it.ID, storage.OnboardingSyncItemFailed, "", &msg)
			}
		}
		return "", classifySyncError(syncErr)
	}
	if !progressed && len(unfinished) > 0 {
		// A chunk that neither advanced any channel nor completed one cannot
		// make progress by repeating — surface it instead of spinning
		// (devops#1010 AC4 不无限空转; the sweep's chunk bound is the backstop).
		return "", job.NewPermanentError("backfill_chunk_no_progress",
			fmt.Errorf("onboardingrecent: backfill chunk made no progress (stage %s session %s)", in.Stage, sess.SessionID))
	}
	if len(unfinished) > 0 {
		return backfillStageProgress(ctx, store, in.Stage, sess.UserID, byKind, unfinished)
	}

	items, err = store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, in.Stage)
	if err != nil {
		return "", err
	}
	return stageResultFromItems(in.Stage, items), nil
}

// mergeRangeGaps dedupes gap events by identity (a retried chunk can legally
// re-observe the same permanent rejection; the running record must not stack
// duplicates).
func mergeRangeGaps(running, chunk []provider.RangeGap) []provider.RangeGap {
	seen := map[string]bool{}
	for _, g := range running {
		seen[g.From+".."+g.To+"|"+g.Reason] = true
	}
	for _, g := range chunk {
		k := g.From + ".." + g.To + "|" + g.Reason
		if seen[k] {
			continue
		}
		seen[k] = true
		running = append(running, g)
	}
	return running
}

// deriveBackfillChannelTerminal reads the store for what the channel's window
// actually holds and derives the terminal credential + gap record: the
// observed window is the min/max stored day; target days without data are
// honest gaps (the vendor served nothing / every candidate was rejected); the
// checkpoint's accumulated per-item gap events are merged in. isGap reports
// whether the item is recorded as gap (unobtainable content) rather than done.
func deriveBackfillChannelTerminal(ctx context.Context, store backfillStore, userID, providerName, kind string, win provider.DayWindow, cp channelCheckpoint) (credential, gapText string, isGap bool, err error) {
	var days []string
	if kind == kindActivities {
		days, err = store.ActivityShanghaiDaysInRange(ctx, userID, win.From, win.To)
	} else {
		days, err = store.DailyHealthDaysInRange(ctx, userID, win.From, win.To)
	}
	if err != nil {
		return "", "", false, err
	}
	// The credential keeps the uniform range shape so stage aggregation can
	// read the observed window back out of it (observedFromCredential).
	obs := "-..-"
	if len(days) > 0 {
		obs = days[0] + ".." + days[len(days)-1]
	}
	credential = fmt.Sprintf("%s:v1:range:%s:%s..%s:obs=%s:n=%d", providerName, kind, win.From, win.To, obs, len(days))

	gaps := append([]provider.RangeGap{}, cp.Gaps...)
	emptyReason := "no activities at provider in range"
	if kind != kindActivities {
		emptyReason = "provider returned no health rows for range"
	}
	gaps = append(gaps, complementDayGaps(win, days, emptyReason)...)
	if len(gaps) == 0 {
		return credential, "", false, nil
	}
	sort.Slice(gaps, func(i, j int) bool { return gaps[i].From < gaps[j].From })
	var reasons []string
	seen := map[string]bool{}
	for _, g := range gaps {
		if g.Reason == "" || seen[g.Reason] {
			continue
		}
		seen[g.Reason] = true
		reasons = append(reasons, g.Reason)
	}
	if len(reasons) == 0 {
		reasons = append(reasons, "unobtainable at provider")
	}
	return credential, strings.Join(reasons, "; "), true, nil
}

// complementDayGaps returns the coalesced complement of `days` inside the
// window — the honestly-empty day ranges (the vendor served nothing there).
func complementDayGaps(win provider.DayWindow, days []string, reason string) []provider.RangeGap {
	if len(days) == 0 {
		return []provider.RangeGap{{From: win.From, To: win.To, Reason: reason}}
	}
	var out []provider.RangeGap
	if days[0] > win.From {
		out = append(out, provider.RangeGap{From: win.From, To: prevDayLabel(days[0]), Reason: reason})
	}
	for i := 1; i < len(days); i++ {
		if days[i] > nextDayLabel(days[i-1]) {
			out = append(out, provider.RangeGap{From: nextDayLabel(days[i-1]), To: prevDayLabel(days[i]), Reason: reason})
		}
	}
	if days[len(days)-1] < win.To {
		out = append(out, provider.RangeGap{From: nextDayLabel(days[len(days)-1]), To: win.To, Reason: reason})
	}
	return out
}

// prevDayLabel/nextDayLabel step one calendar day in the YYYY-MM-DD space.
func prevDayLabel(day string) string { return stepDayLabel(day, -1) }
func nextDayLabel(day string) string { return stepDayLabel(day, +1) }

func stepDayLabel(day string, delta int) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	return t.AddDate(0, 0, delta).Format("2006-01-02")
}

// backfillStageProgress builds the in_progress StageResult: scanned = the
// union of what the unfinished channels have walked (their checkpoint's scan
// depth up to the window top), observed = the store's actual data days inside
// the walked range, gaps = the accumulated gap events. The sweep keeps the
// coverage row running with this progress and arms the next chunk.
func backfillStageProgress(ctx context.Context, store backfillStore, stage, userID string, byKind map[string]*storage.OnboardingSyncWorkItem, unfinished map[string]bool) (string, error) {
	res := onboardingsync.StageResult{Stage: stage, Status: onboardingsync.StageStatusInProgress}
	for kind := range unfinished {
		it := byKind[kind]
		if it == nil {
			continue
		}
		cp := parseChannelCheckpoint(it.Checkpoint)
		// The walked prefix runs from the window top down to the checkpoint's
		// scan depth (ScannedThrough defaults to the window top before the
		// first chunk advances it).
		from, to := it.RangeFrom, it.RangeTo
		if cp.ScannedThrough != "" && cp.ScannedThrough > from {
			from = cp.ScannedThrough
		}
		if res.ScannedFrom == nil || from < *res.ScannedFrom {
			s := from
			res.ScannedFrom = &s
		}
		if res.ScannedTo == nil || to > *res.ScannedTo {
			s := to
			res.ScannedTo = &s
		}
		var days []string
		var err error
		if kind == kindActivities {
			days, err = store.ActivityShanghaiDaysInRange(ctx, userID, from, to)
		} else {
			days, err = store.DailyHealthDaysInRange(ctx, userID, from, to)
		}
		if err != nil {
			return "", err
		}
		if len(days) > 0 {
			if res.ObservedFrom == nil || days[0] < *res.ObservedFrom {
				s := days[0]
				res.ObservedFrom = &s
			}
			if res.ObservedTo == nil || days[len(days)-1] > *res.ObservedTo {
				s := days[len(days)-1]
				res.ObservedTo = &s
			}
		}
		for _, g := range cp.Gaps {
			res.Gaps = append(res.Gaps, onboardingsync.StageGap{From: g.From, To: g.To, Reason: kind + ": " + g.Reason})
		}
	}
	out, err := json.Marshal(res)
	if err != nil {
		return "{}", nil
	}
	return string(out), nil
}
