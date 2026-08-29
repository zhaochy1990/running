package api

import (
	"encoding/json"
	"sort"

	"github.com/zhaochy1990/stride/internal/compute/ability"
	"github.com/zhaochy1990/stride/internal/storage"
)

func isL3Key(dim string) bool {
	for _, k := range l3Keys {
		if dim == k {
			return true
		}
	}
	return false
}

// parseEvidence decodes a JSON array stored in evidence_activity_ids.
func parseEvidence(s *string) []string {
	if s == nil || *s == "" {
		return []string{}
	}
	var out []string
	if err := json.Unmarshal([]byte(*s), &out); err != nil {
		return []string{}
	}
	return out
}

func parseJSONMap(s *string) map[string]any {
	if s == nil || *s == "" {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(*s), &m); err != nil {
		return map[string]any{}
	}
	return m
}

// dateIsVersioned reports whether a date's rows carry the current model version.
func dateIsVersioned(rows []storage.AbilitySnapshot) bool {
	for _, r := range rows {
		if r.Level == "meta" && r.Dimension == "model_version" && r.Value != nil {
			return *r.Value == float64(ability.AbilityModelVersion)
		}
	}
	return false
}

// pivotSnapshotRows mirrors _pivot_snapshot_rows: long-form rows → API shape.
// Returns nil when the date has no current-model rows.
func pivotSnapshotRows(rows []storage.AbilitySnapshot, date string) map[string]any {
	dayRows := make([]storage.AbilitySnapshot, 0, len(rows))
	for _, r := range rows {
		if r.Date == date {
			dayRows = append(dayRows, r)
		}
	}
	if len(dayRows) == 0 {
		return nil
	}
	version := nextMetaVersion(dayRows)
	if version == nil || *version != float64(ability.AbilityModelVersion) {
		return nil
	}

	l3 := map[string]any{}
	for _, k := range l3Keys {
		l3[k] = map[string]any{"score": nil, "evidence": []string{}}
	}
	var l4Composite, l2Total *float64
	var marathonS, hmS map[string]int
	marathonS = map[string]int{"training_s": 0, "race_s": 0, "best_case_s": 0}
	hmS = map[string]int{"training_s": 0, "race_s": 0, "best_case_s": 0}
	var evidence []string

	for _, r := range dayRows {
		ev := parseEvidence(r.EvidenceActivityIDs)
		if r.Level == "L3" && isL3Key(r.Dimension) {
			l3[r.Dimension] = map[string]any{"score": r.Value, "evidence": ev}
		}
		if r.Level == "L4" && r.Dimension == "composite" {
			l4Composite = r.Value
		}
		if r.Level == "L2" && r.Dimension == "total" {
			l2Total = r.Value
		}
		switch r.Dimension {
		case "marathon_training_s":
			if r.Value != nil {
				marathonS["training_s"] = int(*r.Value)
			}
		case "marathon_race_s":
			if r.Value != nil {
				marathonS["race_s"] = int(*r.Value)
			}
		case "marathon_best_case_s":
			if r.Value != nil {
				marathonS["best_case_s"] = int(*r.Value)
			}
		case "hm_training_s":
			if r.Value != nil {
				hmS["training_s"] = int(*r.Value)
			}
		case "hm_race_s":
			if r.Value != nil {
				hmS["race_s"] = int(*r.Value)
			}
		case "hm_best_case_s":
			if r.Value != nil {
				hmS["best_case_s"] = int(*r.Value)
			}
		}
		evidence = append(evidence, ev...)
	}

	var l2 *any
	if l2Total != nil {
		v := any(*l2Total)
		l2 = &v
	} else {
		l2 = nil
	}

	var l4CompositeVal any
	if l4Composite != nil {
		l4CompositeVal = *l4Composite
	}

	raceS := nilOrNil(marathonS["race_s"])

	return map[string]any{
		"model_version":           ability.AbilityModelVersion,
		"date":                    date,
		"source":                  "snapshot",
		"l2_freshness":            map[string]any{"total": l2},
		"l3_dimensions":           l3,
		"l4_composite":            l4CompositeVal,
		"l4_marathon_estimate_s":  raceS,
		"distance_to_sub_2_50_s":  sub250(raceS),
		"marathon_estimates":      map[string]any{"training_s": marathonS["training_s"], "race_s": marathonS["race_s"], "best_case_s": marathonS["best_case_s"]},
		"half_marathon_estimates": map[string]any{"training_s": hmS["training_s"], "race_s": hmS["race_s"], "best_case_s": hmS["best_case_s"]},
		"evidence_activity_ids":   dedupeEvidence(evidence),
	}
}

// snapshotToResponse renders a live-computed Snapshot to the API shape (with full
// per-dimension details).
func snapshotToResponse(snap *ability.Snapshot) map[string]any {
	return map[string]any{
		"model_version": snap.ModelVersion,
		"date":          snap.Date,
		"source":        "computed",
		"l1_latest":     l1ToResponse(snap.L1Latest),
		"l2_freshness":  l2ToResponse(snap.L2Freshness),
		"l3_dimensions": map[string]any{
			"aerobic":   l3ToResponse(snap.L3Dimensions.Aerobic),
			"lt":        l3ToResponse(snap.L3Dimensions.LT),
			"vo2max":    l3ToResponse(snap.L3Dimensions.VO2Max),
			"endurance": l3ToResponse(snap.L3Dimensions.Endurance),
			"economy":   l3ToResponse(snap.L3Dimensions.Economy),
			"recovery":  l3ToResponse(snap.L3Dimensions.Recovery),
		},
		"l4_composite":            snap.L4Composite,
		"l4_marathon_estimate_s":  snap.L4MarathonEstimateS,
		"distance_to_sub_2_50_s":  snap.DistanceToSub250S,
		"marathon_estimates":      estimatesToResponse(snap.MarathonEstimates),
		"half_marathon_estimates": estimatesToResponse(snap.HalfMarathonEstimates),
		"evidence_activity_ids":   snap.EvidenceActivityIDs,
		"baseline_rhr":            snap.BaselineRHR,
	}
}

func l1ToResponse(l1 *ability.L1Result) any {
	if l1 == nil {
		return nil
	}
	b := l1.Breakdown
	return map[string]any{
		"total": l1.Total,
		"breakdown": map[string]any{
			"pace_adherence": b.PaceAdherence, "hr_zone_adherence": b.HRZoneAdherence,
			"pace_stability": b.PaceStability, "hr_decoupling": b.HRDecoupling,
			"cadence_stability": b.CadenceStability, "hr_decoupling_raw": b.HRDecouplingRaw,
			"target_hr_range": b.TargetHRRange,
		},
		"evidence": l1.Evidence,
	}
}

func l2ToResponse(l2 *ability.L2Result) any {
	if l2 == nil {
		return nil
	}
	b := l2.Breakdown
	return map[string]any{
		"total": l2.Total,
		"breakdown": map[string]any{
			"tsb_score": b.TSBScore, "rhr_score": b.RHRScore,
			"hrv_score": b.HRVScore, "fatigue_score": b.FatigueScore,
		},
		"tsb": l2.TSB,
	}
}

func l3ToResponse(s ability.L3Score) map[string]any {
	out := map[string]any{"score": s.Score, "evidence": s.Evidence}
	for k, v := range s.Details {
		out[k] = v
	}
	return out
}

func estimatesToResponse(e ability.MarathonEstimates) map[string]any {
	return map[string]any{
		"training_s":              e.TrainingS,
		"race_s":                  e.RaceS,
		"best_case_s":             e.BestCaseS,
		"race_day_boost_max":      e.RaceDayBoostMax,
		"best_case_boost_max":     e.BestCaseBoostMax,
		"race_day_boost_applied":  e.RaceDayBoostApplied,
		"best_case_boost_applied": e.BestCaseBoostApplied,
	}
}

// attachTargetStub adds the (null) goal-target payload — Go decouples race
// prediction/goal from the reading, so the target block is empty.
func attachTargetStub(m map[string]any) map[string]any {
	m["target_distance"] = nil
	m["target_s"] = nil
	m["target_label"] = nil
	m["distance_to_target_s"] = nil
	m["marathon_target_s"] = nil
	m["marathon_target_label"] = nil
	return m
}

func nextMetaVersion(rows []storage.AbilitySnapshot) *float64 {
	for _, r := range rows {
		if r.Level == "meta" && r.Dimension == "model_version" {
			return r.Value
		}
	}
	return nil
}

func nilOrNil(v int) any {
	if v == 0 {
		return nil
	}
	return v
}

func sub250(raceS any) any {
	r, ok := raceS.(int)
	if !ok || r == 0 {
		return nil
	}
	return r - 10200
}

func dedupeEvidence(ev []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range ev {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func sortDates(dates []string) {
	sort.Strings(dates)
}
