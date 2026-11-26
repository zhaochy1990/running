package onboardinganalysis

import (
	"context"
	"encoding/json"
	"time"

	"github.com/zhaochy1990/stride/internal/onboardingsync"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// A later watch sync can add an activity after the raw scan reported an
// empty day. Reconcile those days against real activity rows when the analysis
// refreshes, including a same-day refresh. Permanent gaps stay independent of
// the presence of any other activity on their date.
func refreshActivityGaps(ctx context.Context, store Store, sess *storage.OnboardingSyncSession, cov *storage.OnboardingSyncStageCoverage) error {
	if cov == nil || cov.ScannedFrom == nil || cov.ScannedTo == nil {
		return nil
	}
	gaps := onboardingsync.CoverageGaps(cov)
	var from, to string
	for _, gap := range gaps {
		if gap.Kind != provider.RangeGapEmpty || gap.Channel != storage.OnboardingSyncItemKindActivities {
			continue
		}
		if from == "" || gap.From < from {
			from = gap.From
		}
		if gap.To > to {
			to = gap.To
		}
	}
	start, startErr := time.Parse(time.DateOnly, from)
	end, endErr := time.Parse(time.DateOnly, to)
	if startErr != nil || endErr != nil {
		return nil
	}
	acts, err := store.ActivitiesInWindow(ctx, sess.UserID, sess.Provider, start, end)
	if err != nil {
		return err
	}
	var remaining []onboardingsync.StageGap
	changed := false
	for _, gap := range gaps {
		if gap.Kind == provider.RangeGapEmpty && gap.Channel == storage.OnboardingSyncItemKindActivities {
			for _, act := range acts {
				day := timefmt.ShanghaiDay(act.Date)
				label := day.Format(time.DateOnly)
				if label < gap.From || label > gap.To {
					continue
				}
				changed = true
				if label > gap.From {
					prefix := gap
					prefix.To = day.AddDate(0, 0, -1).Format(time.DateOnly)
					remaining = append(remaining, prefix)
				}
				gap.From = day.AddDate(0, 0, 1).Format(time.DateOnly)
				if cov.ObservedFrom == nil || label < *cov.ObservedFrom {
					cov.ObservedFrom = &label
				}
				if cov.ObservedTo == nil || label > *cov.ObservedTo {
					cov.ObservedTo = &label
				}
			}
		}
		if gap.From <= gap.To {
			remaining = append(remaining, gap)
		}
	}
	if !changed {
		return nil
	}
	cov.Status = onboardingsync.CoverageStatus(cov)
	cov.GapsJSON = nil
	if len(remaining) > 0 {
		data, _ := json.Marshal(remaining)
		encoded := string(data)
		cov.GapsJSON = &encoded
	}
	return store.UpdateOnboardingSyncStageCoverage(ctx, cov)
}
