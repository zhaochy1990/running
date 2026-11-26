package onboardingsync

import (
	"encoding/json"
	"time"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// CoverageGaps reads typed gaps and classifies previously recorded reasons.
func CoverageGaps(cov *storage.OnboardingSyncStageCoverage) []StageGap {
	if cov.GapsJSON == nil {
		return nil
	}
	var gaps []StageGap
	if json.Unmarshal([]byte(*cov.GapsJSON), &gaps) != nil {
		return nil
	}
	for i := range gaps {
		gaps[i] = gaps[i].Classified()
	}
	return gaps
}

// CoverageStatus projects old and new coverage rows using the same gap rules.
func CoverageStatus(cov *storage.OnboardingSyncStageCoverage) string {
	return terminalCoverageStatus(cov.Status, CoverageGaps(cov))
}

func terminalCoverageStatus(status string, gaps []StageGap) string {
	if status == storage.OnboardingSyncCoverageCompletedWithGaps && len(gaps) > 0 && !provider.HasBlockingRangeGaps(gaps) {
		return storage.OnboardingSyncCoverageCompleted
	}
	return status
}

func effectiveCoverageStatuses(covs []*storage.OnboardingSyncStageCoverage) map[string]string {
	statuses := make(map[string]string, len(covs))
	for _, cov := range covs {
		statuses[cov.Stage] = CoverageStatus(cov)
	}
	// Older analysis jobs inherited the raw gap flag without copying the
	// reasons. Apply the same correction if the raw gaps were all expected.
	if statuses[storage.OnboardingSyncStageRecentRaw] == storage.OnboardingSyncCoverageCompleted {
		for _, cov := range covs {
			if cov.Stage == storage.OnboardingSyncStageRecentAnalysis && cov.Status == storage.OnboardingSyncCoverageCompletedWithGaps && cov.GapsJSON == nil {
				statuses[cov.Stage] = storage.OnboardingSyncCoverageCompleted
			}
		}
	}
	return statuses
}

// legacyHealthLookback recovers a COROS history notice only when the work
// item proves the gap ends immediately before its oldest observed day.
func legacyHealthLookback(gap StageGap, stage, anchor string, items []*storage.OnboardingSyncWorkItem) int {
	if gap.Kind != provider.RangeGapEmpty || gap.Channel != storage.OnboardingSyncItemKindHealth {
		return 0
	}
	gapEnd, err := time.Parse(time.DateOnly, gap.To)
	if err != nil {
		return 0
	}
	wantFrom := gapEnd.AddDate(0, 0, 1).Format(time.DateOnly)
	from, latest := "", ""
	for _, item := range items {
		if item.Kind != storage.OnboardingSyncItemKindHealth || item.FetchCredential == nil {
			continue
		}
		obsFrom, obsTo, ok := provider.RangeCredentialObservedWindow(*item.FetchCredential)
		if !ok {
			continue
		}
		latest = max(latest, obsTo)
		if item.Stage == stage && item.RangeFrom == gap.From && obsFrom == wantFrom {
			from = obsFrom
		}
	}
	return provider.HealthLookbackDays(from, latest, anchor)
}

// workItemGapViews projects current attempts and preserves terminal refusal
// evidence across finalization by an older worker.
// The worker clears the failure when that item finishes, so a prior attempt
// can never become a permanent entry in the stage coverage row.
func workItemGapViews(items []*storage.OnboardingSyncWorkItem) (attempts, terminal map[string][]StageGap) {
	attempts, terminal = make(map[string][]StageGap), make(map[string][]StageGap)
	for _, item := range items {
		if item.Status != storage.OnboardingSyncItemPending && item.Status != storage.OnboardingSyncItemFailed && item.Status != storage.OnboardingSyncItemGap {
			continue
		}
		details := item.RecordedRangeGaps()
		if details == nil {
			continue
		}
		var gaps []StageGap
		if json.Unmarshal([]byte(*details), &gaps) != nil {
			continue
		}
		for _, gap := range gaps {
			gap.Channel = item.Kind
			if item.Status == storage.OnboardingSyncItemGap {
				if gap.Kind == provider.RangeGapUnavailable {
					terminal[item.Stage] = append(terminal[item.Stage], gap)
				}
			} else if gap.Kind == provider.RangeGapTransient || gap.Kind == provider.RangeGapUnavailable {
				attempts[item.Stage] = append(attempts[item.Stage], gap)
			}
		}
	}
	return attempts, terminal
}
