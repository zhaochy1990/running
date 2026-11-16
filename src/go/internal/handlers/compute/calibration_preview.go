package compute

import (
	"context"
	"github.com/zhaochy1990/stride/internal/compute/ability"
	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
	"math"
)

type CalibrationPreview struct {
	Selection       storage.CalibrationSelection      `json:"selection"`
	Inputs          []storage.CalibrationInput        `json:"inputs"`
	ActivityLoads   []trainingload.ActivityLoadResult `json:"activity_loads"`
	Ability         *ability.Snapshot                 `json:"ability"`
	UnavailableDays []string                          `json:"unavailable_days"`
	CandidateOnly   bool                              `json:"candidate_only"`
}

// PreviewCandidateCalibration accepts a read-only interface and returns only
// in-memory results. It cannot invoke any of the five unnamespaced writers.
func PreviewCandidateCalibration(ctx context.Context, r storage.CalibrationReader, user, day string, activities []trainingload.ActivityInput, source *ability.Source) (CalibrationPreview, error) {
	out := CalibrationPreview{CandidateOnly: true, Inputs: []storage.CalibrationInput{}, ActivityLoads: []trainingload.ActivityLoadResult{}, UnavailableDays: []string{}}
	ctx = storage.WithCalibrationCache(ctx)
	b, err := storage.ReadCachedRunningCalibration(ctx, r, user, day, storage.CalibrationCandidate)
	if err != nil {
		return out, err
	}
	out.Selection = b.Selection
	out.Inputs = append(out.Inputs, b.FrozenInput())
	for _, a := range activities {
		activityDay := timefmt.ShanghaiDayStr(a.ActivityDate)
		if activityDay > day {
			continue
		}
		history, err := storage.ReadCachedRunningCalibration(ctx, r, user, activityDay, storage.CalibrationCandidate)
		if err != nil {
			return out, err
		}
		if history.Snapshot == nil {
			out.UnavailableDays = append(out.UnavailableDays, activityDay)
			continue
		}
		out.Inputs = append(out.Inputs, history.FrozenInput())
		out.ActivityLoads = append(out.ActivityLoads, trainingload.ComputeActivityLoad(a, toTrainingLoadCalibration(history.Snapshot)))
	}
	if source != nil && b.Snapshot != nil && b.Snapshot.HRMaxEstimate != nil {
		copy := *source
		hr := int(math.Round(*b.Snapshot.HRMaxEstimate))
		copy.HRMax = &hr
		copy.RHRBaseline = b.Snapshot.RHRBaseline
		copy.ActivityHRMax = map[string]*int{}
		for _, a := range copy.Activities {
			if a.Date > day {
				continue
			}
			h, err := storage.ReadCachedRunningCalibration(ctx, r, user, a.Date, storage.CalibrationCandidate)
			if err != nil {
				return out, err
			}
			if h.Snapshot != nil && h.Snapshot.HRMaxEstimate != nil {
				v := int(math.Round(*h.Snapshot.HRMaxEstimate))
				copy.ActivityHRMax[a.LabelID] = &v
			}
		}
		out.Ability = ability.ComputeAbilitySnapshot(&copy, day, nil)
	}
	return out, nil
}
